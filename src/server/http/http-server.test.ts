import { createServer as createTcpServer } from 'node:net';
import { type Server as HttpServer } from 'node:http';
import type { ServerConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { serveStatic } from './static-files.js';
import { createHttpFixture, requestRawPath } from '../../../tests/fixtures/http-test-helpers.js';
import { closeClient, openClient, requestId, type BufferedClient } from '../../../tests/fixtures/ws-test-helpers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';

describe('HTTP server', () => {
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

  let releaseOutputs: Record<string, string>;
  let buildRoot: string;

  beforeAll(async () => {
    releaseOutputs = await readReleaseOutputs(repositoryRoot);
    buildRoot = await mkdtemp(join(tmpdir(), 'date-run-http-build-'));
    await Promise.all([
      writeFile(join(buildRoot, 'package.json'), JSON.stringify({ type: 'module' })),
      symlink(join(repositoryRoot, 'node_modules'), join(buildRoot, 'node_modules'), 'dir'),
    ]);
    await buildServer(repositoryRoot, buildRoot);
  }, 45_000);

  afterAll(async () => {
    if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
  });

  it('preserves release artifacts while preparing the HTTP test build', async () => {
    expect(await readReleaseOutputs(repositoryRoot)).toEqual(releaseOutputs);
  });

  it('returns validated previews without claiming a place or exposing player credentials', async () => {
    const staticFixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    const config = testConfig(staticFixture.root);
    const handle = createHttpServer(staticFixture.store, config);
    await listen(handle.server);
    const address = handle.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
    const origin = `http://127.0.0.1:${address.port}`;
    const fixtureSession = staticFixture.store.registerSocket('fixture-socket');
    expect(fixtureSession).toBe(true);
    const created = staticFixture.store.create('retro', 'a', 'fixture-socket');
    if (!created.ok) throw new Error('room fixture could not be created');

    try {
      const occupiedPlaces = staticFixture.store.countOccupiedPlaces();
      const response = await fetch(`${origin}/date-run/api/rooms/ABCDEFGH`);
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(body).toEqual({
        roomId: 'ABCDEFGH', themeId: 'retro', availableRole: 'b', phase: 'lobby', occupiedPlaces: 1,
      });
      expect(JSON.stringify(body)).not.toContain(created.session.playerId);
      expect(JSON.stringify(body)).not.toContain(created.session.sessionToken);
      expect(staticFixture.store.countOccupiedPlaces()).toBe(occupiedPlaces);
    } finally {
      await closeHttp(handle.server);
      await staticFixture.close();
    }
  });

  it('returns schema-safe preview errors, applies a 60-per-minute IP limit, and does not cache old replies as new', async () => {
    const staticFixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    let now = 0;
    const handle = createHttpServer(staticFixture.store, testConfig(staticFixture.root), { clock: () => now });
    await listen(handle.server);
    const address = handle.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const missing = await fetch(`${origin}/date-run/api/rooms/ABCDEFGH`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ code: 'room_not_found' });
      for (let request = 0; request < 59; request += 1) {
        expect((await fetch(`${origin}/date-run/api/rooms/ABCDEFGH?request=${request}`)).status).toBe(404);
      }
      const limited = await fetch(`${origin}/date-run/api/rooms/ABCDEFGH?request=60`);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ code: 'rate_limited' });
      expect(limited.headers.get('retry-after')).toBe('1');

      now = 1000;
      const refilled = await fetch(`${origin}/date-run/api/rooms/ABCDEFGH?request=61`);
      expect(refilled.status).toBe(404);
      expect(await refilled.json()).toEqual({ code: 'room_not_found' });
    } finally {
      await closeHttp(handle.server);
      await staticFixture.close();
    }
  });

  it('provides live and ready health states, revision, security headers, and prefix isolation', async () => {
    const staticFixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    const handle = createHttpServer(staticFixture.store, testConfig(staticFixture.root));
    await listen(handle.server);
    const address = handle.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      for (const [path, expected] of [
        ['/date-run/health/live', { status: 'ok', revision: 'dev' }],
        ['/date-run/health/ready', { status: 'ok', revision: 'dev' }],
      ] as const) {
        const response = await fetch(`${origin}${path}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(response.headers.get('content-security-policy')).toContain("img-src 'self' blob:");
        expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      }
      handle.setShuttingDown();
      const readiness = await fetch(`${origin}/date-run/health/ready`);
      expect(readiness.status).toBe(503);
      expect(await readiness.json()).toEqual({ status: 'shutting_down', revision: 'dev' });
      const liveness = await fetch(`${origin}/date-run/health/live`);
      expect(liveness.status).toBe(200);
      expect(await liveness.json()).toEqual({ status: 'ok', revision: 'dev' });
      expect((await requestRawPath(origin, '/other/health/live')).status).toBe(404);
    } finally {
      await closeHttp(handle.server);
      await staticFixture.close();
    }
  });

  it('closes cleanly and releases its listening port', async () => {
    const staticFixture = await createHttpFixture((request, response, root) => serveStatic(request, response, root));
    const handle = createHttpServer(staticFixture.store, testConfig(staticFixture.root));
    await listen(handle.server);
    const address = handle.server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server has no TCP address');

    try {
      await closeHttp(handle.server);
      await expectPortAvailable(address.port);
    } finally {
      await staticFixture.close();
    }
  });

  it('serves the built client from another working directory and shuts down gracefully on SIGTERM', async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), 'date-run-cwd-'));
    const port = await reservePort();
    const entrypoint = join(buildRoot, 'server/index.js');
    const child = spawn(process.execPath, [entrypoint], {
      cwd: workingDirectory,
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), BIND_HOST: '127.0.0.1', APP_REVISION: 'dev' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = collectOutput(child);
    let client: BufferedClient | undefined;

    try {
      const origin = `http://127.0.0.1:${port}`;
      await waitForHealth(origin, child);
      const index = await fetch(`${origin}/date-run/`);
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toMatch(/^text\/html\b/);
      const html = await index.text();
      const assetPath = html.match(/(?:src|href)="([^" ]+\.js)"/)?.[1];
      expect(assetPath).toBeDefined();
      if (!assetPath) throw new Error('Built app entry did not reference a JavaScript asset');
      const asset = await fetch(new URL(assetPath, origin));
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toMatch(/^text\/javascript\b|^application\/javascript\b/);

      client = await openClient(`ws://127.0.0.1:${port}/date-run/ws`, 'http://localhost:5173');
      await client.send({ version: 1, type: 'room:create', requestId: requestId(701), themeId: 'retro', role: 'a' });
      await client.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(701));

      child.kill('SIGTERM');
      await client.waitFor((message) => message.type === 'room:closing' && message.reason === 'restart', 2500);
      await expectWebSocketRejected(`ws://127.0.0.1:${port}/date-run/ws`);
      const exit = await waitForExit(child, 9000);
      expect(exit.code).toBe(0);
      expect(output.stderr()).toBe('');
      await expectPortAvailable(port);
    } finally {
      if (client) await closeClient(client);
      await stopChild(child);
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }, 30000);
});

function testConfig(clientRoot: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    clientRoot,
    allowedOrigins: ['https://date-run.test'],
    proxyMode: 'none',
    trustedProxyPeers: [],
    revision: 'dev',
  };
}

function listen(server: HttpServer, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('HTTP server listen timed out')), timeoutMs);
    const onListening = () => finish();
    const onError = (error: Error) => finish(error);
    function finish(error?: Error): void {
      clearTimeout(timer);
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(0, '127.0.0.1');
  });
}

async function closeHttp(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      reject(new Error('HTTP server close timed out'));
    }, 2000);
    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}

async function reservePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve an ephemeral port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function buildServer(repositoryRoot: string, buildRoot: string): Promise<void> {
  const commands = [
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.server.json', '--outDir', buildRoot],
    ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(buildRoot, 'client'), '--emptyOutDir'],
  ] satisfies [string, ...string[]][];
  for (const [entrypoint, ...args] of commands) {
    const child = spawn(process.execPath, [join(repositoryRoot, entrypoint), ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = collectOutput(child);
    try {
      const exit = await waitForExit(child, 45_000);
      if (exit.code !== 0) throw new Error(`HTTP test build failed with code ${String(exit.code)}: ${output.stdout()}${output.stderr()}`);
    } finally {
      await stopChild(child);
    }
  }
}

async function waitForHealth(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Server child exited before becoming healthy');
    }
    try {
      const response = await fetch(`${origin}/date-run/health/live`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch {
      // The child may still be starting or closing its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Server child did not become healthy');
}

function expectWebSocketRejected(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: 'http://localhost:5173' });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('WebSocket shutdown rejection timed out')), 2000);
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 400
        ? undefined
        : new Error(`Expected WebSocket rejection, received ${response.statusCode}`));
    });
    socket.once('open', () => finish(new Error('WebSocket connection was accepted during shutdown')));
    socket.once('error', () => finish());

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (error) reject(error);
      else resolve();
    }
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server child did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForExit(child, 2000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 2000);
  }
}

function collectOutput(child: ChildProcess): { stdout(): string; stderr(): string } {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return { stdout: () => stdout, stderr: () => stderr };
}

async function expectPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createTcpServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function readReleaseOutputs(repositoryRoot: string): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const directory of ['client', 'server', 'shared']) {
    const root = join(repositoryRoot, 'dist', directory);
    let entries;
    try {
      entries = await readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      outputs[path] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  return outputs;
}
