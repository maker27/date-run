import { randomInt, randomUUID } from 'node:crypto';
import { LEVEL, type LevelDefinition } from '../../shared/level.js';
import type { Credential, PlayerId, RejoinState, Role, RoomId, RoomPreview, ThemeId, WorldSnapshot } from '../../shared/model.js';
import { spawnBody } from '../../shared/movement.js';
import { createRoom, disconnectPlayer, joinRoom, leaveRoom, projectGameplay, reconnectPlayer } from '../game/game-state.js';
import type { DomainPlayer, GameState } from '../game/game-types.js';

const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reserveMs = 30_000;
const warningMs = 29 * 60_000;
const idleMs = 30 * 60_000;

function randomRoomCode(): RoomId {
  let code = '';
  for (let index = 0; index < 8; index += 1) code += codeAlphabet[randomInt(codeAlphabet.length)];
  return code;
}

export interface Session {
  roomId: RoomId;
  playerId: PlayerId;
  sessionToken: string;
  activeSocketId: string | null;
  reserveDeadline: number | null;
  inputGeneration: number;
  lastAcceptedSeq: number;
  lastProcessedSeq: number;
  suspended: boolean;
}

export type JoinResult =
  | { ok: true; session: Session; room: GameState; replacedSocketId: string | null }
  | { ok: false; code: 'room_full' | 'room_not_found' | 'session_expired' | 'server_full' | 'invalid_phase' | 'not_in_room' };

export interface StoreEvents {
  warnings: RoomId[];
  closed: RoomId[];
  changed: RoomId[];
  expiredSocketIds: string[];
}

interface StoreOptions {
  clock: () => number;
  level?: LevelDefinition;
  uuid?: () => string;
  roomCode?: () => RoomId;
  limits?: { rooms: number; places: number; sockets: number };
}

interface RoomEntry {
  state: GameState;
  lastActivity: number;
  warned: boolean;
}

function emptyEvents(): StoreEvents {
  return { warnings: [], closed: [], changed: [], expiredSocketIds: [] };
}

function mergeEvents(target: StoreEvents, incoming: StoreEvents): void {
  for (const field of ['warnings', 'closed', 'changed', 'expiredSocketIds'] as const) {
    for (const value of incoming[field]) if (!target[field].includes(value)) target[field].push(value);
  }
}

export class SessionStore {
  private readonly roomMap = new Map<RoomId, RoomEntry>();
  private readonly tokenMap = new Map<string, Session>();
  private readonly playerMap = new Map<PlayerId, Session>();
  private readonly socketMap = new Map<string, Session>();
  private readonly registeredSockets = new Set<string>();
  private pendingEvents = emptyEvents();
  private readonly level: LevelDefinition;
  private readonly uuid: () => string;
  private readonly roomCode: () => RoomId;
  private readonly limits: { rooms: number; places: number; sockets: number };

  constructor(private readonly options: StoreOptions) {
    this.level = options.level ?? LEVEL;
    this.uuid = options.uuid ?? randomUUID;
    this.roomCode = options.roomCode ?? randomRoomCode;
    this.limits = options.limits ?? { rooms: 100, places: 200, sockets: 240 };
  }

  registerSocket(socketId: string): boolean {
    if (this.registeredSockets.has(socketId)) return true;
    if (this.registeredSockets.size >= this.limits.sockets) return false;
    this.registeredSockets.add(socketId);
    return true;
  }

  unregisterSocket(socketId: string): void {
    this.disconnect(socketId);
    this.registeredSockets.delete(socketId);
  }

  create(themeId: ThemeId, role: Role, socketId: string): JoinResult {
    this.sweepAutomatically();
    const socketError = this.socketError(socketId);
    if (socketError) return socketError;
    if (this.roomMap.size >= this.limits.rooms || this.playerMap.size >= this.limits.places) return { ok: false, code: 'server_full' };
    let roomId: RoomId | undefined;
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = this.roomCode();
      if (!this.roomMap.has(candidate)) {
        roomId = candidate;
        break;
      }
    }
    if (!roomId) return { ok: false, code: 'server_full' };
    const session = this.newSession(roomId, socketId);
    const player: DomainPlayer = {
      id: session.playerId, role, connected: true, ready: false, rematch: false,
      body: spawnBody(role, this.level),
    };
    const room = createRoom(roomId, themeId, player, this.level);
    this.roomMap.set(roomId, { state: room, lastActivity: this.options.clock(), warned: false });
    this.bindSession(session);
    return { ok: true, session, room, replacedSocketId: null };
  }

  join(code: RoomId, socketId: string): JoinResult {
    this.sweepAutomatically();
    const socketError = this.socketError(socketId);
    if (socketError) return socketError;
    const entry = this.roomMap.get(code);
    if (!entry) return { ok: false, code: 'room_not_found' };
    if (entry.state.players.length >= 2) return { ok: false, code: 'room_full' };
    if (this.playerMap.size >= this.limits.places) return { ok: false, code: 'server_full' };
    const role = entry.state.players.some(({ role: occupied }) => occupied === 'a') ? 'b' : 'a';
    const session = this.newSession(code, socketId);
    const player: DomainPlayer = {
      id: session.playerId, role, connected: true, ready: false, rematch: false,
      body: spawnBody(role, this.level),
    };
    const result = joinRoom(entry.state, player);
    if (!result.ok) return { ok: false, code: 'invalid_phase' };
    this.setRoom(result.state);
    this.bindSession(session);
    this.touch(code);
    return { ok: true, session, room: result.state, replacedSocketId: null };
  }

  rejoin(token: string, socketId: string): JoinResult {
    this.sweepAutomatically();
    const socketError = this.socketError(socketId);
    if (socketError) return socketError;
    const session = this.tokenMap.get(token);
    if (!session) return { ok: false, code: 'session_expired' };
    const entry = this.roomMap.get(session.roomId);
    if (!entry) return { ok: false, code: 'session_expired' };
    const replacedSocketId = session.activeSocketId && session.activeSocketId !== socketId ? session.activeSocketId : null;
    if (replacedSocketId) this.socketMap.delete(replacedSocketId);
    session.activeSocketId = socketId;
    session.reserveDeadline = null;
    session.inputGeneration += 1;
    session.suspended = false;
    this.socketMap.set(socketId, session);
    const result = reconnectPlayer(entry.state, session.playerId);
    if (!result.ok) throw new Error('Session and room out of sync');
    this.setRoom(result.state);
    this.touch(session.roomId);
    return { ok: true, session, room: result.state, replacedSocketId };
  }

  disconnect(socketId: string): void {
    const session = this.socketMap.get(socketId);
    if (!session) return;
    this.socketMap.delete(socketId);
    session.activeSocketId = null;
    session.reserveDeadline = this.options.clock() + reserveMs;
    session.suspended = false;
    const entry = this.roomMap.get(session.roomId);
    if (!entry) return;
    const result = disconnectPlayer(entry.state, session.playerId);
    if (result.ok) this.setRoom(result.state);
  }

  leave(session: Session): void {
    if (this.playerMap.get(session.playerId) !== session) return;
    this.tokenMap.delete(session.sessionToken);
    this.playerMap.delete(session.playerId);
    if (session.activeSocketId) this.socketMap.delete(session.activeSocketId);
    session.activeSocketId = null;
    session.reserveDeadline = null;
    const entry = this.roomMap.get(session.roomId);
    if (!entry) return;
    const result = leaveRoom(entry.state, session.playerId);
    if (!result.ok) return;
    if (result.state.players.length === 0) this.roomMap.delete(session.roomId);
    else this.setRoom(result.state);
  }

  preview(code: RoomId): RoomPreview | null {
    const state = this.roomMap.get(code)?.state;
    if (!state) return null;
    return {
      roomId: code, themeId: state.themeId, phase: state.phase,
      occupiedPlaces: state.players.length,
      availableRole: state.players.length === 2 ? null : state.players.some(({ role }) => role === 'a') ? 'b' : 'a',
    };
  }

  getRoom(roomId: RoomId): GameState | undefined {
    return this.roomMap.get(roomId)?.state;
  }

  getSessionBySocket(socketId: string): Session | undefined {
    return this.socketMap.get(socketId);
  }

  getSession(playerId: PlayerId): Session | undefined {
    return this.playerMap.get(playerId);
  }

  rooms(): readonly GameState[] {
    return [...this.roomMap.values()].map(({ state }) => state);
  }

  sessions(roomId: RoomId): readonly Session[] {
    return [...this.playerMap.values()].filter((session) => session.roomId === roomId);
  }

  countOccupiedPlaces(): number {
    return this.playerMap.size;
  }

  countSockets(): number {
    return this.registeredSockets.size;
  }

  setRoom(state: GameState): void {
    const entry = this.roomMap.get(state.roomId);
    if (!entry) return;
    if (state.epoch !== entry.state.epoch || (entry.state.phase === 'playing' && !entry.state.paused && state.paused)) {
      for (const session of this.sessions(state.roomId)) {
        session.inputGeneration += 1;
        session.suspended = false;
      }
    }
    if ((entry.state.phase === 'ready' || entry.state.phase === 'playing') &&
      state.phase !== 'ready' && state.phase !== 'playing') {
      entry.lastActivity = this.options.clock();
      entry.warned = false;
    }
    entry.state = state;
  }

  touch(roomId: RoomId): void {
    const entry = this.roomMap.get(roomId);
    if (!entry) return;
    entry.lastActivity = this.options.clock();
    entry.warned = false;
    this.pendingEvents.warnings = this.pendingEvents.warnings.filter((pendingRoomId) => pendingRoomId !== roomId);
  }

  resync(session: Session): RejoinState {
    session.inputGeneration += 1;
    session.suspended = false;
    return { inputGeneration: session.inputGeneration, nextSeq: session.lastAcceptedSeq + 1 };
  }

  credential(session: Session): Credential {
    return {
      schemaVersion: 1, roomId: session.roomId, playerId: session.playerId,
      sessionToken: session.sessionToken, nextSeq: session.lastAcceptedSeq + 1,
    };
  }

  snapshot(roomId: RoomId, now: number): WorldSnapshot | undefined {
    const room = this.getRoom(roomId);
    if (!room) return undefined;
    const state = projectGameplay(room);
    return {
      roomId, epoch: room.epoch, tick: room.tick, revision: room.revision, serverTime: now,
      state: {
        ...state,
        players: state.players.map((player) => {
          const session = this.playerMap.get(player.id);
          if (!session) throw new Error('Missing session for domain player');
          return {
            ...player, inputGeneration: session.inputGeneration,
            lastAcceptedSeq: session.lastAcceptedSeq, lastProcessedSeq: session.lastProcessedSeq,
          };
        }),
      },
    };
  }

  expire(now: number): StoreEvents {
    const events = this.pendingEvents;
    this.pendingEvents = emptyEvents();
    mergeEvents(events, this.sweep(now));
    return events;
  }

  private sweepAutomatically(): void {
    mergeEvents(this.pendingEvents, this.sweep(this.options.clock()));
  }

  private sweep(now: number): StoreEvents {
    const events = emptyEvents();
    for (const session of [...this.playerMap.values()]) {
      if (session.reserveDeadline === null || now < session.reserveDeadline) continue;
      const roomId = session.roomId;
      this.leave(session);
      events.changed.push(roomId);
    }
    for (const [roomId, entry] of this.roomMap) {
      if (entry.state.phase === 'ready' || entry.state.phase === 'playing') continue;
      const idle = now - entry.lastActivity;
      if (idle >= idleMs) {
        for (const session of this.sessions(roomId)) {
          if (session.activeSocketId) events.expiredSocketIds.push(session.activeSocketId);
          this.tokenMap.delete(session.sessionToken);
          this.playerMap.delete(session.playerId);
          if (session.activeSocketId) this.socketMap.delete(session.activeSocketId);
          session.activeSocketId = null;
          session.reserveDeadline = null;
        }
        this.roomMap.delete(roomId);
        events.closed.push(roomId);
      } else if (!entry.warned && idle >= warningMs) {
        entry.warned = true;
        events.warnings.push(roomId);
      }
    }
    return events;
  }

  private socketError(socketId: string): JoinResult | null {
    if (!this.registeredSockets.has(socketId)) return { ok: false, code: 'not_in_room' };
    if (this.socketMap.has(socketId)) return { ok: false, code: 'invalid_phase' };
    return null;
  }

  private newSession(roomId: RoomId, socketId: string): Session {
    return {
      roomId, playerId: this.uuid(), sessionToken: this.uuid(), activeSocketId: socketId,
      reserveDeadline: null, inputGeneration: 1, lastAcceptedSeq: 0, lastProcessedSeq: 0, suspended: false,
    };
  }

  private bindSession(session: Session): void {
    this.tokenMap.set(session.sessionToken, session);
    this.playerMap.set(session.playerId, session);
    if (session.activeSocketId) this.socketMap.set(session.activeSocketId, session);
  }
}
