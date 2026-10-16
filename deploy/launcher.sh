#!/usr/bin/env bash
set -euo pipefail

error() { printf 'Launcher: %s\n' "$1" >&2; exit 1; }
for name in REPO_DIR SSH_ALIAS REMOTE_DIR IMAGE_NAME; do
  [[ -n ${!name:-} ]] || error "Missing $name"
done
[[ $SSH_ALIAS =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || error 'Invalid SSH_ALIAS'
[[ $REMOTE_DIR == /* && $REMOTE_DIR != *[$'\001'-$'\037']* && $REMOTE_DIR != *[$'\177']* ]] || error 'Invalid REMOTE_DIR'
[[ $IMAGE_NAME =~ ^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)+$ && $IMAGE_NAME != *..* ]] || error 'Invalid IMAGE_NAME'
[[ $REPO_DIR != *[$'\001'-$'\037']* && $REPO_DIR != *[$'\177']* ]] || error 'Invalid REPO_DIR'
[[ -d $REPO_DIR ]] || error 'REPO_DIR does not exist'
[[ -f $REPO_DIR/Dockerfile && -f $REPO_DIR/deploy/deploy.sh && -f $REPO_DIR/deploy/compose.yml && -f $REPO_DIR/deploy/smoke.mjs ]] || error 'REPO_DIR is missing deployment files'

revision=$(cd -- "$REPO_DIR" && git rev-parse HEAD) || error 'Repository has no HEAD'
[[ $revision =~ ^[0-9a-f]{40}$ ]] || error 'HEAD is not a 40-character SHA'
status=$(cd -- "$REPO_DIR" && git status --porcelain) || error 'Could not inspect repository status'
[[ -z $status ]] || error 'Repository is dirty'
image_ref=$IMAGE_NAME:$revision

work=$(mktemp -d)
remote_created=0
cleanup() {
  local result=$?
  trap - EXIT
  if [[ $remote_created == 1 ]] && ! ssh -- "$SSH_ALIAS" "rm -rf -- $quoted_incoming"; then
    printf 'Launcher: failed to clean incoming directory\n' >&2
    result=1
  fi
  if ! rm -rf -- "$work"; then
    printf 'Launcher: failed to clean local archive\n' >&2
    result=1
  fi
  exit "$result"
}
trap cleanup EXIT
archive=$work/image.tar
bundle=$work/bundle.tar
local_docker=(docker)
if [[ -n ${DOCKER_CONTEXT:-} ]]; then
  [[ $DOCKER_CONTEXT != -* && $DOCKER_CONTEXT != *[$'\001'-$'\037']* ]] || error 'Invalid DOCKER_CONTEXT'
  local_docker+=(--context "$DOCKER_CONTEXT")
fi
"${local_docker[@]}" build --build-arg "APP_REVISION=$revision" --tag "$image_ref" -- "$REPO_DIR"
"${local_docker[@]}" save "$image_ref" > "$archive"
tar -cf "$bundle" -C "$REPO_DIR" deploy/deploy.sh deploy/compose.yml deploy/smoke.mjs -C "$work" image.tar

quote() {
  local value=$1
  printf "'%s'" "${value//\'/\'\\\'\'}"
}
incoming=$REMOTE_DIR/.incoming-date-run-$revision-$RANDOM-$RANDOM
quoted_incoming=$(quote "$incoming")
quoted_remote=$(quote "$REMOTE_DIR")
quoted_image=$(quote "$image_ref")
quoted_cleanup=$(quote "rm -rf -- $quoted_incoming")
base_override=
if [[ -n ${DEPLOY_BASE_URL:-} ]]; then base_override="DEPLOY_BASE_URL=$(quote "$DEPLOY_BASE_URL") "; fi
ssh -- "$SSH_ALIAS" "mkdir -m 700 -- $quoted_incoming"
remote_created=1
scp -- "$bundle" "$SSH_ALIAS:$incoming/bundle.tar"
ssh -- "$SSH_ALIAS" "set -eu; trap $quoted_cleanup EXIT; tar -xf $quoted_incoming/bundle.tar -C $quoted_incoming; docker load -i $quoted_incoming/image.tar; ${base_override}IMAGE_REF=$quoted_image DEPLOY_STATE_DIR=$quoted_remote/state RUNTIME_ENV_FILE=$quoted_remote/runtime.env bash $quoted_incoming/deploy/deploy.sh $quoted_image; rm -rf -- $quoted_incoming; trap - EXIT"
remote_created=0
