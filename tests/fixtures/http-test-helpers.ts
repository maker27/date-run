import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/server/realtime/session-store.js';
import { SHORT_LEVEL } from './short-level.js';

const timeoutMs = 2000;

export interface HttpFixture {
  root: string;
  server: Server;
  origin: string;
  store: SessionStore;
  close(): Promise<void>;
}

export async function createHttpFixture(
  handler: (request: IncomingMessage, response: ServerResponse, root: string, store: SessionStore) => Promise<void>,
): Promise<HttpFixture> {
  const root = await mkdtemp(join(tmpdir(), 'date-run-http-'));
  const outsideRoot = await mkdtemp(join(tmpdir(), 'date-run-outside-'));
  const outsideFile = join(outsideRoot, 'outside.js');
  const assetDirectory = join(root, 'assets');
  await mkdir(assetDirectory);
  await Promise.all([
    writeFile(join(root, 'index.html'), '<!doctype html><title>fixture</title>'),
    writeFile(join(assetDirectory, 'app-a1b2c3d4.js'), 'export const fixture = true;'),
    writeFile(join(assetDirectory, 'style.css'), 'body { color: black; }'),
    writeFile(outsideFile, 'outside-root-secret'),
    symlink(outsideFile, join(root, 'outside-link.js')),
  ]);

  let uuid = 0;
  const store = new SessionStore({
    clock: () => 0,
    level: SHORT_LEVEL,
    uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    roomCode: () => 'ABCDEFGH',
  });
  const activeResponses = new Set<ServerResponse>();
  let closing = false;
  let closeFailure: ((error: Error) => void) | undefined;
  const server = createServer((request, response) => {
    activeResponses.add(response);
    response.once('finish', () => {
      activeResponses.delete(response);
      if (closing) server.closeIdleConnections();
    });
    response.once('close', () => {
      activeResponses.delete(response);
      if (closing && !response.writableFinished) closeFailure?.(new Error('HTTP fixture response aborted during close'));
    });
    response.once('error', (error: Error) => {
      activeResponses.delete(response);
      if (closing) closeFailure?.(error);
    });
    void handler(request, response, root, store).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('HTTP fixture listen timed out')), timeoutMs);
      const onError = (error: Error) => finish(error);
      const onListening = () => finish();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        server.removeListener('error', onError);
        server.removeListener('listening', onListening);
        if (error) reject(error);
        else resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture has no TCP address');
    return {
      root,
      server,
      origin: `http://127.0.0.1:${address.port}`,
      store,
      async close() {
        try {
          closing = true;
          await closeServer(server, activeResponses, (reject) => { closeFailure = reject; });
        } finally {
          await Promise.all([rm(root, { recursive: true, force: true }), rm(outsideRoot, { recursive: true, force: true })]);
        }
      },
    };
  } catch (error) {
    if (server.listening) await closeServer(server, activeResponses);
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outsideRoot, { recursive: true, force: true })]);
    throw error;
  }
}

export async function requestRawPath(origin: string, path: string, method = 'GET', headers: Record<string, string> = {}): Promise<Response> {
  const target = new URL(origin);
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => client.destroy(new Error('HTTP request timed out')), timeoutMs);
    const client = request({ hostname: target.hostname, port: Number(target.port), method, path, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('error', finishError);
      incoming.once('end', () => {
        clearTimeout(timer);
        resolve(new Response(Buffer.concat(chunks), {
          status: incoming.statusCode ?? 0,
          headers: responseHeaders(incoming.headers),
        }));
      });
    });
    function finishError(error: Error): void {
      clearTimeout(timer);
      reject(error);
    }
    client.once('error', finishError);
    client.end();
  });
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.append(name, value);
    }
  }
  return result;
}

async function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>, onFailure?: (reject: (error: Error) => void) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish(new Error('HTTP fixture close timed out'));
    }, timeoutMs);
    onFailure?.((error) => { server.closeAllConnections(); finish(error); });
    server.close((error) => {
      if (error) { finish(error); return; }
      if ([...activeResponses].some((response) => !response.writableFinished)) {
        finish(new Error('HTTP fixture response aborted during close'));
        return;
      }
      finish();
    });
    server.closeIdleConnections();
  });
}
