import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const launcher = resolve(root, 'deploy/launcher.sh');
const directories: string[] = [];
const revision = 'a'.repeat(40);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('external launcher contract', () => {
  const transferFailures: Array<'scp' | 'final-ssh'> = ['scp', 'final-ssh'];
  it('refuses dirty and unborn repositories before any transfer', async () => {
    const gitStates: Array<'dirty' | 'unborn'> = ['dirty', 'unborn'];
    for (const gitState of gitStates) {
      const fixture = await makeFixture(gitState);
      const result = await runLauncher(fixture, fixture.cwd);
      expect(result.code, result.stderr).not.toBe(0);
      const calls = await readCalls(fixture.log);
      expect(calls.filter((call) => ['docker', 'scp', 'ssh'].includes(call.name))).toEqual([]);
    }
  });

  it('builds from any cwd, propagates explicit DOCKER_CONTEXT, and prepares an immutable release', async () => {
    const fixture = await makeFixture('clean', 'test-local-context');
    const result = await runLauncher(fixture, tmpdir());
    expect(result.code, result.stderr).toBe(0);
    const calls = await readCalls(fixture.log);
    const docker = calls.filter((call) => call.name === 'docker');
    const build = docker.find((call) => call.args.includes('build'));
    expect(build?.args).toEqual(expect.arrayContaining(['--context', 'test-local-context', `APP_REVISION=${revision}`]));
    expect(build?.args).toContain(fixture.cwd);
    expect(build?.cwd).toBe(resolve(tmpdir()));
    const saveIndex = calls.findIndex((call) => call.name === 'docker' && call.args.includes('save'));
    const scpIndex = calls.findIndex((call) => call.name === 'scp');
    const sshCalls = calls.filter((call) => call.name === 'ssh');
    const deployCall = sshCalls.at(-1);
    const remoteCommand = deployCall?.args.at(-1) ?? '';
    const loadIndex = calls.findIndex((call) => call.name === 'docker' && call.args.includes('load'));
    const invokeIndex = calls.findIndex((call) => call.name === 'remote-deploy');
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeLessThan(scpIndex);
    expect(scpIndex).toBeLessThan(loadIndex);
    expect(loadIndex).toBeLessThan(invokeIndex);
    expect(remoteCommand).toContain(`IMAGE_REF='registry.example/date-run:${revision}'`);
    expect(remoteCommand).toContain('/deploy/deploy.sh');
    expect(calls.filter((call) => call.name === 'git').every((call) => call.cwd === fixture.cwd)).toBe(true);
    expect(await readFile(fixture.shellMarker, 'utf8').catch(() => '')).toBe('');
  });

  it('does not add a personal Docker context when DOCKER_CONTEXT is absent', async () => {
    const fixture = await makeFixture('clean');
    const result = await runLauncher(fixture, fixture.cwd);
    expect(result.code, result.stderr).toBe(0);
    const build = (await readCalls(fixture.log)).find((call) => call.name === 'docker' && call.args.includes('build'));
    expect(build?.args).not.toContain('--context');
  });

  it('reports missing configuration and never prints credential sentinels', async () => {
    const fixture = await makeFixture('clean');
    const env = { ...fixture.env, SSH_ALIAS: '', TOKEN: 'launcher-secret-sentinel', PASSWORD: 'launcher-password-sentinel' };
    const result = await runLauncher({ ...fixture, env }, fixture.cwd);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Missing SSH_ALIAS');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('launcher-secret-sentinel');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('launcher-password-sentinel');
    expect((await readCalls(fixture.log)).filter((call) => ['docker', 'scp', 'ssh', 'remote-deploy'].includes(call.name))).toEqual([]);
  });

  it.each(transferFailures)('removes only its incoming directory after %s failure', async (failure) => {
    const fixture = await makeFixture('clean', undefined, failure);
    const foreign = join(fixture.remote, 'operator-owned.txt');
    await writeFile(foreign, 'keep this');
    const result = await runLauncher(fixture, tmpdir());
    const foreignContents = await readFile(foreign, 'utf8');
    const incomingDirectories = (await readdir(fixture.remote)).filter((name) => name.startsWith('.incoming-date-run-'));
    const calls = await readCalls(fixture.log);
    expect.soft(result.code).not.toBe(0);
    expect.soft(foreignContents).toBe('keep this');
    expect.soft(incomingDirectories).toEqual([]);
    expect.soft(calls.some((call) => call.name === 'ssh' && call.args.join(' ').includes('mkdir -m 700'))).toBe(true);
    if (failure === 'scp') expect.soft(calls.some((call) => call.name === 'scp')).toBe(true);
    if (failure === 'final-ssh') expect.soft(calls.some((call) => call.name === 'ssh' && call.args.join(' ').includes('/deploy/deploy.sh'))).toBe(true);
  });
});

type Call = { name: string; args: string[]; cwd: string };
type Fixture = { env: NodeJS.ProcessEnv; log: string; cwd: string; remote: string; shellMarker: string };

async function makeFixture(state: 'clean' | 'dirty' | 'unborn', dockerContext?: string, failure?: 'scp' | 'final-ssh'): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'date-run launcher '));
  directories.push(base);
  const bin = join(base, 'mock bin');
  const cwd = join(base, 'repo with spaces');
  await mkdir(bin, { recursive: true });
  await mkdir(join(cwd, 'deploy'), { recursive: true });
  await copyFile(resolve(root, 'Dockerfile'), join(cwd, 'Dockerfile'));
  for (const filename of ['deploy.sh', 'compose.yml', 'smoke.mjs']) {
    await copyFile(resolve(root, 'deploy', filename), join(cwd, 'deploy', filename));
  }
  const log = join(base, 'calls.jsonl');
  const fake = join(base, 'fake-command.mjs');
  await writeFile(fake, `import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const [name, ...args] = process.argv.slice(2);
appendFileSync(process.env.CALL_LOG, JSON.stringify({ name, args, cwd: process.cwd() }) + '\\n');
if (name === 'git') {
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') { if (process.env.GIT_STATE === 'unborn') process.exit(1); process.stdout.write('${revision}\\n'); }
  else if (args[0] === 'status' && args[1] === '--porcelain') { if (process.env.GIT_STATE === 'dirty') process.stdout.write(' M file\\n'); }
  else process.exit(2);
} else if (name === 'docker') {
  if (args.includes('save')) process.stdout.write('image archive');
  else if (args.includes('build')) {}
  else if (args.includes('load')) process.stdin.resume();
  else process.exit(2);
} else if (name === 'ssh') {
  const command = args.at(-1) ?? '';
  if (process.env.LAUNCHER_FAILURE === 'final-ssh' && command.includes('/deploy/deploy.sh')) process.exit(1);
  const result = spawnSync('/bin/sh', ['-c', command], { cwd: process.env.REMOTE_CWD, env: process.env, encoding: 'utf8' });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1);
} else if (name === 'bash') {
  const [script, ...scriptArgs] = args;
  if (script?.endsWith('/deploy/deploy.sh')) {
    appendFileSync(process.env.CALL_LOG, JSON.stringify({ name: 'remote-deploy', args: [script, ...scriptArgs], cwd: process.cwd() }) + '\\n');
    process.exit(0);
  }
  const result = spawnSync('/bin/bash', args, { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1);
} else if (name === 'scp') {
  if (process.env.LAUNCHER_FAILURE === 'scp') process.exit(1);
  const destination = args.at(-1) ?? '';
  const separator = destination.indexOf(':');
  if (separator < 0) process.exit(2);
  const target = destination.slice(separator + 1);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(args.at(-2) ?? '', target);
} else process.exit(2);
`);
  const wrapper = async (name: string): Promise<void> => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nexec node "$FAKE_COMMAND" ${name} "$@"\n`);
    await chmod(path, 0o755);
  };
  for (const name of ['git', 'docker', 'scp', 'ssh', 'bash']) await wrapper(name);
  const remote = join(base, `remote directory;touch INJECTED'quoted`);
  const shellMarker = join(remote, 'INJECTED');
  await mkdir(remote);
  return {
    cwd,
    log,
    remote,
    shellMarker,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      CALL_LOG: log,
      FAKE_COMMAND: fake,
      GIT_STATE: state,
      REMOTE_CWD: remote,
      REPO_DIR: cwd,
      SSH_ALIAS: 'deploy-host',
      REMOTE_DIR: remote,
      IMAGE_NAME: 'registry.example/date-run',
      LAUNCHER_FAILURE: failure ?? '',
      ...(dockerContext ? { DOCKER_CONTEXT: dockerContext } : {}),
    },
  };
}

async function runLauncher(fixture: Fixture, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn('bash', [launcher], { cwd, env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!child.stdout || !child.stderr) throw new Error('Launcher child process pipes were not created');
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function readCalls(path: string): Promise<Call[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
      || !('args' in value) || !Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')
      || !('cwd' in value) || typeof value.cwd !== 'string') throw new Error('Invalid fake command record');
    return { name: value.name, args: value.args, cwd: value.cwd };
  });
}
