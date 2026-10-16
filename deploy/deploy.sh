#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
root_dir=$(dirname -- "$script_dir")
state_dir=${DEPLOY_STATE_DIR:-"$root_dir/state"}
runtime_env=${RUNTIME_ENV_FILE:-"$root_dir/runtime.env"}
image_ref=${1:-}

error() { printf 'Deploy: %s\n' "$1" >&2; exit 1; }
valid_image() { [[ $1 =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+:[0-9a-f]{40}$ ]] && [[ $1 != *..* ]]; }
valid_image "$image_ref" || error 'IMAGE_REF must be registry/name:40-character lowercase SHA'
[[ $# -eq 1 ]] || error 'Expected exactly one IMAGE_REF'
[[ $state_dir == /* && $runtime_env == /* && $state_dir != *[$'\001'-$'\037']* && $runtime_env != *[$'\001'-$'\037']* ]] || error 'Invalid remote configuration path'
[[ -f $script_dir/compose.yml ]] || error 'Missing compose.yml'
[[ -f $script_dir/smoke.mjs ]] || error 'Missing smoke.mjs'
[[ -f $runtime_env ]] || error 'Missing RUNTIME_ENV_FILE'
if [[ -z ${HOST_PORT:-} ]]; then
  HOST_PORT=$(sed -n 's/^HOST_PORT=//p' "$runtime_env" | head -n 1)
fi
if ! [[ ${HOST_PORT:-} =~ ^[0-9]{1,5}$ ]] || ! (( HOST_PORT > 0 && HOST_PORT <= 65535 )); then
  error 'Invalid HOST_PORT'
fi
health_timeout=${DEPLOY_HEALTH_TIMEOUT:-60}
poll_interval=${DEPLOY_POLL_INTERVAL:-1}
if ! [[ $health_timeout =~ ^[1-9][0-9]?$ ]] || ! (( health_timeout <= 60 )); then
  error 'DEPLOY_HEALTH_TIMEOUT must be 1..60 seconds'
fi
[[ $poll_interval =~ ^(0\.[0-9]+|[1-9][0-9]*(\.[0-9]+)?)$ ]] || error 'Invalid DEPLOY_POLL_INTERVAL'

if [[ -n ${DEPLOY_BASE_URL:-} ]]; then
  base_url=$DEPLOY_BASE_URL
else
  origins=$(sed -n 's/^ALLOWED_ORIGINS=//p' "$runtime_env" | head -n 1)
  origin=${origins%%,*}
  origin=${origin#"${origin%%[![:space:]]*}"}
  origin=${origin%"${origin##*[![:space:]]}"}
  [[ $origin =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || error 'Invalid first ALLOWED_ORIGINS entry'
  base_url=$origin/date-run/
fi
[[ $base_url =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/date-run/$ ]] || error 'Invalid DEPLOY_BASE_URL'

mkdir -p -- "$state_dir"
command -v flock >/dev/null || error 'Missing flock (util-linux)'
lock_file=$state_dir/deploy.lock
[[ ! -d $lock_file ]] || error 'Legacy lock directory exists; confirm no deployment is running before removing it'
exec {lock_fd}>>"$lock_file"
flock -n "$lock_fd" || error 'Another deployment holds the lock'
health_pid=
service_mutated=0
state_temps=()
cleanup() {
  local temporary
  if [[ -n $health_pid ]]; then kill "$health_pid" 2>/dev/null || true; wait "$health_pid" 2>/dev/null || true; fi
  for temporary in "${state_temps[@]}"; do rm -f -- "$temporary" || printf 'Deploy: could not remove temporary state file\n' >&2; done
}
trap cleanup EXIT

abort_on_signal() {
  local signal=$1 code=$2
  trap '' INT TERM HUP
  if [[ -n $health_pid ]]; then
    kill "$health_pid" 2>/dev/null || true
    wait "$health_pid" 2>/dev/null || true
    health_pid=
  fi
  if [[ $service_mutated == 1 ]]; then
    printf 'Deploy: %s interrupted deployment; rolling back\n' "$signal" >&2
    rollback || printf 'Deploy: rollback failed after %s\n' "$signal" >&2
    restore_state || printf 'Deploy: state recovery failed after %s\n' "$signal" >&2
  fi
  exit "$code"
}
trap 'abort_on_signal INT 130' INT
trap 'abort_on_signal TERM 143' TERM
trap 'abort_on_signal HUP 129' HUP

current=
if [[ -f $state_dir/current-image ]]; then
  IFS= read -r current < "$state_dir/current-image" || true
  valid_image "$current" || error 'Invalid current-image state'
fi
prior_existed=0
prior=
if [[ -f $state_dir/previous-image ]]; then
  prior_existed=1
  IFS= read -r prior < "$state_dir/previous-image" || true
fi
revision=${image_ref##*:}
label=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image_ref") || error 'Candidate image unavailable'
[[ $label == "$revision" ]] || error 'Candidate image revision does not match tag'
if [[ -n $current ]]; then
  docker image inspect "$current" >/dev/null || error 'Previous image unavailable'
fi

export IMAGE_REF="$image_ref" RUNTIME_ENV_FILE="$runtime_env" HOST_PORT
compose=(docker compose --project-name date-run --file "$script_dir/compose.yml")
smoke() {
  "${compose[@]}" exec -T app node --input-type=module - "$base_url" "${IMAGE_REF##*:}" < "$script_dir/smoke.mjs"
}
wait_ready() {
  local deadline_ns=$(( $(date +%s%N) + health_timeout * 1000000000 ))
  local remaining_ns remaining
  while :; do
    remaining_ns=$(( deadline_ns - $(date +%s%N) ))
    (( remaining_ns > 0 )) || return 1
    printf -v remaining '%d.%09d' "$((remaining_ns / 1000000000))" "$((remaining_ns % 1000000000))"
    timeout --signal=TERM --kill-after=0.1s "$remaining" "${compose[@]}" exec -T app node -e 'fetch("http://127.0.0.1:3000/date-run/health/ready", {headers:{"X-Real-IP":"127.0.0.1"},signal:AbortSignal.timeout(4000)}).then(async r=>{const body=await r.json();if(!r.ok||body.status!=="ok"||body.revision!==process.env.APP_REVISION)process.exitCode=1}).catch(()=>{process.exitCode=1})' & health_pid=$!
    if wait "$health_pid"; then health_pid=; return 0; fi
    health_pid=
    remaining_ns=$(( deadline_ns - $(date +%s%N) ))
    (( remaining_ns > 0 )) || return 1
    printf -v remaining '%d.%09d' "$((remaining_ns / 1000000000))" "$((remaining_ns % 1000000000))"
    timeout "$remaining" sleep "$poll_interval" || return 1
  done
}
rollback() {
  if [[ -z $current ]]; then
    "${compose[@]}" down || printf 'Deploy: failed to stop first release\n' >&2
    return
  fi
  export IMAGE_REF="$current"
  if ! "${compose[@]}" up -d --force-recreate app; then
    printf 'Deploy: rollback failed to start previous image\n' >&2
    return 1
  fi
  if ! wait_ready || ! smoke; then
    printf 'Deploy: rollback health or smoke failed\n' >&2
    return 1
  fi
  printf 'Deploy: rollback restored previous image\n' >&2
}

write_state() {
  local name=$1 value=$2 temporary
  temporary=$(mktemp "$state_dir/.$name.XXXXXX") || return 1
  state_temps+=("$temporary")
  printf '%s\n' "$value" > "$temporary" || return 1
  mv -- "$temporary" "$state_dir/$name"
}
restore_state() {
  local failed=0 actual
  if [[ -n $current ]]; then
    actual=
    if [[ -f $state_dir/current-image ]]; then IFS= read -r actual < "$state_dir/current-image" || true; fi
    if [[ $actual != "$current" ]]; then write_state current-image "$current" || failed=1; fi
  elif [[ -e $state_dir/current-image ]]; then
    rm -- "$state_dir/current-image" || failed=1
  fi
  if [[ $prior_existed == 1 ]]; then
    actual=
    if [[ -f $state_dir/previous-image ]]; then IFS= read -r actual < "$state_dir/previous-image" || true; fi
    if [[ $actual != "$prior" ]]; then write_state previous-image "$prior" || failed=1; fi
  elif [[ -e $state_dir/previous-image ]]; then
    rm -- "$state_dir/previous-image" || failed=1
  fi
  if (( failed )); then printf 'Deploy: failed to restore previous state\n' >&2; return 1; fi
}
start_candidate() {
  if [[ -n $current ]]; then "${compose[@]}" stop app || return 1; fi
  "${compose[@]}" up -d --force-recreate app
}
service_mutated=1
if ! start_candidate || ! wait_ready || ! smoke; then
  printf 'Deploy: candidate startup, health or smoke failed; rolling back\n' >&2
  rollback || printf 'Deploy: rollback failed\n' >&2
  restore_state || printf 'Deploy: state recovery failed\n' >&2
  exit 1
fi

commit_state() {
  write_state current-image "$image_ref" || return 1
  if [[ -n $current ]]; then write_state previous-image "$current" || return 1; fi
}
if ! commit_state; then
  printf 'Deploy: could not commit state; rolling back\n' >&2
  rollback || printf 'Deploy: rollback failed\n' >&2
  restore_state || printf 'Deploy: state recovery failed\n' >&2
  exit 1
fi
service_mutated=0
printf 'Deploy: revision %s healthy\n' "$revision"
