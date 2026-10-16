import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

const root = resolve(import.meta.dirname, '../..');
const smoke = resolve(root, 'deploy/smoke.mjs');
const revision = 'c'.repeat(40);
const servers: Array<{ http: Server; ws: WebSocketServer }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async ({ http, ws }) => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolveClose) => ws.close(() => resolveClose()));
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
  }));
});

describe('deployment smoke CLI', () => {
  it('accepts a healthy prefixed HTTP and WebSocket service without creating rooms', async () => {
    const fixture = await startFixture();
    const result = await runSmoke(fixture.url, revision);
    expect(result.code, result.stderr).toBe(0);
    expect(fixture.origins).toContain(new URL(fixture.url).origin);
    expect(fixture.roomRequests).toBe(0);
  });

  const unhealthyFixtures: Array<[string, FixtureOptions]> = [
    ['revision', { revision: 'd'.repeat(40) }],
    ['MIME', { mime: 'text/plain' }],
    ['hashed asset', { asset: false }],
    ['missing asset status', { missingAssetStatus: 200 }],
    ['WebSocket pong', { pong: false }],
    ['mismatching WebSocket pong', { wrongPong: true }],
    ['HTTP timeout', { delayHttp: true }],
    ['WebSocket timeout', { delayWs: true }],
  ];
  it.each(unhealthyFixtures)('fails when %s is unhealthy', async (_label, options) => {
    const fixture = await startFixture(options);
    const result = await runSmoke(fixture.url, revision, 8_000);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain('Cannot find module');
    expect(fixture.roomRequests).toBe(0);
  });
});

type FixtureOptions = { revision?: string; mime?: string; asset?: boolean; missingAssetStatus?: number; pong?: boolean; wrongPong?: boolean; delayHttp?: boolean; delayWs?: boolean };
type Fixture = { url: string; origins: string[]; roomRequests: number };

async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const origins: string[] = [];
  let roomRequests = 0;
  const http = createServer((request, response) => {
    if (request.url === '/date-run/health/ready') {
      const send = (): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', revision: options.revision ?? revision }));
      };
      if (options.delayHttp) setTimeout(send, 7_000);
      else send();
      return;
    }
    if (request.url === '/date-run/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<script type="module" src="/date-run/assets/app-a1b2c3d4.js"></script>');
      return;
    }
    if (request.url === '/date-run/assets/__deploy_missing__.js' && options.missingAssetStatus === 200) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('export {};');
      return;
    }
    if (request.url === '/date-run/assets/app-a1b2c3d4.js' && options.asset !== false) {
      response.writeHead(200, { 'content-type': options.mime ?? 'text/javascript' });
      response.end('export {};');
      return;
    }
    if (request.url?.includes('/rooms')) roomRequests += 1;
    response.writeHead(404);
    response.end();
  });
  const ws = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    origins.push(String(request.headers.origin ?? ''));
    ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client, request));
  });
  ws.on('connection', (client) => client.on('message', (data) => {
    let message: unknown;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'time:ping' && 'requestId' in message && typeof message.requestId === 'string'
      && 'clientTime' in message && typeof message.clientTime === 'number' && !options.delayWs && options.pong !== false) {
      client.send(JSON.stringify({ version: 1, type: 'time:pong', requestId: options.wrongPong ? 'wrong-request-id' : message.requestId, clientTime: message.clientTime, serverTime: Date.now() }));
    }
  }));
  await new Promise<void>((resolveListen, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolveListen);
  });
  servers.push({ http, ws });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port');
  return { url: `http://127.0.0.1:${address.port}/date-run/`, origins, get roomRequests() { return roomRequests; } };
}

async function runSmoke(url: string, expectedRevision: string, timeout = 5_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn('node', [smoke, url, expectedRevision], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveResult, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Smoke command exceeded its test timeout')); }, timeout);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}
