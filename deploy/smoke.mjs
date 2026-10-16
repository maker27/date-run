import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { WebSocket } from 'ws';

const [baseInput, revision] = process.argv.slice(2);
const limit = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

if (!/^[0-9a-f]{40}$/.test(revision ?? '')) fail('EXPECTED_REVISION must be a 40-character SHA');
const base = new URL(baseInput);
if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/date-run/' || base.search || base.hash) fail('BASE_URL must end in /date-run/');

async function request(path, expectedStatus, mime) {
  const response = await globalThis.fetch(new URL(path, base), {
    headers: { 'X-Real-IP': '127.0.0.1' },
    signal: globalThis.AbortSignal.timeout(5000),
  });
  if (response.status !== expectedStatus) fail(`${path}: HTTP ${response.status}, expected ${expectedStatus}`);
  if (mime && !response.headers.get('content-type')?.toLowerCase().startsWith(mime)) fail(`${path}: wrong content type`);
  const size = Number(response.headers.get('content-length'));
  if (size > limit) fail(`${path}: response too large`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > limit) {
      await response.body?.cancel().catch(() => undefined);
      fail(`${path}: response too large`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function checkWebSocket() {
  const endpoint = new URL('ws', base);
  endpoint.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const requestId = randomUUID();
  const clientTime = Date.now();
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { maxPayload: limit, origin: base.origin, headers: { 'X-Real-IP': '127.0.0.1' }, handshakeTimeout: 5000 });
    const timer = setTimeout(() => finish(new Error('WebSocket timeout')), 5000);
    let done = false;
    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    }
    socket.on('error', finish);
    socket.on('open', () => socket.send(JSON.stringify({ version: 1, type: 'time:ping', requestId, clientTime })));
    socket.on('message', (data) => {
      if (data.length > limit) return finish(new Error('WebSocket response too large'));
      try {
        const pong = JSON.parse(data.toString());
        if (pong.version === 1 && pong.type === 'time:pong' && pong.requestId === requestId && pong.clientTime === clientTime && Number.isFinite(pong.serverTime) && pong.serverTime >= 0) finish();
        else finish(new Error('Invalid WebSocket pong'));
      } catch { finish(new Error('Invalid WebSocket response')); }
    });
    socket.on('close', () => finish(new Error('WebSocket closed before pong')));
  });
}

try {
  const ready = JSON.parse(await request('health/ready', 200, 'application/json'));
  if (ready.status !== 'ok' || ready.revision !== revision) fail('Readiness revision mismatch');
  const html = await request('', 200, 'text/html');
  const assets = [...html.matchAll(/(?:src|href)=["'](\/date-run\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js)["']/g)];
  if (assets.length !== 1) fail('Expected one hashed JavaScript asset');
  await request(assets[0][1], 200, 'text/javascript');
  await request('assets/__deploy_missing__.js', 404);
  await checkWebSocket();
} catch (error) {
  process.stderr.write(`Smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
