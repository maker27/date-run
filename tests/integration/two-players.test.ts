import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientSocket } from '../../src/client/realtime/socket-client.js';
import { SocketClient } from '../../src/client/realtime/socket-client.js';
import { Prediction } from '../../src/client/realtime/prediction.js';
import type { PlayerBody, PlayerId, PlayerInput, PublicPlayer, WorldSnapshot } from '../../src/shared/model.js';
import type { ServerEvent, ServerMessage } from '../../src/shared/protocol.js';
import { SHORT_LEVEL } from '../fixtures/short-level.js';
import { createRealtimeFixture, requestId, TEST_ORIGIN } from '../fixtures/ws-test-helpers.js';

class EventTargetSocket implements ClientSocket {
  private readonly target = new EventTarget();
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url, { origin: TEST_ORIGIN });
    this.socket.on('open', () => this.target.dispatchEvent(new Event('open')));
    this.socket.on('close', (code, reason) => {
      const event = new Event('close');
      Object.defineProperties(event, { code: { value: code }, reason: { value: reason.toString() } });
      this.target.dispatchEvent(event);
    });
    this.socket.on('message', (data, binary) => {
      if (!binary) this.target.dispatchEvent(new MessageEvent('message', { data: data.toString() }));
    });
  }

  get readyState(): number { return this.socket.readyState; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.target.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    this.target.removeEventListener(type, listener, options);
  }
  send(data: string): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
}

function connect(url: string): SocketClient {
  return new SocketClient(url, { socketFactory: (address) => new EventTargetSocket(address) });
}

function hasType<T extends ServerMessage['type']>(
  message: ServerMessage,
  type: T,
): message is Extract<ServerMessage, { type: T }> {
  return message.type === type;
}

async function command<T extends ServerMessage['type']>(
  client: SocketClient,
  message: Parameters<SocketClient['request']>[0],
  type: T,
): Promise<Extract<ServerMessage, { type: T }>> {
  const reply = await client.request(message);
  if (!hasType(reply, type)) throw new Error(`Expected ${type}, received ${reply.type}`);
  return reply;
}

function playerBody(snapshot: WorldSnapshot, id: PlayerId): PlayerBody {
  return playerState(snapshot, id).body;
}

function playerState(snapshot: WorldSnapshot, id: PlayerId): PublicPlayer {
  const player = snapshot.state.players.find(({ id: playerId }) => playerId === id);
  if (!player) throw new Error('Snapshot is missing a room player');
  return player;
}

async function waitForCounter(read: () => number, expected: number): Promise<void> {
  await expect.poll(read, { timeout: 1500 }).toBe(expected);
}

describe('two connected players', () => {
  it('creates and joins a shared round, accepts both inputs, resyncs, and rejects another role’s gift', async () => {
    const fixture = await createRealtimeFixture();
    const a = connect(fixture.url);
    const b = connect(fixture.url);
    const sockets: SocketClient[] = [a, b];
    const snapshots = new Map<SocketClient, WorldSnapshot>();
    const unsubscribers = sockets.map((client) => client.onEvent((event: ServerEvent) => {
      if ('snapshot' in event) snapshots.set(client, event.snapshot);
    }));
    let now = 0;

    try {
      await Promise.all(sockets.map((client) => client.connect()));
      const created = await command(a, {
        version: 1, type: 'room:create', requestId: requestId(1), themeId: 'first-date', role: 'a',
      }, 'room:joined');
      const joined = await command(b, {
        version: 1, type: 'room:join', requestId: requestId(2), roomId: created.snapshot.roomId,
      }, 'room:joined');
      const playerA = created.credential.playerId;
      const playerB = joined.credential.playerId;
      const roomId = created.snapshot.roomId;
      const room = fixture.store.getRoom(roomId);
      expect(room?.players.find(({ id }) => id === playerB)?.role).toBe('b');

      await Promise.all([
        a.request({ version: 1, type: 'player:ready', requestId: requestId(3), ready: true }),
        b.request({ version: 1, type: 'player:ready', requestId: requestId(4), ready: true }),
      ]);
      expect(fixture.store.getRoom(roomId)?.phase).toBe('playing');

      const sessionA = fixture.store.getSession(playerA);
      const sessionB = fixture.store.getSession(playerB);
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();
      if (!sessionA || !sessionB) throw new Error('Ready players must own sessions');
      const predictionA = new Prediction(SHORT_LEVEL);
      const predictionB = new Prediction(SHORT_LEVEL);
      const initial = fixture.handle.makeSnapshot(roomId);
      expect(initial).toBeDefined();
      if (!initial) throw new Error('Playing room must expose a snapshot');
      predictionA.reset(playerBody(initial, playerA), sessionA.inputGeneration);
      predictionB.reset(playerBody(initial, playerB), sessionB.inputGeneration);
      predictionA.reconcile(initial, playerA);
      predictionB.reconcile(initial, playerB);

      let seqA = 0;
      let seqB = 0;
      const outstandingA: PlayerInput = { axis: -1, jumpPressed: false };
      const outstandingB: PlayerInput = { axis: 1, jumpPressed: false };
      seqA += 1;
      seqB += 1;
      a.sendInput({ version: 1, type: 'input:update', epoch: initial.epoch, inputGeneration: sessionA.inputGeneration, seq: seqA, input: outstandingA });
      b.sendInput({ version: 1, type: 'input:update', epoch: initial.epoch, inputGeneration: sessionB.inputGeneration, seq: seqB, input: outstandingB });
      predictionA.predict(seqA, outstandingA);
      predictionB.predict(seqB, outstandingB);
      await Promise.all([
        waitForCounter(() => sessionA.lastAcceptedSeq, seqA),
        waitForCounter(() => sessionB.lastAcceptedSeq, seqB),
      ]);
      const acceptedSnapshot = fixture.handle.makeSnapshot(roomId);
      expect(acceptedSnapshot).toBeDefined();
      if (!acceptedSnapshot) throw new Error('Playing room must expose a snapshot');
      expect(playerState(acceptedSnapshot, playerA).lastAcceptedSeq).toBe(seqA);
      expect(playerState(acceptedSnapshot, playerA).lastProcessedSeq).toBe(0);
      expect(predictionA.reconcile(acceptedSnapshot, playerA)).toEqual(predictionA.body);
      expect(predictionB.reconcile(acceptedSnapshot, playerB)).toEqual(predictionB.body);
      expect(predictionA.pendingCount).toBe(1);
      expect(predictionB.pendingCount).toBe(1);
      now += 17;
      fixture.setNow(now);
      fixture.handle.advance(now);
      await Promise.all([
        waitForCounter(() => sessionA.lastProcessedSeq, seqA),
        waitForCounter(() => sessionB.lastProcessedSeq, seqB),
      ]);
      const processedSnapshot = fixture.handle.makeSnapshot(roomId);
      expect(processedSnapshot).toBeDefined();
      if (!processedSnapshot) throw new Error('Playing room must expose a snapshot');
      expect(playerBody(processedSnapshot, playerA)).toEqual(predictionA.body);
      expect(playerBody(processedSnapshot, playerB)).toEqual(predictionB.body);
      predictionA.reconcile(processedSnapshot, playerA);
      predictionB.reconcile(processedSnapshot, playerB);
      expect(predictionA.pendingCount).toBe(0);
      expect(predictionB.pendingCount).toBe(0);

      for (let frame = 0; frame < 74; frame += 1) {
        const inputA: PlayerInput = { axis: frame < 16 ? -1 : 0, jumpPressed: frame === 16 };
        const inputB: PlayerInput = { axis: frame < 16 ? 1 : 0, jumpPressed: frame === 16 };
        seqA += 1;
        seqB += 1;
        a.sendInput({ version: 1, type: 'input:update', epoch: initial.epoch, inputGeneration: sessionA.inputGeneration, seq: seqA, input: inputA });
        b.sendInput({ version: 1, type: 'input:update', epoch: initial.epoch, inputGeneration: sessionB.inputGeneration, seq: seqB, input: inputB });
        predictionA.predict(seqA, inputA);
        predictionB.predict(seqB, inputB);
        await Promise.all([
          waitForCounter(() => sessionA.lastAcceptedSeq, seqA),
          waitForCounter(() => sessionB.lastAcceptedSeq, seqB),
        ]);
        now += 17;
        fixture.setNow(now);
        fixture.handle.advance(now);
        await Promise.all([
          waitForCounter(() => sessionA.lastProcessedSeq, seqA),
          waitForCounter(() => sessionB.lastProcessedSeq, seqB),
        ]);
        if (frame === 15) {
          const againstBothWalls = fixture.handle.makeSnapshot(roomId);
          expect(againstBothWalls).toBeDefined();
          if (!againstBothWalls) throw new Error('Playing room must expose a snapshot');
          expect(playerBody(againstBothWalls, playerA).x).toBe(0);
          expect(playerBody(againstBothWalls, playerB).x).toBe(1168);
        }
      }

      const resyncedA = await command(a, {
        version: 1, type: 'room:resync', requestId: requestId(5),
      }, 'room:resynced');
      const resyncedB = await command(b, {
        version: 1, type: 'room:resync', requestId: requestId(6),
      }, 'room:resynced');
      expect(resyncedA.rejoinState.nextSeq).toBe(seqA + 1);
      expect(resyncedB.rejoinState.nextSeq).toBe(seqB + 1);
      expect(resyncedA.snapshot.state.players.find(({ id }) => id === playerA)?.lastProcessedSeq).toBe(seqA);
      expect(resyncedB.snapshot.state.players.find(({ id }) => id === playerB)?.lastProcessedSeq).toBe(seqB);
      predictionA.reconcile(resyncedA.snapshot, playerA);
      predictionB.reconcile(resyncedB.snapshot, playerB);
      expect(predictionA.pendingCount).toBe(0);
      expect(predictionB.pendingCount).toBe(0);
      expect(playerBody(resyncedA.snapshot, playerA).grounded).toBe(true);
      expect(playerBody(resyncedB.snapshot, playerB).grounded).toBe(true);
      expect(fixture.handle.makeSnapshot(roomId)?.state.players.map(({ id, body }) => [id, body])).toEqual(
        expect.arrayContaining([
          [playerA, predictionA.body],
          [playerB, predictionB.body],
        ]),
      );

      const outsiderAttempt = await command(a, {
        version: 1, type: 'world:interact', requestId: requestId(7), epoch: initial.epoch, objectId: 'gift-b',
      }, 'world:interact:result');
      expect(outsiderAttempt.outcome).toBe('not_owner');
      expect(fixture.store.getRoom(roomId)?.gifts.find(({ id }) => id === 'gift-b')?.collectedBy).toBeNull();
      expect(snapshots.size).toBe(2);
    } finally {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      for (const client of sockets) client.destroy();
      await fixture.close();
    }
  });
});
