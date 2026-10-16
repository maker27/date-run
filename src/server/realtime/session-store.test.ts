import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CredentialSchema, RoomIdSchema, WorldSnapshotSchema } from '../../shared/model.js';
import { setReady } from '../game/game-state.js';
import { SessionStore } from './session-store.js';

function fixture() {
  let now = 0;
  let id = 0;
  const store = new SessionStore({
    clock: () => now,
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    roomCode: () => 'ABCDEFGH',
  });
  return { store, setNow: (value: number) => { now = value; } };
}

function registered(store: SessionStore, ...socketIds: string[]) {
  for (const socketId of socketIds) expect(store.registerSocket(socketId)).toBe(true);
}

function roomWithTwo(store: SessionStore) {
  registered(store, 'socket-a', 'socket-b');
  const created = store.create('first-date', 'a', 'socket-a');
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('room creation failed');
  const joined = store.join(created.session.roomId, 'socket-b');
  expect(joined.ok).toBe(true);
  if (!joined.ok) throw new Error('room join failed');
  return { created, joined };
}

describe('SessionStore sessions and capacity', () => {
  it('keeps a disconnected place through 29,999ms and expires it at 30,000ms', () => {
    const { store, setNow } = fixture();
    const { joined } = roomWithTwo(store);
    store.disconnect('socket-b');

    setNow(29_999);
    expect(store.expire(29_999).expiredSocketIds).toEqual([]);
    expect(store.countOccupiedPlaces()).toBe(2);
    expect(store.getRoom(joined.session.roomId)?.players).toHaveLength(2);

    setNow(30_000);
    const expired = store.expire(30_000);
    expect(expired.expiredSocketIds).not.toContain('socket-b');
    expect(expired.changed).toContain(joined.session.roomId);
    expect(store.countOccupiedPlaces()).toBe(1);
    expect(store.getRoom(joined.session.roomId)?.players).toHaveLength(1);
  });

  it('preserves a replaced session place and ignores a late close from its former socket', () => {
    const { store } = fixture();
    const { joined } = roomWithTwo(store);
    const token = store.credential(joined.session).sessionToken;
    registered(store, 'socket-b-new');

    const replacement = store.rejoin(token, 'socket-b-new');
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error('rejoin failed');
    expect(replacement.replacedSocketId).toBe('socket-b');
    expect(store.countOccupiedPlaces()).toBe(2);

    store.disconnect('socket-b');
    expect(store.getSessionBySocket('socket-b-new')).toBe(replacement.session);
    expect(store.getRoom(joined.session.roomId)?.players.find(({ id }) => id === replacement.session.playerId)?.connected).toBe(true);
    expect(store.countOccupiedPlaces()).toBe(2);
  });

  it('enforces room, place, and socket limits independently', () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let roomNumber = 0;
    const store = new SessionStore({
      clock: () => 0,
      uuid: randomUUID,
      roomCode: () => {
        let value = roomNumber++;
        let result = '';
        for (let index = 0; index < 8; index += 1) {
          result = `${alphabet[value % alphabet.length]}${result}`;
          value = Math.floor(value / alphabet.length);
        }
        return result;
      },
      limits: { rooms: 100, places: 200, sockets: 240 },
    });
    for (let index = 0; index < 240; index += 1) expect(store.registerSocket(`socket-${index}`)).toBe(true);
    expect(store.registerSocket('socket-over-cap')).toBe(false);

    for (let index = 0; index < 100; index += 1) {
      const first = store.create('first-date', 'a', `socket-${index * 2}`);
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('room creation failed');
      const second = store.join(first.session.roomId, `socket-${index * 2 + 1}`);
      expect(second.ok).toBe(true);
    }

    expect(store.countOccupiedPlaces()).toBe(200);
    expect(store.rooms()).toHaveLength(100);
    expect(store.countSockets()).toBe(240);
    expect(store.create('retro', 'a', 'socket-200')).toMatchObject({ ok: false, code: 'server_full' });
    expect(store.create('retro', 'a', 'socket-239')).toMatchObject({ ok: false, code: 'server_full' });

    const firstRoom = store.rooms()[0];
    expect(firstRoom).toBeDefined();
    if (!firstRoom) throw new Error('room missing');
    const firstSession = store.sessions(firstRoom.roomId)[0];
    expect(firstSession).toBeDefined();
    if (!firstSession) throw new Error('session missing');
    const replaced = store.rejoin(store.credential(firstSession).sessionToken, 'socket-200');
    expect(replaced.ok).toBe(true);
    expect(store.countOccupiedPlaces()).toBe(200);
  });

  it('retries generated room code collisions and creates UUID credentials without Math.random', () => {
    let codeCall = 0;
    let id = 0;
    const store = new SessionStore({
      clock: () => 0,
      uuid: () => `10000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
      roomCode: () => ['ABCDEFGH', 'ABCDEFGH', 'JKLMNPQR'][codeCall++] ?? 'STUVWXYZ',
    });
    registered(store, 'a', 'b');
    expect(store.create('first-date', 'a', 'a').ok).toBe(true);
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('unexpected random source'); });
    try {
      const created = store.create('retro', 'b', 'b');
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('room creation failed');
      expect(created.session.roomId).toBe('JKLMNPQR');
      expect(store.credential(created.session).sessionToken).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      random.mockRestore();
    }
  });

  it('uses crypto-backed default room and token generation and returns schema-valid values', () => {
    const store = new SessionStore({ clock: () => 0 });
    registered(store, 'socket');
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('unexpected random source'); });
    try {
      const created = store.create('winter', 'a', 'socket');
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('room creation failed');
      expect(RoomIdSchema.safeParse(created.session.roomId).success).toBe(true);
      expect(CredentialSchema.safeParse(store.credential(created.session)).success).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('projects public snapshots without private credential or socket metadata', () => {
    const { store } = fixture();
    const { created } = roomWithTwo(store);
    const sourceRoom = store.getRoom(created.session.roomId);
    expect(sourceRoom).toBeDefined();
    if (!sourceRoom) throw new Error('room missing');
    const sourceCopy = structuredClone(sourceRoom);
    const snapshot = store.snapshot(created.session.roomId, 10);
    expect(snapshot).toBeDefined();
    expect(WorldSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(store.getRoom(created.session.roomId)).toEqual(sourceCopy);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('sessionToken');
    expect(serialized).not.toContain('reserveDeadline');
    expect(serialized).not.toContain('activeSocketId');
    expect(snapshot?.state.players.every((player) => 'inputGeneration' in player && 'lastAcceptedSeq' in player && 'lastProcessedSeq' in player)).toBe(true);
  });

  it('increments input generation on epoch and pause transitions without resetting ACK counters', () => {
    const { store } = fixture();
    const { created, joined } = roomWithTwo(store);
    created.session.lastAcceptedSeq = 17;
    created.session.lastProcessedSeq = 14;
    const state = store.getRoom(created.session.roomId);
    expect(state).toBeDefined();
    if (!state) throw new Error('room missing');

    store.setRoom({ ...state, epoch: state.epoch + 1 });
    expect(created.session.inputGeneration).toBe(2);
    expect(created.session.lastAcceptedSeq).toBe(17);
    expect(created.session.lastProcessedSeq).toBe(14);

    const epochState = store.getRoom(created.session.roomId);
    expect(epochState).toBeDefined();
    if (!epochState) throw new Error('room missing');
    store.setRoom({ ...epochState, phase: 'playing', paused: false });
    const playing = store.getRoom(created.session.roomId);
    expect(playing).toBeDefined();
    if (!playing) throw new Error('room missing');
    store.setRoom({ ...playing, paused: true });
    expect(created.session.inputGeneration).toBe(3);
    expect(joined.session.inputGeneration).toBe(3);
    expect(store.credential(created.session).nextSeq).toBe(18);

    const rejoinState = store.resync(created.session);
    expect(rejoinState.inputGeneration).toBe(4);
    expect(rejoinState.nextSeq).toBe(18);
    expect(created.session.lastAcceptedSeq).toBe(17);
    expect(created.session.lastProcessedSeq).toBe(14);
  });

  it('warns at 29 minutes, closes at 30 minutes, and exempts ready and playing rooms', () => {
    const { store, setNow } = fixture();
    const { created } = roomWithTwo(store);
    const warningTime = 29 * 60_000;
    setNow(warningTime);
    expect(store.expire(warningTime).warnings).toEqual([created.session.roomId]);
    setNow(30 * 60_000);
    expect(store.expire(30 * 60_000).closed).toEqual([created.session.roomId]);

    const readyFixture = fixture();
    const readyPlayers = roomWithTwo(readyFixture.store);
    const room = readyFixture.store.getRoom(readyPlayers.created.session.roomId);
    expect(room).toBeDefined();
    if (!room) throw new Error('room missing');
    const oneReady = setReady(room, readyPlayers.created.session.playerId, true);
    expect(oneReady.ok).toBe(true);
    if (!oneReady.ok) throw new Error('ready transition failed');
    readyFixture.store.setRoom(oneReady.state);
    readyFixture.setNow(31 * 60_000);
    expect(readyFixture.store.expire(31 * 60_000).closed).toEqual([]);
    expect(readyFixture.store.getRoom(readyPlayers.created.session.roomId)?.phase).toBe('ready');

    const ready = setReady(oneReady.state, readyPlayers.joined.session.playerId, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error('ready transition failed');
    readyFixture.store.setRoom(ready.state);
    readyFixture.setNow(60 * 60_000);
    expect(readyFixture.store.expire(60 * 60_000).closed).toEqual([]);
    expect(readyFixture.store.getRoom(readyPlayers.created.session.roomId)?.phase).toBe('playing');
  });

  it('cancels an idle warning on meaningful activity and ignores ping/resync for idle TTL', () => {
    const { store, setNow } = fixture();
    const { created } = roomWithTwo(store);
    setNow(29 * 60_000);
    expect(store.expire(29 * 60_000).warnings).toEqual([created.session.roomId]);
    setNow(29 * 60_000 + 1);
    store.touch(created.session.roomId);
    expect(store.expire(30 * 60_000).closed).toEqual([]);

    setNow(58 * 60_000 + 1);
    expect(store.expire(58 * 60_000 + 1).warnings).toEqual([created.session.roomId]);
    setNow(59 * 60_000 + 1);
    store.resync(created.session);
    expect(store.expire(59 * 60_000 + 1).closed).toEqual([created.session.roomId]);
  });

  it('returns a sole-ready room to lobby when its ready player disconnects', () => {
    const { store } = fixture();
    const { created, joined } = roomWithTwo(store);
    const room = store.getRoom(created.session.roomId);
    expect(room).toBeDefined();
    if (!room) throw new Error('room missing');

    const ready = setReady(room, joined.session.playerId, true);
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error('ready transition failed');
    store.setRoom(ready.state);
    expect(store.getRoom(created.session.roomId)?.phase).toBe('ready');

    store.disconnect('socket-b');
    const afterDisconnect = store.getRoom(created.session.roomId);
    expect(afterDisconnect?.phase).toBe('lobby');
    expect(afterDisconnect?.players.find(({ id }) => id === joined.session.playerId)?.ready).toBe(false);
    expect(afterDisconnect?.players.find(({ id }) => id === created.session.playerId)?.connected).toBe(true);
  });

  it('enforces an expired credential during rejoin even if the scheduler has not run', () => {
    const { store, setNow } = fixture();
    const { created, joined } = roomWithTwo(store);
    const credential = store.credential(joined.session);
    store.disconnect('socket-b');
    setNow(30_000);
    registered(store, 'replacement');

    expect(store.rejoin(credential.sessionToken, 'replacement')).toMatchObject({ ok: false, code: 'session_expired' });
    expect(store.countOccupiedPlaces()).toBe(1);
    expect(store.getRoom(created.session.roomId)?.players).toHaveLength(1);
  });

  it('retains sweep events caused by rejoin until the next expire call', () => {
    const { store, setNow } = fixture();
    const { created, joined } = roomWithTwo(store);
    const credential = store.credential(joined.session);
    store.disconnect('socket-b');
    setNow(30_000);
    registered(store, 'replacement');

    store.rejoin(credential.sessionToken, 'replacement');
    expect(store.getRoom(created.session.roomId)?.players).toHaveLength(1);
    expect(store.expire(30_000).changed).toEqual([created.session.roomId]);
    expect(store.expire(30_000).changed).toEqual([]);
  });

  it('cancels a queued idle warning when a second player joins at 29 minutes', () => {
    const { store, setNow } = fixture();
    registered(store, 'socket-a', 'socket-b');
    const created = store.create('first-date', 'a', 'socket-a');
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('room creation failed');

    const atWarning = 29 * 60_000;
    setNow(atWarning);
    const joined = store.join(created.session.roomId, 'socket-b');
    expect(joined.ok).toBe(true);
    expect(store.expire(atWarning).warnings).toEqual([]);

    setNow(30 * 60_000);
    expect(store.expire(30 * 60_000).closed).toEqual([]);
    expect(store.getRoom(created.session.roomId)).toBeDefined();
  });

  it('cancels a queued idle warning when an active session rejoins at 29 minutes', () => {
    const { store, setNow } = fixture();
    const { created, joined } = roomWithTwo(store);
    const token = store.credential(joined.session).sessionToken;
    registered(store, 'socket-b-replacement');

    const atWarning = 29 * 60_000;
    setNow(atWarning);
    const rejoined = store.rejoin(token, 'socket-b-replacement');
    expect(rejoined.ok).toBe(true);
    expect(store.expire(atWarning).warnings).toEqual([]);

    setNow(30 * 60_000);
    expect(store.expire(30 * 60_000).closed).toEqual([]);
    expect(store.getRoom(created.session.roomId)).toBeDefined();
  });

  it('removes an empty room when both disconnected reserves expire', () => {
    const { store, setNow } = fixture();
    const { created } = roomWithTwo(store);
    store.disconnect('socket-a');
    store.disconnect('socket-b');
    setNow(30_000);

    store.expire(30_000);
    expect(store.getRoom(created.session.roomId)).toBeUndefined();
    expect(store.countOccupiedPlaces()).toBe(0);
  });
});
