import { open, realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
}

export function sendStatus(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}

export async function serveStatic(request: IncomingMessage, response: ServerResponse, clientRoot: string): Promise<void> {
  setSecurityHeaders(response);
  const rawUrl = request.url ?? '';
  const question = rawUrl.indexOf('?');
  const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
  if (rawPath === '/date-run') {
    if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response); return; }
    response.writeHead(308, { Location: `/date-run/${question < 0 ? '' : rawUrl.slice(question)}`, 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (!rawPath.startsWith('/date-run/')) { sendStatus(response, 404); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { methodNotAllowed(response); return; }

  const relativePath = rawPath.slice('/date-run/'.length);
  let segments: string[];
  try { segments = relativePath.split('/').map((part) => decodeURIComponent(part)); }
  catch { sendStatus(response, 400); return; }
  if (segments.some((part) => part === '.' || part === '..' || part.includes('/') || part.includes('\\') || part.includes('\0'))) {
    sendStatus(response, 404); return;
  }
  const assetPath = segments.join('/');
  const extension = extname(assetPath).toLowerCase();
  const isAppRoute = assetPath === '' || (!extension && !assetPath.startsWith('assets/') && request.headers.accept?.includes('text/html'));
  const filename = isAppRoute ? 'index.html' : assetPath;
  const mime = mimeTypes[extname(filename).toLowerCase()];
  if (!mime || !filename || filename.endsWith('/')) { sendStatus(response, 404); return; }
  try {
    const root = await realpath(clientRoot);
    const actual = await realpath(join(root, filename));
    const contained = relative(root, actual);
    if (contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) { sendStatus(response, 404); return; }
    const handle = await open(actual, 'r');
    try {
      const file = await handle.stat();
      if (!file.isFile()) { sendStatus(response, 404); return; }
      if (file.size > 0) {
        const probe = await handle.read(Buffer.alloc(1), 0, 1, 0);
        if (probe.bytesRead !== 1) throw new Error('Static file changed before streaming');
      }
      if (request.aborted || response.destroyed) return;
      response.statusCode = 200;
      response.setHeader('Content-Type', mime);
      response.setHeader('Content-Length', file.size);
      response.setHeader('Cache-Control', filename === 'index.html' ? 'no-store' : /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(filename) ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = handle.createReadStream({ autoClose: false });
      const abort = () => stream.destroy();
      request.once('aborted', abort);
      response.once('close', abort);
      try { await pipeline(stream, response); }
      finally { request.off('aborted', abort); response.off('close', abort); }
    } finally { await handle.close(); }
  } catch (error) {
    if (response.destroyed || request.aborted) return;
    if (isMissing(error)) sendStatus(response, 404);
    else sendStatus(response, 500);
  }
}

function methodNotAllowed(response: ServerResponse): void {
  response.setHeader('Allow', 'GET, HEAD');
  sendStatus(response, 405);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
