import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { PlayerId, PlayerInput, RoomId, WorldSnapshot } from '../../shared/model.js';
import { ClientMessageSchema, type ClientMessage, type ServerMessage, type ServerReply } from '../../shared/protocol.js';
import { configureRoom, interact, returnToLobby, setReady, stepRoom, voteRematch } from '../game/game-state.js';
import type { GameState } from '../game/game-types.js';
import { InputQueue } from './input-queue.js';
import { RealtimeMetrics } from './metrics.js';
import { TokenBucket } from './rate-limit.js';
import { RequestCache } from './request-cache.js';
import { SessionStore, type Session, type StoreEvents } from './session-store.js';
import { SimulationLoop } from './simulation-loop.js';

const neutral: PlayerInput = { axis: 0, jumpPressed: false };
const backpressureLimit = 262_144;
type ErrorCode = Extract<ServerMessage, { type: 'error' }>['code'];
type RequestMessage = Exclude<ClientMessage, { type: 'input:update' }>;
interface Connection {
  id: string;
  socket: WebSocket;
  ip: string;
  openedAt: number;
  lastPong: number;
  lastPing: number;
  slowSince: number | null;
  violations: number[];
  inputBudget: TokenBucket;
  commandBudget: TokenBucket;
  cache: RequestCache<ServerReply>;
  closing: boolean;
  closeDeadline: number | null;
}
export interface RealtimeOptions {
  allowedOrigins: readonly string[];
  clock?: () => number;
  livenessClock?: () => number;
  resolveClientIp?: (request: IncomingMessage) => string | null;
  autoSchedule?: boolean;
}
export interface RealtimeHandle {
  close(): Promise<void>;
  advance(now: number): void;
  makeSnapshot(roomId: RoomId): WorldSnapshot | undefined;
  metrics: RealtimeMetrics;
}
export function makeSnapshot(room: GameState, store: SessionStore, now: number): WorldSnapshot {
  const snapshot = store.snapshot(room.roomId, now);
  if (!snapshot) throw new Error('Room missing from session store');
  return snapshot;
}
export function attachWebSocketServer(httpServer: HttpServer, store: SessionStore, options: RealtimeOptions): RealtimeHandle {
  const clock = options.clock ?? (() => performance.now());
  const livenessClock = options.livenessClock ?? clock;
  const resolveIp = options.resolveClientIp ?? ((request: IncomingMessage) => request.socket.remoteAddress ?? null);
  const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16_384 });
  const connections = new Map<string, Connection>();
  const queues = new Map<PlayerId, InputQueue>();
  const sessionCaches = new Map<PlayerId, RequestCache<ServerReply>>();
  const authBudget = new TokenBucket({ capacity: 240, refillPerSecond: 5 });
  const metrics = new RealtimeMetrics(() => ({
    queuedInputs: [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    socketCount: store.countSockets(), roomCount: store.rooms().length, occupiedPlaces: store.countOccupiedPlaces(),
  }));
  let closing = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closePromise: Promise<void> | undefined;
  const send = (connection: Connection, message: ServerMessage): void => {
    if (connection.socket.readyState === WebSocket.OPEN && !connection.closing) connection.socket.send(JSON.stringify(message));
  };
  const closeSocket = (connection: Connection, code: number): void => {
    if (connection.closing) return;
    connection.closing = true;
    connection.closeDeadline = livenessClock() + 1000;
    revoke(connection);
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.close(code);
    else if (connection.socket.readyState === WebSocket.CONNECTING) connection.socket.terminate();
  };
  const broadcast = (roomId: RoomId, type: 'room:state' | 'round:start' | 'world:update' | 'room:complete', now: number): void => {
    const snapshot = store.snapshot(roomId, now);
    if (!snapshot) return;
    const payload = JSON.stringify({ version: 1, type, snapshot });
    for (const connection of connections.values()) {
      if (connection.closing || connection.socket.readyState !== WebSocket.OPEN) continue;
      if (store.getSessionBySocket(connection.id)?.roomId !== roomId) continue;
      if (type === 'world:update' && connection.socket.bufferedAmount > backpressureLimit) {
        metrics.backpressureSkips += 1;
        connection.slowSince ??= now;
        continue;
      }
      connection.socket.send(payload);
    }
  };
  const processEvents = (events: StoreEvents, now: number): void => {
    for (const roomId of events.warnings) {
      for (const connection of connections.values()) if (store.getSessionBySocket(connection.id)?.roomId === roomId) {
        send(connection, { version: 1, type: 'room:closing', reason: 'idle', remainingMs: 60_000 });
      }
    }
    for (const id of events.expiredSocketIds) {
      const connection = connections.get(id);
      if (connection) closeSocket(connection, 4002);
    }
    for (const roomId of events.changed) broadcast(roomId, 'room:state', now);
    for (const playerId of [...queues.keys()]) if (!store.getSession(playerId)) { queues.delete(playerId); sessionCaches.delete(playerId); }
    for (const playerId of [...sessionCaches.keys()]) if (!store.getSession(playerId)) sessionCaches.delete(playerId);
  };
  const flushEvents = (now: number): void => processEvents(store.expire(now), now);
  const revoke = (connection: Connection): void => {
    const session = store.getSessionBySocket(connection.id);
    const roomId = session?.roomId;
    store.disconnect(connection.id);
    if (roomId) {
      for (const member of store.sessions(roomId)) queues.get(member.playerId)?.reset();
      broadcast(roomId, 'room:state', clock());
    }
  };
  const detach = (connection: Connection): void => {
    if (!connections.has(connection.id)) return;
    revoke(connection);
    connections.delete(connection.id);
    store.unregisterSocket(connection.id);
  };
  const error = (connection: Connection, code: ErrorCode, requestId?: string): void => {
    const reply: ServerMessage = requestId === undefined
      ? { version: 1, type: 'error', code }
      : { version: 1, type: 'error', code, requestId };
    send(connection, reply);
  };
  const rateViolation = (connection: Connection, now: number, message?: RequestMessage): void => {
    connection.violations = connection.violations.filter((at) => now - at < 10_000);
    connection.violations.push(now);
    if (message) {
      const session = store.getSessionBySocket(connection.id);
      const cached = connection.cache.lookup(message.requestId, message, now);
      const sessionCached = cached.kind === 'miss' && session
        ? sessionCaches.get(session.playerId)?.lookup(message.requestId, message, now) : undefined;
      if (cached.kind === 'conflict' || sessionCached?.kind === 'conflict') error(connection, 'invalid_message', message.requestId);
      else if (cached.kind === 'hit') send(connection, cached.response);
      else if (sessionCached?.kind === 'hit') reply(connection, message, sessionCached.response, now);
      else {
        const response: ServerReply = { version: 1, type: 'error', requestId: message.requestId, code: 'rate_limited' };
        reply(connection, message, response, now, session);
      }
    } else error(connection, 'rate_limited');
    if (connection.violations.length >= 3) closeSocket(connection, 1008);
  };
  const ensureQueue = (session: Session): InputQueue => {
    let queue = queues.get(session.playerId);
    if (!queue) {
      queue = new InputQueue(session, () => store.getRoom(session.roomId)?.epoch ?? -1);
      queues.set(session.playerId, queue);
    }
    return queue;
  };
  const reply = (connection: Connection, message: RequestMessage, response: ServerReply, now: number, session?: Session): void => {
    connection.cache.record(message.requestId, message, response, now);
    if (session) {
      let cache = sessionCaches.get(session.playerId);
      if (!cache) { cache = new RequestCache<ServerReply>(); sessionCaches.set(session.playerId, cache); }
      cache.record(message.requestId, message, response, now);
    }
    send(connection, response);
  };
  const onRequest = (connection: Connection, message: RequestMessage, now: number): void => {
    if (!connection.commandBudget.take(connection.id, now)) { rateViolation(connection, now, message); return; }
    if (message.type === 'room:create' || message.type === 'room:join' || message.type === 'room:rejoin') {
      if (!authBudget.take(connection.ip, now)) { rateViolation(connection, now, message); return; }
    }
    const connectionCache = connection.cache.lookup(message.requestId, message, now);
    if (connectionCache.kind === 'conflict') { error(connection, 'invalid_message', message.requestId); return; }
    if (connectionCache.kind === 'hit') { send(connection, connectionCache.response); return; }
    const current = store.getSessionBySocket(connection.id);
    if (current) {
      const sessionCache = sessionCaches.get(current.playerId)?.lookup(message.requestId, message, now);
      if (sessionCache?.kind === 'conflict') { error(connection, 'invalid_message', message.requestId); return; }
      if (sessionCache?.kind === 'hit') { reply(connection, message, sessionCache.response, now); return; }
    }
    if (message.type === 'time:ping') {
      reply(connection, message, { version: 1, type: 'time:pong', requestId: message.requestId, clientTime: message.clientTime, serverTime: now }, now, current);
      return;
    }
    if (message.type === 'room:create' || message.type === 'room:join' || message.type === 'room:rejoin') {
      if (current) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: 'invalid_phase' }, now, current); return; }
      const joined = message.type === 'room:create' ? store.create(message.themeId, message.role, connection.id)
        : message.type === 'room:join' ? store.join(message.roomId, connection.id) : store.rejoin(message.sessionToken, connection.id);
      if (!joined.ok) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: joined.code }, now); flushEvents(now); return; }
      if (joined.replacedSocketId) {
        const replaced = connections.get(joined.replacedSocketId);
        if (replaced) { send(replaced, { version: 1, type: 'session:replaced' }); closeSocket(replaced, 4001); }
      }
      ensureQueue(joined.session).reset();
      const response: ServerReply = { version: 1, type: 'room:joined', requestId: message.requestId,
        credential: store.credential(joined.session), rejoinState: { inputGeneration: joined.session.inputGeneration, nextSeq: joined.session.lastAcceptedSeq + 1 },
        snapshot: makeSnapshot(joined.room, store, now) };
      reply(connection, message, response, now, joined.session);
      broadcast(joined.session.roomId, 'room:state', now);
      flushEvents(now);
      return;
    }
    if (!current) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: 'not_in_room' }, now); return; }
    const room = store.getRoom(current.roomId);
    if (!room) { error(connection, 'session_expired', message.requestId); return; }
    if (message.type === 'room:resync' || message.type === 'player:suspend') {
      if (message.type === 'player:suspend' && message.epoch !== room.epoch) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: 'stale_epoch' }, now, current); return; }
      const rejoinState = store.resync(current);
      current.suspended = message.type === 'player:suspend';
      ensureQueue(current).reset();
      reply(connection, message, { version: 1, type: 'room:resynced', requestId: message.requestId, rejoinState, snapshot: makeSnapshot(room, store, now) }, now, current);
      return;
    }
    if (message.type === 'world:interact') {
      if (message.epoch !== room.epoch) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: 'stale_epoch' }, now, current); return; }
      const result = interact(room, current.playerId, message.objectId);
      store.setRoom(result.state);
      reply(connection, message, { version: 1, type: 'world:interact:result', requestId: message.requestId, epoch: room.epoch, objectId: message.objectId, outcome: result.outcome }, now, current);
      if (result.state !== room) broadcast(room.roomId, 'room:state', now);
      return;
    }
    if (message.type === 'room:leave') {
      const response: ServerReply = { version: 1, type: 'command:result', requestId: message.requestId, command: message.type, outcome: 'ok' };
      reply(connection, message, response, now, current);
      const roomId = current.roomId;
      store.leave(current);
      queues.delete(current.playerId);
      sessionCaches.delete(current.playerId);
      broadcast(roomId, 'room:state', now);
      return;
    }
    const result = message.type === 'room:configure' ? configureRoom(room, current.playerId, message.themeId, message.hostRole)
      : message.type === 'player:ready' ? setReady(room, current.playerId, message.ready)
        : message.type === 'room:rematch' ? voteRematch(room, current.playerId) : returnToLobby(room, current.playerId);
    if (!result.ok) { reply(connection, message, { version: 1, type: 'error', requestId: message.requestId, code: result.code }, now, current); return; }
    store.setRoom(result.state);
    store.touch(room.roomId);
    reply(connection, message, { version: 1, type: 'command:result', requestId: message.requestId, command: message.type, outcome: 'ok' }, now, current);
    broadcast(room.roomId, room.phase !== 'playing' && result.state.phase === 'playing' ? 'round:start' : 'room:state', now);
    flushEvents(now);
  };
  const onMessage = (connection: Connection, data: RawData, isBinary: boolean): void => {
    if (connection.closing || connection.socket.readyState !== WebSocket.OPEN) return;
    if (isBinary) { error(connection, 'invalid_message'); closeSocket(connection, 4003); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString()); }
    catch { error(connection, 'invalid_message'); closeSocket(connection, 4003); return; }
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && parsed.version !== 1) {
      error(connection, 'unsupported_version'); closeSocket(connection, 4003); return;
    }
    const validated = ClientMessageSchema.safeParse(parsed);
    if (!validated.success) { error(connection, 'invalid_message'); closeSocket(connection, 4003); return; }
    const message = validated.data;
    const now = clock();
    if (message.type === 'input:update') {
      if (!connection.inputBudget.take(connection.id, now)) { rateViolation(connection, now); return; }
      const session = store.getSessionBySocket(connection.id);
      if (!session) { error(connection, 'not_in_room'); return; }
      const room = store.getRoom(session.roomId);
      if (!room || room.phase !== 'playing' || room.paused) { error(connection, 'invalid_phase'); return; }
      const outcome = ensureQueue(session).enqueue(message);
      if (outcome.kind === 'rejected') error(connection, outcome.code);
      return;
    }
    onRequest(connection, message, now);
  };
  const step = (): void => {
    const now = clock();
    for (const room of store.rooms()) {
      if (room.phase !== 'playing') continue;
      const inputs = new Map<PlayerId, PlayerInput>();
      if (!room.paused) for (const session of store.sessions(room.roomId)) inputs.set(session.playerId, ensureQueue(session).consume()?.input ?? neutral);
      const next = stepRoom(room, inputs, now);
      store.setRoom(next);
      if (room.phase !== next.phase) broadcast(room.roomId, 'room:complete', now);
    }
    metrics.steps += 1;
  };
  const periodic = (): void => { const now = clock(); for (const room of store.rooms()) if (room.phase === 'playing') broadcast(room.roomId, 'world:update', now); };
  const loop = new SimulationLoop({ clock, step, snapshot: periodic, onDropped: (ms) => { metrics.droppedSimulationMs += ms; }, onTickDuration: (ms) => metrics.recordTick(ms) });
  const advance = (now: number): void => {
    if (closing) return;
    loop.advance(now);
    const livenessNow = livenessClock();
    for (const connection of connections.values()) {
      if (connection.closing) {
        if (connection.closeDeadline !== null && livenessNow >= connection.closeDeadline) connection.socket.terminate();
        continue;
      }
      if (!store.getSessionBySocket(connection.id) && livenessNow - connection.openedAt >= 5000) { closeSocket(connection, 1008); continue; }
      if (livenessNow - connection.lastPong >= 20_000) { closeSocket(connection, 1001); continue; }
      if (connection.socket.bufferedAmount > backpressureLimit) {
        connection.slowSince ??= livenessNow;
        if (livenessNow - connection.slowSince >= 5000) { closeSocket(connection, 1013); continue; }
      } else connection.slowSince = null;
      if (livenessNow - connection.lastPing >= 10_000) { connection.lastPing = livenessNow; connection.socket.ping(); }
    }
    flushEvents(now);
    authBudget.evict(now);
  };
  const rejectUpgrade = (socket: Socket, status: number): void => {
    socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (closing) { rejectUpgrade(socket, 503); return; }
    if (request.url !== '/date-run/ws') { rejectUpgrade(socket, 404); return; }
    if (!request.headers.origin || !options.allowedOrigins.includes(request.headers.origin)) { rejectUpgrade(socket, 403); return; }
    const ip = resolveIp(request);
    if (!ip) { rejectUpgrade(socket, 403); return; }
    const id = randomUUID();
    if (!store.registerSocket(id)) { rejectUpgrade(socket, 503); return; }
    let reserved = true;
    const releaseReservation = (): void => {
      if (!reserved) return;
      reserved = false;
      store.unregisterSocket(id);
    };
    socket.once('close', releaseReservation);
    try {
      server.handleUpgrade(request, socket, head, (ws) => {
        reserved = false;
        socket.off('close', releaseReservation);
        const openedAt = livenessClock();
        const connection: Connection = { id, socket: ws, ip, openedAt, lastPong: openedAt, lastPing: openedAt, slowSince: null,
          violations: [], inputBudget: new TokenBucket({ capacity: 90, refillPerSecond: 90, maxKeys: 1 }),
          commandBudget: new TokenBucket({ capacity: 10, refillPerSecond: 10, maxKeys: 1 }), cache: new RequestCache<ServerReply>(), closing: false, closeDeadline: null };
        connections.set(id, connection);
        ws.on('message', (data, isBinary) => onMessage(connection, data, isBinary));
        ws.on('pong', () => { connection.lastPong = livenessClock(); });
        ws.on('close', () => detach(connection));
        ws.on('error', () => closeSocket(connection, 1011));
      });
    } catch { releaseReservation(); socket.destroy(); }
  };
  httpServer.on('upgrade', onUpgrade);
  httpServer.once('close', () => httpServer.off('upgrade', onUpgrade));
  if (options.autoSchedule !== false) interval = setInterval(() => advance(clock()), 10);
  return {
    advance,
    makeSnapshot: (roomId) => store.snapshot(roomId, clock()),
    metrics,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      if (interval) clearInterval(interval);
      loop.stop();
      closePromise = new Promise<void>((resolve) => {
        for (const connection of connections.values()) {
          send(connection, { version: 1, type: 'room:closing', reason: 'restart', remainingMs: 0 });
          closeSocket(connection, 1012);
        }
        const timer = setTimeout(() => { for (const socket of server.clients) socket.terminate(); }, 1000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
      return closePromise;
    },
  };
}
