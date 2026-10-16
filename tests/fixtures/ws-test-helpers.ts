import { createServer, type Server as HttpServer } from 'node:http';
import WebSocket, { type RawData } from 'ws';
import type { ServerMessage } from '../../src/shared/protocol.js';
import { ServerMessageSchema } from '../../src/shared/protocol.js';
import { SessionStore } from '../../src/server/realtime/session-store.js';
import { attachWebSocketServer } from '../../src/server/realtime/ws-server.js';
import { SHORT_LEVEL } from './short-level.js';

export const TEST_ORIGIN = 'https://date-run.test';
const closeCodes = new WeakMap<WebSocket, number>();

export interface BufferedClient {
  socket: WebSocket;
  waitFor(predicate: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  send(message: object): Promise<void>;
  received: ServerMessage[];
}

export async function openClient(url: string, origin = TEST_ORIGIN, autoPong = true): Promise<BufferedClient> {
  const socket = new WebSocket(url, { origin, autoPong });
  const received: ServerMessage[] = [];
  const waiters: Array<{ predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let cursor = 0;
  socket.on('close', (code) => closeCodes.set(socket, code));

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return;
    const raw: unknown = JSON.parse(data.toString());
    const message = ServerMessageSchema.parse(raw);
    received.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || !waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  });

  await waitForOpen(socket);
  return {
    socket,
    received,
    send(message) {
      return new Promise((resolve, reject) => {
        socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve());
      });
    },
    waitFor(predicate, timeoutMs = 1500) {
      for (let index = cursor; index < received.length; index += 1) {
        const previous = received[index];
        if (previous && predicate(previous)) {
          cursor = index + 1;
          return Promise.resolve(previous);
        }
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (message: ServerMessage) => { cursor = received.indexOf(message) + 1; resolve(message); },
          timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for websocket message (${timeoutMs}ms)`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

export async function closeClient(client: BufferedClient): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) return;
  client.socket.close();
  const closed = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1200);
    client.socket.once('close', () => { clearTimeout(timer); resolve(true); });
  });
  if (!closed) client.socket.terminate();
}

export function waitForClientClose(socket: WebSocket, timeoutMs = 1500): Promise<number> {
  const closed = closeCodes.get(socket);
  if (closed !== undefined) return Promise.resolve(closed);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket close timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

export async function createRealtimeFixture(options: { socketLimit?: number; autoSchedule?: boolean } = {}) {
  let now = 0;
  let id = 0;
  const store = new SessionStore({
    clock: () => now,
    level: SHORT_LEVEL,
    limits: { rooms: 100, places: 200, sockets: options.socketLimit ?? 240 },
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    roomCode: () => 'ABCDEFGH',
  });
  const httpServer: HttpServer = createServer();
  const handle = attachWebSocketServer(httpServer, store, {
    allowedOrigins: [TEST_ORIGIN],
    clock: () => now,
    autoSchedule: options.autoSchedule ?? false,
  });
  let address: ReturnType<HttpServer['address']>;
  try {
    await listen(httpServer);
    address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture has no TCP address');
  } catch (error) {
    await handle.close();
    if (httpServer.listening) await closeHttpServer(httpServer);
    throw error;
  }
  return {
    store,
    handle,
    url: `ws://127.0.0.1:${address.port}/date-run/ws`,
    setNow(value: number) { now = value; },
    async close(clients: readonly BufferedClient[] = []) {
      await Promise.all(clients.map(closeClient));
      try {
        await handle.close();
      } finally {
        if (httpServer.listening) await closeHttpServer(httpServer);
      }
    },
  };
}

function waitForOpen(socket: WebSocket, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`WebSocket open timed out after ${timeoutMs}ms`)), timeoutMs);
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number) => finish(new Error(`WebSocket closed before open (${code})`));

    function finish(error?: Error): void {
      clearTimeout(timer);
      socket.removeListener('open', onOpen);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (error) {
        socket.terminate();
        reject(error);
      } else {
        resolve();
      }
    }

    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function listen(server: HttpServer, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`HTTP fixture listen timed out after ${timeoutMs}ms`)), timeoutMs);
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
    try {
      server.listen(0, '127.0.0.1');
    } catch (error) {
      finish(error instanceof Error ? error : new Error('HTTP fixture failed to listen'));
    }
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function requestId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
