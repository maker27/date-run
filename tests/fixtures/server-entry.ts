import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import type { Duplex } from 'node:stream';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderNginxLocation } from '../../deploy/render-nginx.js';
import { createHttpServer } from '../../src/server/http/http-server.js';
import type { ServerConfig } from '../../src/server/http/config.js';
import { SessionStore } from '../../src/server/realtime/session-store.js';
import { attachWebSocketServer, type RealtimeHandle } from '../../src/server/realtime/ws-server.js';
import { normalizeRoomCode } from '../../src/shared/room-code.js';
import { SHORT_LEVEL } from './short-level.js';

const appPort = Number(process.env.E2E_APP_PORT ?? '4173');
const controlPort = Number(process.env.E2E_CONTROL_PORT ?? '4174');
const nginxPort = 4180;
const nginxTlsPort = 4181;
if (![appPort, controlPort].every((port) => Number.isInteger(port) && port > 0 && port <= 65535) || appPort === controlPort) {
  throw new Error('Invalid E2E fixture ports');
}
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const config: ServerConfig = {
  port: appPort,
  host: '127.0.0.1',
  clientRoot: resolve(repoRoot, 'dist/test-client'),
  allowedOrigins: [
    `http://127.0.0.1:${appPort}`,
    `http://localhost:${appPort}`,
    `http://first.test:${appPort}`,
    `http://second.test:${appPort}`,
    `http://first.test:${nginxPort}`,
    `http://second.test:${nginxPort}`,
    `https://first.test:${nginxTlsPort}`,
    `https://second.test:${nginxTlsPort}`,
  ],
  proxyMode: 'none',
  trustedProxyPeers: [],
  revision: 'dev',
};

let offset = 0;
const clock = () => performance.now() + offset;
let app: { server: Server; realtime: RealtimeHandle; store: SessionStore } | null = null;
const socketById = new Map<string, Duplex>();
let nginx: ChildProcess | null = null;
let nginxRoot: string | null = null;
const control = createServer((request, response) => {
  void handleControl(request, response).catch(() => send(response, 500, { code: 'fixture_error' }));
});

async function startApp(): Promise<void> {
  const store = new SessionStore({ clock, level: SHORT_LEVEL, uuid: randomUUID });
  const http = createHttpServer(store, config, { clock });
  http.server.on('upgrade', (request, socket) => {
    const protocol = request.headers['sec-websocket-protocol'];
    if (typeof protocol !== 'string' || !/^date-run-test-[0-9a-f-]{36}$/.test(protocol)) return;
    const id = protocol.slice('date-run-test-'.length);
    socketById.set(id, socket);
    socket.once('close', () => socketById.delete(id));
  });
  const realtime = attachWebSocketServer(http.server, store, {
    allowedOrigins: config.allowedOrigins,
    clock,
    livenessClock: () => performance.now(),
    autoSchedule: true,
  });
  try {
    await listen(http.server, appPort);
  } catch (error) {
    await realtime.close();
    throw error;
  }
  app = { server: http.server, realtime, store };
}

async function stopApp(): Promise<void> {
  const current = app;
  if (!current) return;
  app = null;
  await current.realtime.close();
  socketById.clear();
  await new Promise<void>((resolveClose, reject) => {
    current.server.close((error) => error ? reject(error) : resolveClose());
    current.server.closeIdleConnections();
  });
}

async function startNginx(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'date-run-e2e-nginx-'));
  nginxRoot = root;
  const httpConfig = await readFile(resolve(repoRoot, 'deploy/nginx-http.conf'), 'utf8');
  const locationConfig = renderNginxLocation(String(appPort));
  const configPath = join(root, 'nginx.conf');
  const certificatePath = join(root, 'certificate.pem');
  const keyPath = join(root, 'key.pem');
  await promisify(execFile)('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-days', '1',
    '-subj', '/CN=first.test',
    '-addext', 'subjectAltName=DNS:first.test,DNS:second.test,IP:127.0.0.1',
    '-keyout', keyPath, '-out', certificatePath,
  ], { timeout: 10_000 });
  const configText = [
    'worker_processes 1;',
    'error_log stderr warn;',
    `pid ${join(root, 'nginx.pid')};`,
    'events { worker_connections 128; }',
    'http {',
    '  include /etc/nginx/mime.types;',
    '  access_log off;',
    httpConfig,
    '  server {',
    `    listen 127.0.0.1:${nginxPort};`,
    `    listen 127.0.0.1:${nginxTlsPort} ssl;`,
    `    ssl_certificate ${certificatePath};`,
    `    ssl_certificate_key ${keyPath};`,
    '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    server_name first.test second.test;',
    '    location = / { default_type text/plain; return 200 "Sibling site"; }',
    '    location / { return 404; }',
    locationConfig,
    '  }',
    '}',
  ].join('\n');
  await writeFile(configPath, configText);
  const child = spawn('/usr/sbin/nginx', ['-g', 'daemon off;', '-p', root, '-c', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  nginx = child;
  let failure: Error | null = null;
  child.once('error', (error) => { failure = error; });
  child.once('exit', (code) => { failure = new Error(`E2E nginx exited (${code ?? 'signal'})`); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      const response = await fetch(`http://127.0.0.1:${nginxPort}/`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200 && await response.text() === 'Sibling site') return;
    } catch { /* nginx is still starting */ }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('E2E nginx startup timed out');
}

async function stopNginx(): Promise<void> {
  const child = nginx;
  nginx = null;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  }
  if (nginxRoot) {
    await rm(nginxRoot, { recursive: true, force: true });
    nginxRoot = null;
  }
}

async function handleControl(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/health') {
    send(response, app ? 200 : 503, { status: app ? 'ok' : 'restarting' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/snapshot') {
    const roomId = normalizeRoomCode(url.searchParams.get('room') ?? '');
    const snapshot = roomId ? app?.store.snapshot(roomId, clock()) : undefined;
    send(response, snapshot ? 200 : 404, snapshot ?? { code: 'room_not_found' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/advance') {
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || !('ms' in body) || typeof body.ms !== 'number' || !Number.isInteger(body.ms) || body.ms < 0 || body.ms > 1_900_000) {
      send(response, 400, { code: 'invalid_advance' });
      return;
    }
    offset += body.ms;
    app?.realtime.advance(clock());
    send(response, 200, { advancedMs: body.ms });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/break') {
    const body = await readBody(request);
    if (!body || typeof body !== 'object' || !('connectionId' in body) || typeof body.connectionId !== 'string') {
      send(response, 400, { code: 'invalid_connection' });
      return;
    }
    const socket = socketById.get(body.connectionId);
    if (!socket) { send(response, 404, { code: 'connection_not_found' }); return; }
    socket.destroy();
    send(response, 200, { status: 'broken' });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/restart') {
    await stopApp();
    await startApp();
    send(response, 200, { status: 'restarted' });
    return;
  }
  send(response, 404, { code: 'not_found' });
}

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1024) return null;
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function send(response: import('node:http').ServerResponse, status: number, body: object): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

await startApp();
try { await listen(control, controlPort); }
catch (error) { await stopApp(); throw error; }
try { await startNginx(); }
catch (error) { await stopNginx(); await stopApp(); control.close(); throw error; }
process.stdout.write('Date Run E2E fixture ready\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopNginx().then(stopApp).then(() => new Promise<void>((resolveClose) => control.close(() => resolveClose()))).catch(() => { process.exitCode = 1; });
  });
}
