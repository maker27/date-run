import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const deploy = resolve(root, 'deploy/deploy.sh');
const fixtures: string[] = [];
const good = `registry.example/date-run:${'a'.repeat(40)}`;
const bad = `registry.example/date-run:${'b'.repeat(40)}`;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('remote deployment contract', () => {
  it('rejects unsafe image references without touching state', async () => {
    const fixture = await makeRemote();
    for (const image of ['--help', 'registry/name:latest', 'registry/name:abc\nother']) {
      const result = await invoke(fixture, image);
      expect(result.code).not.toBe(0);
      expect(await readState(fixture)).toEqual({});
    }
  });

  it('commits current image only after readiness and revision smoke pass', async () => {
    const fixture = await makeRemote({ readiness: 'ready', smoke: 'ok' });
    const result = await invoke(fixture, good);
    expect(result.code, result.stderr).toBe(0);
    expect(await readState(fixture)).toMatchObject({ 'current-image': good });
    expect(await readFile(join(fixture.state, 'previous-image'), 'utf8').catch(() => '')).toBe('');
  });

  it('restores the previous image when the candidate fails and preserves foreign files', async () => {
    const fixture = await makeRemote({ readiness: 'ready', smoke: 'fail', current: good });
    const foreign = join(fixture.state, 'operator-notes.txt');
    await writeFile(foreign, 'keep this');
    const result = await invoke(fixture, bad);
    expect(result.code).not.toBe(0);
    expect((await readState(fixture))['current-image']).toBe(good);
    expect(await readFile(foreign, 'utf8')).toBe('keep this');
    expect((await readEvents(fixture.log)).some((args) => args.some((arg) => arg.includes(good)))).toBe(true);
  });

  it('leaves first-release state empty when the candidate fails', async () => {
    const fixture = await makeRemote({ readiness: 'fail', smoke: 'ok' });
    const result = await invoke(fixture, good);
    expect(result.code).not.toBe(0);
    expect(await readState(fixture)).toEqual({});
  });

  it('restores the running image when stop fails after stopping the container', async () => {
    const older = `registry.example/date-run:${'c'.repeat(40)}`;
    const fixture = await makeRemote({ current: good, prior: older, stopFails: true });
    const result = await invoke(fixture, bad);
    expect(result.code).not.toBe(0);
    expect((await readDockerState(fixture)).running).toBe(good);
    expect(await readState(fixture)).toEqual({ 'current-image': good, 'previous-image': older });
  });

  it('allows another deployment after the lock owner is killed without cleanup', async () => {
    const fixture = await makeRemote({ readiness: 'hold', current: good });
    const first = start(fixture, bad);
    try {
      await waitFor(async () => {
        const events = await readEvents(fixture.log);
        if (!events.some((args) => args.includes('exec'))) throw new Error('Not probing yet');
      });
    } finally {
      if (first.pid !== undefined) process.kill(-first.pid, 'SIGKILL');
      await first.done;
    }
    fixture.env.DOCKER_READINESS = 'ready';
    const next = await invoke(fixture, bad);
    expect(next.code, next.stderr).toBe(0);
    expect((await readState(fixture))['current-image']).toBe(bad);
  });

  it('preserves a legacy lock directory until an operator confirms it is unused', async () => {
    const fixture = await makeRemote();
    const legacy = join(fixture.state, 'deploy.lock');
    await mkdir(legacy);
    await writeFile(join(legacy, 'operator-note'), 'keep this');
    const result = await invoke(fixture, good);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Legacy lock directory');
    expect(await readFile(join(legacy, 'operator-note'), 'utf8')).toBe('keep this');
    expect(await readState(fixture)).toEqual({});
  });

  it('rejects a candidate whose image revision differs from its immutable tag before stopping current', async () => {
    const fixture = await makeRemote({ current: good, imageRevision: 'e'.repeat(40) });
    const result = await invoke(fixture, bad);
    expect(result.code).not.toBe(0);
    expect((await readState(fixture))['current-image']).toBe(good);
    const events = await readEvents(fixture.log);
    expect(events.some((args) => args.includes('stop'))).toBe(false);
  });

  it('checks that the previous image is available before stopping the running service', async () => {
    const fixture = await makeRemote({ current: good, previousAvailable: false });
    const result = await invoke(fixture, bad);
    expect(result.code).not.toBe(0);
    expect((await readState(fixture))['current-image']).toBe(good);
    const events = await readEvents(fixture.log);
    expect(events.some((args) => args.includes('stop'))).toBe(false);
  });

  it('reports rollback health failure while retaining the previous image as the attempted restore', async () => {
    const fixture = await makeRemote({ current: good, smoke: 'fail', rollbackHealth: 'fail' });
    const result = await invoke(fixture, bad);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/rollback/i);
    expect((await readState(fixture))['current-image']).toBe(good);
    expect((await readDockerState(fixture)).running).toBe(good);
  });

  it('rolls back on TERM after candidate startup and preserves both image state files', async () => {
    const older = `registry.example/date-run:${'c'.repeat(40)}`;
    const fixture = await makeRemote({ readiness: 'hold', current: good, prior: older });
    const first = start(fixture, bad);
    await waitFor(async () => {
      const events = await readEvents(fixture.log);
      const started = events.some((args) => args.includes('up') && args.includes('-d'));
      const probing = events.some((args) => args.join(' ').includes('health') || args.join(' ').includes('ready'));
      if (!started || !probing) throw new Error('Candidate is not running under readiness polling');
    });
    expect((await readDockerState(fixture)).running).toBe(bad);

    first.child.kill('SIGTERM');
    const interrupted = await first.done;
    const stateAfterSignal = await readState(fixture);
    const runningAfterSignal = (await readDockerState(fixture)).running;
    fixture.env.DOCKER_READINESS = 'ready';
    const nextDeploy = await invoke(fixture, bad);
    expect.soft(interrupted.code).not.toBe(0);
    expect.soft(stateAfterSignal).toEqual({ 'current-image': good, 'previous-image': older });
    expect.soft(nextDeploy.code, nextDeploy.stderr).toBe(0);
    expect.soft(runningAfterSignal).toBe(good);
  });

  it('preserves previous-image when current-image commit rename fails and restores the running image', async () => {
    const older = `registry.example/date-run:${'c'.repeat(40)}`;
    const fixture = await makeRemote({ current: good, prior: older, failCurrentRenameFor: bad });
    const result = await invoke(fixture, bad);
    const marker = await readFile(fixture.mvFailureMarker, 'utf8');
    const stateAfterFailure = await readState(fixture);
    const runningAfterFailure = (await readDockerState(fixture)).running;
    const unfinishedStateFiles = (await readdir(fixture.state)).filter((name) => name.startsWith('.current-image.') || name.startsWith('.previous-image.'));
    expect.soft(result.code).not.toBe(0);
    expect.soft(marker).toBe('injected');
    expect.soft(stateAfterFailure).toEqual({ 'current-image': good, 'previous-image': older });
    expect.soft(runningAfterFailure).toBe(good);
    expect.soft(unfinishedStateFiles).toEqual([]);
  });

  it('rejects a concurrent deploy while retaining the lock owner', async () => {
    const fixture = await makeRemote({ readiness: 'hold', smoke: 'ok' });
    const first = start(fixture, good);
    await waitFor(async () => {
      const events = await readEvents(fixture.log);
      if (!events.some((args) => args.join(' ').includes('health') || args.join(' ').includes('ready'))) {
        throw new Error('Remote deploy has not reached readiness');
      }
    });
    const second = await invoke(fixture, bad);
    expect(second.code).not.toBe(0);
    first.child.kill('SIGTERM');
    const result = await first.done;
    expect(second.stderr).toContain('Another deployment holds the lock');
    expect(result.code).not.toBe(0);
    expect(await readFile(join(fixture.state, 'unrelated.txt'), 'utf8')).toBe('preserve');
    fixture.env.DOCKER_READINESS = 'ready';
    expect((await invoke(fixture, bad)).code).toBe(0);
  });
});

type Remote = { root: string; state: string; log: string; dockerState: string; script: string; mvFailureMarker: string; env: NodeJS.ProcessEnv };
type RunResult = { code: number; stdout: string; stderr: string };

async function makeRemote(options: { readiness?: string; smoke?: string; current?: string; prior?: string; imageRevision?: string; previousAvailable?: boolean; rollbackHealth?: string; failCurrentRenameFor?: string; stopFails?: boolean } = {}): Promise<Remote> {
  const base = await mkdtemp(join(tmpdir(), 'date-run remote '));
  fixtures.push(base);
  const bin = join(base, 'bin');
  const state = join(base, 'state');
  await mkdir(bin);
  await mkdir(state);
  const log = join(base, 'commands.log');
  await writeFile(join(state, 'unrelated.txt'), 'preserve');
  if (options.current) await writeFile(join(state, 'current-image'), `${options.current}\n`);
  if (options.prior) await writeFile(join(state, 'previous-image'), `${options.prior}\n`);
  const fakeDocker = join(bin, 'docker');
  const fakeDockerModule = join(base, 'fake-docker.mjs');
  await writeFile(fakeDockerModule, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
let state = { running: process.env.DOCKER_INITIAL ?? '' };
try { state = JSON.parse(readFileSync(process.env.DOCKER_STATE, 'utf8')); } catch {}
const save = () => writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
const joined = args.join(' ');
const image = args.find((arg) => arg.includes(':') && /:[a-f0-9]{40}$/.test(arg));
if (joined.includes('inspect') && joined.includes('org.opencontainers.image.revision')) process.stdout.write(args.some((arg) => arg.endsWith(':${'a'.repeat(40)}')) ? process.env.DOCKER_REVISION_A : process.env.DOCKER_REVISION_B);
else if (joined.includes('image inspect') && image && image === process.env.DOCKER_PREVIOUS && process.env.DOCKER_PREVIOUS_AVAILABLE === 'false') process.exit(1);
else if (joined.includes('ps') && joined.includes('--filter')) process.stdout.write(state.running ? '1\\n' : '');
else if (joined.includes('stop')) { state.running = ''; save(); if (process.env.DOCKER_STOP_FAILS === 'true') process.exit(1); }
else if (joined.includes('up') && args.includes('-d')) { state.running = process.env.IMAGE_REF ?? image ?? state.running; save(); }
else if (joined.includes('down')) { state.running = ''; save(); }
else if (joined.includes('health') || joined.includes('ready')) {
  const status = state.running === process.env.DOCKER_PREVIOUS ? process.env.DOCKER_ROLLBACK_HEALTH : process.env.DOCKER_READINESS;
  if (status === 'hold') await new Promise((resolve) => setTimeout(resolve, 30_000));
  process.exit(status === 'ready' ? 0 : 1);
}
else if (args.includes('exec') && process.env.DOCKER_SMOKE) process.exit(state.running === process.env.DOCKER_PREVIOUS ? 0 : process.env.DOCKER_SMOKE === 'ok' ? 0 : 1);
`);
  await writeFile(fakeDocker, `#!/bin/sh\nexec node "$FAKE_DOCKER_MODULE" "$@"\n`);
  await chmod(fakeDocker, 0o755);
  const fakeMv = join(bin, 'mv');
  await writeFile(fakeMv, `#!/bin/sh
previous=
last=
for argument do previous=$last; last=$argument; done
if [ "$last" = "$MV_FAIL_TARGET" ] && [ -n "$MV_FAIL_CANDIDATE" ] && [ ! -e "$MV_FAIL_MARKER" ] && grep -F -x -- "$MV_FAIL_CANDIDATE" "$previous" >/dev/null; then
  printf 'injected' > "$MV_FAIL_MARKER"
  exit 1
fi
exec /bin/mv "$@"
`);
  await chmod(fakeMv, 0o755);
  const remoteRoot = join(base, 'remote with spaces');
  await mkdir(remoteRoot);
  const remoteDeploy = join(remoteRoot, 'deploy');
  await mkdir(remoteDeploy);
  const script = join(remoteDeploy, 'deploy.sh');
  await copyFile(deploy, script).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  });
  await copyFile(resolve(root, 'deploy/compose.yml'), join(remoteDeploy, 'compose.yml'));
  await copyFile(resolve(root, 'deploy/smoke.mjs'), join(remoteDeploy, 'smoke.mjs')).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  });
  await writeFile(join(remoteRoot, 'runtime.env'), 'ALLOWED_ORIGINS=https://example.test\nHOST_PORT=18080\n');
  return {
    root: remoteRoot,
    state,
    log,
    dockerState: join(base, 'docker-state.json'),
    script,
    mvFailureMarker: join(base, 'mv-current-image-failed'),
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      DOCKER_LOG: log,
      FAKE_DOCKER_MODULE: fakeDockerModule,
      DOCKER_STATE: join(base, 'docker-state.json'),
      DOCKER_READINESS: options.readiness ?? 'ready',
      DOCKER_STOP_FAILS: String(options.stopFails ?? false),
      DOCKER_SMOKE: options.smoke ?? 'ok',
      DOCKER_INITIAL: options.current ?? '',
      IMAGE_REF: '',
      DOCKER_PREVIOUS: options.current ?? '',
      DOCKER_PREVIOUS_AVAILABLE: String(options.previousAvailable ?? true),
      DOCKER_ROLLBACK_HEALTH: options.rollbackHealth ?? 'ready',
      DOCKER_REVISION_A: `${options.imageRevision ?? 'a'.repeat(40)}\n`,
      DOCKER_REVISION_B: `${options.imageRevision ?? 'b'.repeat(40)}\n`,
      MV_FAIL_TARGET: join(state, 'current-image'),
      MV_FAIL_CANDIDATE: options.failCurrentRenameFor ?? '',
      MV_FAIL_MARKER: join(base, 'mv-current-image-failed'),
      DEPLOY_STATE_DIR: state,
      RUNTIME_ENV_FILE: join(remoteRoot, 'runtime.env'),
      HOST_PORT: '18080',
      DEPLOY_POLL_INTERVAL: '0.05',
      DEPLOY_HEALTH_TIMEOUT: '1',
    },
  };
}

async function invoke(remote: Remote, image: string): Promise<RunResult> {
  const child = spawn('bash', [remote.script, image], { cwd: tmpdir(), env: remote.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return collect(child);
}

function start(remote: Remote, image: string): { pid: number | undefined; child: ReturnType<typeof spawn>; done: Promise<RunResult> } {
  const child = spawn('bash', [remote.script, image], { cwd: tmpdir(), env: remote.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return { pid: child.pid, child, done: collect(child) };
}

function collect(child: ReturnType<typeof spawn>): Promise<RunResult> {
  if (!child.stdout || !child.stderr) throw new Error('Deploy child process pipes were not created');
  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    stdoutStream.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    stderrStream.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function readState(remote: Remote): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of ['current-image', 'previous-image']) {
    try { state[name] = (await readFile(join(remote.state, name), 'utf8')).trim(); } catch { /* absent is observable state */ }
  }
  return state;
}

async function readDockerState(remote: Remote): Promise<{ running: string }> {
  const parsed: unknown = JSON.parse(await readFile(remote.dockerState, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('running' in parsed) || typeof parsed.running !== 'string') throw new Error('Invalid fake Docker state');
  return { running: parsed.running };
}

async function readEvents(path: string): Promise<string[][]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === 'string')) throw new Error('Invalid fake Docker event');
    return parsed;
  });
}

async function waitFor(predicate: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { await predicate(); return; } catch { await new Promise((resolveDelay) => setTimeout(resolveDelay, 25)); }
  }
  throw new Error('Timed out waiting for deploy lock');
}
