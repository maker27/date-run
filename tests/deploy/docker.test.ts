import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupOwnedResources, type CleanupResource } from './cleanup.js';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
const context = process.env.DOCKER_CONTEXT ?? 'rootless';
const image = `date-run-task19-test:${randomUUID().replaceAll('-', '')}`;
const resources = new Set<string>();
const images = new Set([image]);
let tempDirectory = '';
let appPort = 0;
let fixturePort = 0;

async function docker(args: string[], timeout = 30_000, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['--context', context, ...args], {
    cwd: root,
    timeout,
    maxBuffer: 2_000_000,
    env: { ...process.env, ...extraEnv, DOCKER_CONTEXT: context },
  });
  return stdout.trim();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local port');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

async function waitHealthy(container: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await docker(['inspect', '--format', '{{.State.Health.Status}}', container]);
    if (state === 'healthy') return;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', container]);
    if (running !== 'true') throw new Error(`App container exited before health check: ${container}`);
    await delay(500);
  }
  throw new Error(`App container did not become healthy: ${container}`);
}

describe('deployment image and compose', () => {
  beforeAll(async () => {
    await docker(['info'], 15_000);
    tempDirectory = await mkdtemp(join(tmpdir(), 'date-run-task19-'));
    appPort = await availablePort();
    fixturePort = await availablePort();
  });

  afterAll(async () => {
    const cleanupActions: CleanupResource[] = [
      ...[...resources].map((container) => ({
        name: `container ${container}`,
        cleanup: async () => removeContainer(container),
      })),
      ...[...images].map((ownedImage) => ({
        name: `image ${ownedImage}`,
        cleanup: async () => removeImage(ownedImage),
      })),
      ...(tempDirectory ? [{ name: `temporary directory ${tempDirectory}`, cleanup: async () => rm(tempDirectory, { recursive: true, force: true }) }] : []),
    ];
    await cleanupOwnedResources(cleanupActions);
  });

  it('validates the external compose contract and runs the pinned production image behind fixture nginx', async () => {
    const envFile = join(tempDirectory, 'runtime.env');
    await writeFile(envFile, [
      'NODE_ENV=production',
      'BIND_HOST=0.0.0.0',
      'PORT=3000',
      'ALLOWED_ORIGINS=https://first.test,https://second.test',
      'PROXY_MODE=nginx',
      'TRUSTED_PROXY_PEERS=127.0.0.1',
      '',
    ].join('\n'));
    const compose = await docker(['compose', '-f', 'deploy/compose.yml', 'config', '--format', 'json'], 15_000, {
      HOST_PORT: '18080',
      IMAGE_REF: 'registry.example.test/date-run@sha256:' + 'b'.repeat(64),
      RUNTIME_ENV_FILE: envFile,
    }).catch((error: unknown) => {
      const missing = error instanceof Error ? error.message : String(error);
      throw new Error(`Compose config failed with required external values: ${missing}`);
    });
    await expect(docker(['compose', '-f', 'deploy/compose.yml', 'config', '--format', 'json'], 15_000, {
      HOST_PORT: '',
      IMAGE_REF: '',
      RUNTIME_ENV_FILE: '',
    })).rejects.toThrow();
    const document: unknown = JSON.parse(compose);
    if (!document || typeof document !== 'object' || !('services' in document) || !document.services || typeof document.services !== 'object') {
      throw new Error('Compose config did not return services');
    }
    const services = asRecord(document.services);
    const rawService = services.app;
    if (!rawService || typeof rawService !== 'object') throw new Error('Compose config omitted app service');
    const parsedService = asRecord(rawService);
    const ports = Array.isArray(parsedService.ports) ? parsedService.ports : [];
    const resolvedEnvironment = isRecord(parsedService.environment) ? parsedService.environment : {};
    const serviceConfig = {
      image: typeof parsedService.image === 'string' ? parsedService.image : undefined,
      cpus: typeof parsedService.cpus === 'number' ? parsedService.cpus : undefined,
      mem_limit: parsedService.mem_limit,
      environment: resolvedEnvironment,
      read_only: parsedService.read_only === true,
      ports: ports.filter(isRecord),
    };
    expect(serviceConfig.ports).toContainEqual(expect.objectContaining({ host_ip: '127.0.0.1', published: '18080', target: 3000 }));
    expect(serviceConfig.cpus).toBe(2);
    expect(Number(serviceConfig.mem_limit)).toBe(4 * 1024 ** 3);
    expect(serviceConfig.read_only).toBe(true);
    expect(serviceConfig.environment.ALLOWED_ORIGINS).toBe('https://first.test,https://second.test');
    expect(serviceConfig.environment.PROXY_MODE).toBe('nginx');
    expect(serviceConfig.environment.TRUSTED_PROXY_PEERS).toBe('127.0.0.1');
    expect(serviceConfig.environment.APP_REVISION).toBeUndefined();
    expect(serviceConfig.image).toMatch(/@sha256:[a-f0-9]{64}$/);

    const imageRevision = 'a'.repeat(40);
    await docker(['build', '--tag', image, '--build-arg', `APP_REVISION=${imageRevision}`, '.'], 150_000);
    const user = await docker(['image', 'inspect', '--format', '{{.Config.User}}', image]);
    expect(user).not.toBe('');
    expect(user).not.toMatch(/^(0|root)(:|$)/);
    const exposed = await docker(['image', 'inspect', '--format', '{{json .Config.ExposedPorts}}', image]);
    expect(exposed).toContain('3000/tcp');
    expect(exposed).not.toContain('80/tcp');
    const imageLabel = await docker(['image', 'inspect', '--format', '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]);
    expect(imageLabel).toBe(imageRevision);
    const environmentValue: unknown = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .Config.Env}}', image]));
    if (!Array.isArray(environmentValue)) throw new Error('Image config did not include an environment array');
    const imageEnvironment = environmentValue.filter((value): value is string => typeof value === 'string');
    expect(imageEnvironment).toContain(`APP_REVISION=${imageRevision}`);

    const contents = await docker(['run', '--rm', '--entrypoint', 'node', image, '-e', "const fs=require('node:fs'); console.log(JSON.stringify(['/app/art/source','/app/.work','/app/node_modules/vitest','/app/node_modules/tsx'].map(p=>fs.existsSync(p))))"]);
    expect(JSON.parse(contents)).toEqual([false, false, false, false]);
    const container = `date-run-task19-app-${randomUUID().slice(0, 8)}`;
    resources.add(container);
    await docker([
      'run', '--detach', '--name', container,
      '--publish', `127.0.0.1:${appPort}:3000`, '--publish', `127.0.0.1:${fixturePort}:18081`,
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
      '--env-file', envFile, image,
    ], 30_000);
    await waitHealthy(container);
    const rootWritable = await docker(['exec', container, 'node', '-e', "const fs=require('node:fs'); try { fs.writeFileSync('/root-task19-probe','x'); process.exit(1) } catch { process.exit(0) }"]);
    expect(rootWritable).toBe('');
    const readiness = await fetchWithin(`http://127.0.0.1:${appPort}/date-run/health/ready`);
    expect(readiness.status).toBe(200);
    const readinessBody: unknown = await readiness.json();
    if (!isRecord(readinessBody)) throw new Error('Readiness response was not an object');
    expect(readinessBody.revision).toBe(imageRevision);

    await runNginxFixture(container);
  });

  it.each([
    { label: 'missing', args: [] },
    { label: 'malformed', args: ['--build-arg', 'APP_REVISION=not-a-revision'] },
    { label: 'all zeroes', args: ['--build-arg', `APP_REVISION=${'0'.repeat(40)}`] },
  ])('rejects an image build with $label revision', async ({ label, args }) => {
    const candidate = `${image}-${label.replaceAll(' ', '-')}`;
    images.add(candidate);
    await expect(docker(['build', '--tag', candidate, ...args, '.'], 150_000)).rejects.toThrow();
  });

  async function runNginxFixture(appContainer: string): Promise<void> {
    const locationConfig = await execFileAsync('node', ['--import', 'tsx', 'deploy/render-nginx.ts', '3000'], {
      cwd: root,
      timeout: 10_000,
      env: process.env,
    }).then(({ stdout }) => stdout);
    const httpConfig = await readFile(join(root, 'deploy/nginx-http.conf'), 'utf8');
    const fixture = await readFile(join(root, 'tests/deploy/fixtures/nginx.conf'), 'utf8');
    await writeFile(join(tempDirectory, 'http.conf'), httpConfig);
    await writeFile(join(tempDirectory, 'server.conf'), fixture);
    await writeFile(join(tempDirectory, 'server-locations.conf'), locationConfig);
    const testNginx = `date-run-task19-nginx-${randomUUID().slice(0, 8)}`;
    resources.add(testNginx);
    const output = await docker([
      'run', '--detach', '--name', testNginx, '--network', `container:${appContainer}`,
      '--mount', `type=bind,src=${join(tempDirectory, 'server.conf')},dst=/etc/nginx/nginx.conf,readonly`,
      '--mount', `type=bind,src=${join(tempDirectory, 'http.conf')},dst=/etc/nginx/conf.d/http.conf,readonly`,
      '--mount', `type=bind,src=${join(tempDirectory, 'server-locations.conf')},dst=/etc/nginx/conf.d/server-locations.conf,readonly`,
      '--entrypoint', 'nginx', 'nginx@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2', '-g', 'daemon off;', '-c', '/etc/nginx/nginx.conf',
    ], 30_000);
    expect(output).toMatch(/[0-9a-f]{12,}/);
    await docker(['exec', testNginx, 'nginx', '-t', '-c', '/etc/nginx/nginx.conf']);
    await waitHttp(`http://127.0.0.1:${fixturePort}/date-run/health/live`, 200);
    const firstHost = { headers: { Host: 'first.test' } };
    const secondHost = { headers: { Host: 'second.test' } };
    expect(await fetchWithin(`http://127.0.0.1:${fixturePort}/`, firstHost).then((response) => response.status)).toBe(200);
    expect(await fetchWithin(`http://127.0.0.1:${fixturePort}/`, secondHost).then((response) => response.status)).toBe(200);
    const redirect = await fetchWithin(`http://127.0.0.1:${fixturePort}/date-run?from=integration&x=1`, { ...firstHost, redirect: 'manual' });
    expect(redirect.status).toBe(308);
    const redirectTarget = new URL(redirect.headers.get('location') ?? '', `http://first.test:${fixturePort}/`);
    expect(redirectTarget.host).toBe(`first.test:${fixturePort}`);
    expect(redirectTarget.pathname).toBe('/date-run/');
    expect(redirectTarget.search).toBe('?from=integration&x=1');
    const missingAsset = await fetchWithin(`http://127.0.0.1:${fixturePort}/date-run/assets/missing-asset.js`, secondHost);
    expect(missingAsset.status).toBe(404);
    const assetPath = await docker(['exec', appContainer, 'node', '-e', "const fs=require('node:fs');const p='/app/dist/client';const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(d+'/'+x.name):[d+'/'+x.name]); console.log(walk(p).map(x=>x.slice(p.length+1)).find(x=>x.startsWith('assets/')&&x.endsWith('.css'))||'')"]);
    expect(assetPath).toMatch(/^assets\/[^/]+\.css$/);
    const assetResponse = await fetchWithin(`http://127.0.0.1:${fixturePort}/date-run/${assetPath}`, firstHost);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toMatch(/^text\/css/);
    expect(assetResponse.headers.get('cache-control')).toMatch(/immutable/);
    await expectWebSocket(`ws://127.0.0.1:${fixturePort}/date-run/ws`, 'https://first.test', 'first.test', 101);
    await expectWebSocket(`ws://127.0.0.1:${fixturePort}/date-run/ws`, 'https://second.test', 'second.test', 101);
    await expectWebSocket(`ws://127.0.0.1:${fixturePort}/date-run/ws`, 'https://foreign.test', 'first.test', 403);
  }
});

async function waitHttp(url: string, status: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithin(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === status) return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`HTTP fixture did not return ${status}: ${url}`);
}

function fetchWithin(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(5_000) });
}

function asRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function expectWebSocket(url: string, origin: string, host: string, status: number): Promise<void> {
  const socket = new WebSocket(url, { headers: { Origin: origin, Host: host } });
  let timer: NodeJS.Timeout | undefined;
  try {
    const responseStatus = await new Promise<number>((resolveResponse, reject) => {
      timer = setTimeout(() => reject(new Error(`WebSocket handshake timed out for ${origin}`)), 5_000);
      socket.once('upgrade', (response) => resolveResponse(response.statusCode ?? 0));
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolveResponse(response.statusCode ?? 0);
      });
      socket.once('error', reject);
    });
    expect(responseStatus).toBe(status);
  } finally {
    if (timer) clearTimeout(timer);
    socket.terminate();
  }
}

async function removeContainer(container: string): Promise<void> {
  try {
    await docker(['rm', '--force', container], 10_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('No such container')) throw error;
  }
}

async function removeImage(imageName: string): Promise<void> {
  try {
    await docker(['image', 'rm', '--force', imageName], 15_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('No such image')) throw error;
  }
}
