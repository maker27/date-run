import { createServer, type Server as HttpServer } from 'node:http';
import { RoomPreviewSchema } from '../../shared/model.js';
import { normalizeRoomCode } from '../../shared/room-code.js';
import { TokenBucket } from '../realtime/rate-limit.js';
import type { SessionStore } from '../realtime/session-store.js';
import { resolveClientIp, type ServerConfig } from './config.js';
import { sendStatus, serveStatic, setSecurityHeaders } from './static-files.js';

export interface HttpServerHandle {
  server: HttpServer;
  setShuttingDown(): void;
}

export function createHttpServer(store: SessionStore, config: ServerConfig, options: { clock?: () => number } = {}): HttpServerHandle {
  const clock = options.clock ?? (() => performance.now());
  const previews = new TokenBucket({ capacity: 60, refillPerSecond: 1 });
  let shuttingDown = false;
  const server = createServer((request, response) => {
    setSecurityHeaders(response);
    const ip = resolveClientIp(request, config);
    if (!ip) { sendStatus(response, 400); return; }
    const rawPath = (request.url ?? '').split('?', 1)[0] ?? '';
    if (rawPath === '/date-run/health/live' || rawPath === '/date-run/health/ready') {
      if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response); return; }
      const ready = rawPath.endsWith('/ready');
      sendJson(response, ready && shuttingDown ? 503 : 200, { status: ready && shuttingDown ? 'shutting_down' : 'ok', revision: config.revision }, request.method);
      return;
    }
    if (rawPath.startsWith('/date-run/api/rooms/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response); return; }
      if (shuttingDown) { sendJson(response, 503, { code: 'server_full' }, request.method); return; }
      if (!previews.take(ip, clock())) {
        response.setHeader('Retry-After', '1');
        sendJson(response, 429, { code: 'rate_limited' }, request.method);
        return;
      }
      let code: string | null = null;
      try { code = normalizeRoomCode(decodeURIComponent(rawPath.slice('/date-run/api/rooms/'.length))); }
      catch { /* Invalid room code has the same public result as an absent room. */ }
      const preview = code ? store.preview(code) : null;
      const valid = preview ? RoomPreviewSchema.safeParse(preview) : null;
      if (!valid?.success) { sendJson(response, 404, { code: 'room_not_found' }, request.method); return; }
      sendJson(response, 200, valid.data, request.method);
      return;
    }
    void serveStatic(request, response, config.clientRoot).catch(() => sendStatus(response, 500));
  });
  return { server, setShuttingDown() { shuttingDown = true; } };
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: object, method?: string): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(json));
  response.end(method === 'HEAD' ? undefined : json);
}

function methodNotAllowed(response: import('node:http').ServerResponse): void {
  response.setHeader('Allow', 'GET, HEAD');
  sendStatus(response, 405);
}
