import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ServerEvent,
  type ServerReply,
} from './protocol.js';

const requestId = '11111111-1111-4111-8111-111111111111';
const roomId = 'ABCDEFGH';
const playerA = '22222222-2222-4222-8222-222222222222';
const playerB = '33333333-3333-4333-8333-333333333333';
const sessionToken = '44444444-4444-4444-8444-444444444444';
const now = 1_000;

const body = {
  x: 64,
  y: 792,
  vx: 0,
  vy: 0,
  grounded: true,
  facing: 1,
};

const snapshot = {
  roomId,
  epoch: 0,
  tick: 0,
  revision: 0,
  serverTime: now,
  state: {
    themeId: 'first-date',
    hostId: playerA,
    phase: 'lobby',
    paused: false,
    players: [
      {
        id: playerA,
        role: 'a',
        connected: true,
        ready: false,
        rematch: false,
        body,
        inputGeneration: 1,
        lastAcceptedSeq: 0,
        lastProcessedSeq: 0,
      },
      {
        id: playerB,
        role: 'b',
        connected: false,
        ready: false,
        rematch: false,
        body: { ...body, x: 17_904, facing: -1 },
        inputGeneration: 1,
        lastAcceptedSeq: 0,
        lastProcessedSeq: 0,
      },
    ],
    gifts: [
      { id: 'gift-a', ownerRole: 'a', collectedBy: null },
      { id: 'gift-b', ownerRole: 'b', collectedBy: null },
    ],
    switches: [
      { id: 'switch-left', occupant: null },
      { id: 'switch-right', occupant: null },
    ],
    gateOpen: false,
    finishStartedAt: null,
  },
};

const credential = {
  schemaVersion: 1,
  roomId,
  playerId: playerA,
  sessionToken,
  nextSeq: 1,
};

const rejoinState = { inputGeneration: 1, nextSeq: 1 };

const clientMessages = [
  { version: 1, type: 'room:create', requestId, themeId: 'first-date', role: 'a' },
  { version: 1, type: 'room:join', requestId, roomId },
  { version: 1, type: 'room:rejoin', requestId, sessionToken },
  { version: 1, type: 'room:configure', requestId, themeId: 'retro', hostRole: 'b' },
  { version: 1, type: 'room:leave', requestId },
  { version: 1, type: 'player:ready', requestId, ready: true },
  { version: 1, type: 'room:rematch', requestId },
  { version: 1, type: 'room:reset', requestId },
  {
    version: 1,
    type: 'input:update',
    epoch: 0,
    inputGeneration: 1,
    seq: 1,
    input: { axis: -1, jumpPressed: true },
  },
  { version: 1, type: 'player:suspend', requestId, epoch: 0 },
  { version: 1, type: 'world:interact', requestId, epoch: 0, objectId: 'gift-a' },
  { version: 1, type: 'room:resync', requestId },
  { version: 1, type: 'time:ping', requestId, clientTime: now },
] as const;

const serverMessages = [
  { version: 1, type: 'room:joined', requestId, credential, rejoinState, snapshot },
  { version: 1, type: 'command:result', requestId, command: 'room:leave', outcome: 'ok' },
  { version: 1, type: 'room:state', snapshot },
  { version: 1, type: 'round:start', snapshot },
  { version: 1, type: 'world:update', snapshot },
  { version: 1, type: 'room:complete', snapshot },
  { version: 1, type: 'room:resynced', requestId, rejoinState, snapshot },
  {
    version: 1,
    type: 'world:interact:result',
    requestId,
    epoch: 0,
    objectId: 'gift-a',
    outcome: 'accepted',
  },
  { version: 1, type: 'time:pong', requestId, clientTime: now, serverTime: now },
  { version: 1, type: 'room:closing', reason: 'idle', remainingMs: 60_000 },
  { version: 1, type: 'session:replaced' },
  { version: 1, type: 'error', requestId, code: 'room_full' },
] as const;

describe('wire protocol schemas', () => {
  it('accepts and roundtrips every client message discriminant', () => {
    for (const message of clientMessages) {
      const parsed = ClientMessageSchema.parse(message);
      expect(parsed).toEqual(message);
    }
  });

  it('accepts and roundtrips every server message discriminant', () => {
    for (const message of serverMessages) {
      const parsed = ServerMessageSchema.parse(message);
      expect(parsed).toEqual(message);
    }
  });

  it('accepts correlated and uncorrelated errors', () => {
    const correlated = { version: 1, type: 'error', requestId, code: 'room_full' };
    const uncorrelated = { version: 1, type: 'error', code: 'queue_full' };

    expect(ServerMessageSchema.parse(correlated)).toEqual(correlated);
    expect(ServerMessageSchema.parse(uncorrelated)).toEqual(uncorrelated);
  });

  it('keeps both error forms in their respective server type subsets', () => {
    expectTypeOf<Extract<ServerEvent, { type: 'error' }>>().not.toBeNever();
    expectTypeOf<Extract<ServerReply, { type: 'error' }>>().toMatchTypeOf<{ requestId: string }>();
  });

  it('rejects extra fields at the envelope and nested input boundaries', () => {
    const inputUpdate = clientMessages[8];
    expect(ClientMessageSchema.safeParse({ ...inputUpdate, x: 10 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({
      ...inputUpdate,
      input: { ...inputUpdate.input, y: 10 },
    }).success).toBe(false);
  });

  it('rejects private credentials inside a public snapshot', () => {
    const publicMessage = serverMessages[2];
    expect(ServerMessageSchema.safeParse({
      ...publicMessage,
      snapshot: {
        ...publicMessage.snapshot,
        token: sessionToken,
      },
    }).success).toBe(false);
  });

  it('rejects wrong versions, invalid enums, and malformed sequence numbers', () => {
    const create = clientMessages[0];
    const inputUpdate = clientMessages[8];

    expect(ClientMessageSchema.safeParse({ ...create, version: 2 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...create, role: 'c' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...create, themeId: 'summer' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...inputUpdate, seq: -1 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...inputUpdate, seq: 1.5 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({
      ...inputUpdate,
      inputGeneration: Number.NaN,
    }).success).toBe(false);
  });

  it('rejects malformed UUIDs, room codes, object IDs, and oversized collections', () => {
    const create = clientMessages[0];
    const join = clientMessages[1];
    const interact = clientMessages[10];
    const stateMessage = serverMessages[2];

    expect(ClientMessageSchema.safeParse({ ...create, requestId: 'request-1' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...join, roomId: 'ABCDEFGI' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...interact, objectId: 'Gift A' }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({
      ...stateMessage,
      snapshot: {
        ...stateMessage.snapshot,
        state: {
          ...stateMessage.snapshot.state,
          gifts: [...stateMessage.snapshot.state.gifts, stateMessage.snapshot.state.gifts[0]],
        },
      },
    }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({
      ...stateMessage,
      snapshot: {
        ...stateMessage.snapshot,
        state: {
          ...stateMessage.snapshot.state,
          players: [...stateMessage.snapshot.state.players, stateMessage.snapshot.state.players[0]],
        },
      },
    }).success).toBe(false);
    expect(ServerMessageSchema.safeParse({
      ...stateMessage,
      snapshot: {
        ...stateMessage.snapshot,
        state: {
          ...stateMessage.snapshot.state,
          switches: [...stateMessage.snapshot.state.switches, stateMessage.snapshot.state.switches[0]],
        },
      },
    }).success).toBe(false);
  });

  it('accepts a syntactically valid unknown object ID for domain handling', () => {
    const interaction = { ...clientMessages[10], objectId: 'bonus-1' };
    expect(ClientMessageSchema.parse(interaction)).toEqual(interaction);
  });

  it('rejects non-finite timestamps and overlong bounded strings', () => {
    const ping = clientMessages[12];
    const interact = clientMessages[10];
    expect(ClientMessageSchema.safeParse({ ...ping, clientTime: Number.NaN }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({
      ...interact,
      objectId: `a${'b'.repeat(32)}`,
    }).success).toBe(false);
  });
});
