import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import WebSocket from 'ws';
import { SessionStore } from './session-store.js';
import { attachWebSocketServer } from './ws-server.js';
import { createRealtimeFixture, openClient, requestId, TEST_ORIGIN, waitForClientClose } from '../../../tests/fixtures/ws-test-helpers.js';

describe('WebSocket server', () => {
  it('closes restart connections as retryable and expires credentials on the fresh server', async () => {
    const original = await createRealtimeFixture();
    const host = await openClient(original.url);
    let fresh: Awaited<ReturnType<typeof createRealtimeFixture>> | undefined;
    let replacement: Awaited<ReturnType<typeof openClient>> | undefined;
    try {
      await host.send({ version: 1, type: 'room:create', requestId: requestId(900), themeId: 'retro', role: 'a' });
      const joined = await host.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('host credential missing');

      await original.handle.close();
      expect(await waitForClientClose(host.socket)).toBe(1012);

      fresh = await createRealtimeFixture();
      replacement = await openClient(fresh.url);
      await replacement.send({ version: 1, type: 'room:rejoin', requestId: requestId(901), sessionToken: joined.credential.sessionToken });
      expect(await replacement.waitFor((message) => message.type === 'error' && message.requestId === requestId(901))).toMatchObject({
        type: 'error', requestId: requestId(901), code: 'session_expired',
      });
    } finally {
      await Promise.all([original.close([host]), fresh?.close(replacement ? [replacement] : [])]);
    }
  });

  it('uses the domain clock by default and an explicit liveness clock when supplied', async () => {
    const start = async (separateLivenessClock: boolean) => {
      let domainNow = 0;
      let livenessNow = 0;
      const server = createServer();
      const store = new SessionStore({ clock: () => domainNow });
      const realtime = attachWebSocketServer(server, store, {
        allowedOrigins: [TEST_ORIGIN],
        clock: () => domainNow,
        ...(separateLivenessClock ? { livenessClock: () => livenessNow } : {}),
        autoSchedule: false,
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('WebSocket test server has no TCP address');
      return {
        url: `ws://127.0.0.1:${address.port}/date-run/ws`,
        advanceAppTime(now: number) { domainNow = now; realtime.advance(now); },
        advanceLivenessTime(now: number) { livenessNow = now; realtime.advance(domainNow); },
        close: () => realtime.close(),
      };
    };

    const defaults = await start(false);
    const defaultClient = await openClient(defaults.url, TEST_ORIGIN, false);
    try {
      defaults.advanceAppTime(5000);
      await waitForClientClose(defaultClient.socket);
      expect(defaultClient.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await defaults.close();
    }

    const separate = await start(true);
    const separateClient = await openClient(separate.url, TEST_ORIGIN, false);
    try {
      separate.advanceAppTime(5000);
      expect(separateClient.socket.readyState).toBe(WebSocket.OPEN);
      separate.advanceLivenessTime(5000);
      await waitForClientClose(separateClient.socket);
      expect(separateClient.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await separate.close();
    }
  });

  it('creates and joins a room with private credentials and sender-inclusive public snapshots', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const host = await openClient(fixture.url);
      clients.push(host);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(1), themeId: 'retro', role: 'a' });
      const hostJoined = await host.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(1));
      expect(hostJoined.type).toBe('room:joined');
      if (hostJoined.type !== 'room:joined') throw new Error('host join response missing');
      expect(hostJoined.credential.sessionToken).toMatch(/^[0-9a-f-]{36}$/i);
      expect(hostJoined.snapshot.state.players).toHaveLength(1);

      const peer = await openClient(fixture.url);
      clients.push(peer);
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(2), roomId: hostJoined.credential.roomId });
      const peerJoined = await peer.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(2));
      const hostState = await host.waitFor((message) => message.type === 'room:state' && message.snapshot.state.players.length === 2);
      expect(peerJoined.type).toBe('room:joined');
      expect(hostState.type).toBe('room:state');
      if (peerJoined.type !== 'room:joined' || hostState.type !== 'room:state') throw new Error('join state missing');
      expect(hostState.snapshot.state.gifts).toEqual(peerJoined.snapshot.state.gifts);
      expect(hostState.snapshot.state.players.map(({ id }) => id)).toEqual(peerJoined.snapshot.state.players.map(({ id }) => id));
      expect(JSON.stringify(hostState)).not.toContain(hostJoined.credential.sessionToken);
      expect(JSON.stringify(peerJoined.snapshot)).not.toContain('sessionToken');
    } finally {
      await fixture.close(clients);
    }
  });

  it('allows clock sync before authentication without extending the auth deadline', async () => {
    const fixture = await createRealtimeFixture();
    const client = await openClient(fixture.url);
    try {
      await client.send({ version: 1, type: 'time:ping', requestId: requestId(3), clientTime: 12 });
      expect(await client.waitFor((message) => message.type === 'time:pong')).toMatchObject({
        type: 'time:pong', requestId: requestId(3), clientTime: 12, serverTime: 0,
      });
      fixture.setNow(5000);
      fixture.handle.advance(5000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('unauthenticated socket did not time out')), 1200);
        client.socket.once('close', () => { clearTimeout(timer); resolve(); });
      });
      expect(client.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await fixture.close([client]);
    }
  });

  it('rejects malformed messages and does not reflect payloads', async () => {
    const fixture = await createRealtimeFixture();
    const client = await openClient(fixture.url);
    const second = await openClient(fixture.url);
    const third = await openClient(fixture.url);
    try {
      client.socket.send('{"secret":"do-not-reflect"');
      const malformed = await client.waitFor((message) => message.type === 'error');
      expect(malformed).toMatchObject({ type: 'error', code: 'invalid_message' });
      expect(JSON.stringify(malformed)).not.toContain('do-not-reflect');
      const malformedClose = await waitForClientClose(client.socket);
      expect(malformedClose).toBe(4003);

      await second.send({ version: 2, type: 'time:ping', requestId: requestId(4), clientTime: 1 });
      const unsupported = await second.waitFor((message) => message.type === 'error' && message.code === 'unsupported_version');
      expect(unsupported).toMatchObject({ type: 'error', code: 'unsupported_version' });
      expect(await waitForClientClose(second.socket)).toBe(4003);

      third.socket.send(Buffer.from([0x01, 0x02]));
      const binaryError = await third.waitFor((message) => message.type === 'error' && message.code === 'invalid_message');
      expect(binaryError).toMatchObject({ type: 'error', code: 'invalid_message' });
      expect(await waitForClientClose(third.socket)).toBe(4003);
      expect(third.socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await fixture.close([client, second, third]);
    }
  });

  it('rejects wrong paths and unlisted origins at upgrade time', async () => {
    const fixture = await createRealtimeFixture();
    try {
      for (const [url, origin, status] of [
        [`${fixture.url}/extra`, TEST_ORIGIN, 404],
        [fixture.url, 'https://attacker.test', 403],
      ] as const) {
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(url, { origin });
          const timer = setTimeout(() => { socket.terminate(); reject(new Error('upgrade rejection timed out')); }, 1200);
          socket.once('unexpected-response', (_request, response) => {
            clearTimeout(timer);
            expect(response.statusCode).toBe(status);
            response.resume();
            resolve();
          });
          socket.once('open', () => { clearTimeout(timer); reject(new Error('invalid upgrade was accepted')); });
          socket.once('error', () => undefined);
        });
      }
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(fixture.url);
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('missing-origin rejection timed out')); }, 1200);
        socket.once('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          expect(response.statusCode).toBe(403);
          response.resume();
          resolve();
        });
        socket.once('open', () => { clearTimeout(timer); reject(new Error('missing Origin was accepted')); });
        socket.once('error', () => undefined);
      });
    } finally {
      await fixture.close();
    }
  });

  it('closes a client whose incoming message exceeds the 16 KiB limit with code 1009', async () => {
    const fixture = await createRealtimeFixture();
    const client = await openClient(fixture.url);
    try {
      client.socket.send(JSON.stringify({ padding: 'x'.repeat(16_400) }));
      const code = await waitForClientClose(client.socket);
      expect(code).toBe(1009);
    } finally {
      await fixture.close([client]);
    }
  });

  it('returns the cached leave acknowledgement on the same now-unauthenticated connection', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const client = await openClient(fixture.url);
      clients.push(client);
      await client.send({ version: 1, type: 'room:create', requestId: requestId(5), themeId: 'first-date', role: 'a' });
      await client.waitFor((message) => message.type === 'room:joined');
      const leave = { version: 1, type: 'room:leave', requestId: requestId(6) };
      await client.send(leave);
      const acknowledgement = await client.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(6));
      await client.send(leave);
      const duplicate = await client.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(6));
      expect(duplicate).toEqual(acknowledgement);
      await client.send({ version: 1, type: 'time:ping', requestId: requestId(6), clientTime: 10 });
      expect(await client.waitFor((message) => message.type === 'error' && message.requestId === requestId(6))).toMatchObject({ code: 'invalid_message' });
      expect(fixture.store.countOccupiedPlaces()).toBe(0);
    } finally {
      await fixture.close(clients);
    }
  });

  it('enforces host configuration and drives ready, suspend, resync, rematch, and reset over the wire', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    let now = 0;
    const advanceCommandBudget = () => { now += 1000; fixture.setNow(now); };
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(50), themeId: 'first-date', role: 'a' });
      const hostJoined = await host.waitFor((message) => message.type === 'room:joined');
      if (hostJoined.type !== 'room:joined') throw new Error('host credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(51), roomId: hostJoined.credential.roomId });
      const peerJoined = await peer.waitFor((message) => message.type === 'room:joined');
      if (peerJoined.type !== 'room:joined') throw new Error('peer credential missing');

      await peer.send({ version: 1, type: 'room:configure', requestId: requestId(52), themeId: 'winter', hostRole: 'b' });
      expect(await peer.waitFor((message) => message.type === 'error' && message.requestId === requestId(52))).toMatchObject({ code: 'not_host' });
      advanceCommandBudget();
      await host.send({ version: 1, type: 'room:configure', requestId: requestId(53), themeId: 'winter', hostRole: 'b' });
      expect(await host.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(53))).toMatchObject({ command: 'room:configure', outcome: 'ok' });
      const configured = await peer.waitFor((message) => message.type === 'room:state' && message.snapshot.state.themeId === 'winter');
      expect(configured.type).toBe('room:state');
      if (configured.type !== 'room:state') throw new Error('configured snapshot missing');
      expect(configured.snapshot.state.players.find(({ id }) => id === hostJoined.credential.playerId)?.role).toBe('b');
      expect(configured.snapshot.state.players.find(({ id }) => id === peerJoined.credential.playerId)?.role).toBe('a');

      advanceCommandBudget();
      await host.send({ version: 1, type: 'player:ready', requestId: requestId(54), ready: true });
      await host.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(54));
      advanceCommandBudget();
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(55), ready: true });
      const started = await host.waitFor((message) => message.type === 'round:start');
      if (started.type !== 'round:start') throw new Error('ready transition did not start the round');

      advanceCommandBudget();
      await host.send({ version: 1, type: 'player:suspend', requestId: requestId(56), epoch: started.snapshot.epoch });
      const suspended = await host.waitFor((message) => message.type === 'room:resynced' && message.requestId === requestId(56));
      expect(suspended.type).toBe('room:resynced');
      if (suspended.type !== 'room:resynced') throw new Error('suspend response missing');
      expect(suspended.rejoinState.inputGeneration).toBeGreaterThan(started.snapshot.state.players.find(({ id }) => id === hostJoined.credential.playerId)?.inputGeneration ?? 0);
      await host.send({ version: 1, type: 'input:update', epoch: started.snapshot.epoch, inputGeneration: started.snapshot.state.players.find(({ id }) => id === hostJoined.credential.playerId)?.inputGeneration ?? 0, seq: 1, input: { axis: 1, jumpPressed: false } });
      expect(await host.waitFor((message) => message.type === 'error' && message.code === 'stale_input_generation')).toBeDefined();
      advanceCommandBudget();
      await host.send({ version: 1, type: 'room:resync', requestId: requestId(57) });
      const resumed = await host.waitFor((message) => message.type === 'room:resynced' && message.requestId === requestId(57));
      expect(resumed.type).toBe('room:resynced');
      if (resumed.type !== 'room:resynced') throw new Error('resync response missing');
      expect(resumed.rejoinState.nextSeq).toBe(1);

      const current = fixture.store.getRoom(hostJoined.credential.roomId);
      if (!current) throw new Error('room disappeared');
      fixture.store.setRoom({ ...current, phase: 'complete', paused: false });
      advanceCommandBudget();
      await host.send({ version: 1, type: 'room:rematch', requestId: requestId(58) });
      await host.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(58));
      advanceCommandBudget();
      await peer.send({ version: 1, type: 'room:rematch', requestId: requestId(59) });
      await peer.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(59));
      await host.waitFor((message) => message.type === 'room:state' && message.snapshot.state.phase === 'lobby');

      const lobby = fixture.store.getRoom(hostJoined.credential.roomId);
      if (!lobby) throw new Error('room disappeared after rematch');
      fixture.store.setRoom({ ...lobby, phase: 'complete' });
      advanceCommandBudget();
      await peer.send({ version: 1, type: 'room:reset', requestId: requestId(60) });
      await peer.waitFor((message) => message.type === 'command:result' && message.requestId === requestId(60));
      const reset = await peer.waitFor((message) => message.type === 'room:state' && message.snapshot.state.phase === 'lobby');
      expect(reset.type).toBe('room:state');
    } finally {
      await fixture.close(clients);
    }
  });

  it('closes cleanly and rejects upgrades after shutdown begins', async () => {
    const fixture = await createRealtimeFixture();
    await fixture.handle.close();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(fixture.url, { origin: TEST_ORIGIN });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('shutdown rejection timed out')); }, 1200);
      socket.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        expect(response.statusCode).toBe(503);
        response.resume();
        resolve();
      });
      socket.once('open', () => { clearTimeout(timer); reject(new Error('upgrade accepted after shutdown')); });
      socket.once('error', () => undefined);
    });
    await fixture.close();
  });

  it('closes repeated input-rate violations with 1008 before accepting more than 90 inputs per second', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(30), themeId: 'first-date', role: 'a' });
      const joined = await host.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('host credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(31), roomId: joined.credential.roomId });
      await peer.waitFor((message) => message.type === 'room:joined');
      await host.send({ version: 1, type: 'player:ready', requestId: requestId(32), ready: true });
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(33), ready: true });
      const round = await host.waitFor((message) => message.type === 'round:start');
      if (round.type !== 'round:start') throw new Error('round did not start');
      const ownPlayer = round.snapshot.state.players.find(({ id }) => id === joined.credential.playerId);
      if (!ownPlayer) throw new Error('host player missing from snapshot');

      for (let seq = 1; seq <= 100 && host.socket.readyState === WebSocket.OPEN; seq += 1) {
        await host.send({
          version: 1, type: 'input:update', epoch: round.snapshot.epoch,
          inputGeneration: ownPlayer.inputGeneration, seq, input: { axis: 1, jumpPressed: false },
        });
      }
      expect(await waitForClientClose(host.socket)).toBe(1008);
      expect(fixture.store.getSession(joined.credential.playerId)?.lastAcceptedSeq).toBeLessThanOrEqual(90);
      expect(fixture.store.countOccupiedPlaces()).toBe(2);
    } finally {
      await fixture.close(clients);
    }
  });

  it('correlates a single command rate-limit error to its request ID and keeps the socket open', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const client = await openClient(fixture.url);
      clients.push(client);
      await client.send({ version: 1, type: 'room:create', requestId: requestId(70), themeId: 'retro', role: 'a' });
      await client.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(70));

      for (let id = 71; id <= 79; id += 1) {
        await client.send({ version: 1, type: 'time:ping', requestId: requestId(id), clientTime: 0 });
        await client.waitFor((message) => message.type === 'time:pong' && message.requestId === requestId(id));
      }
      await client.send({ version: 1, type: 'time:ping', requestId: requestId(80), clientTime: 0 });
      const limited = await client.waitFor((message) => message.type === 'error' && message.code === 'rate_limited');
      expect(limited).toMatchObject({ type: 'error', code: 'rate_limited', requestId: requestId(80) });
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await fixture.close(clients);
    }
  });

  it('replays a transient rate-limit reply for the same request after the bucket refills', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const client = await openClient(fixture.url);
      clients.push(client);
      for (let id = 101; id <= 110; id += 1) {
        await client.send({ version: 1, type: 'time:ping', requestId: requestId(id), clientTime: 0 });
        await client.waitFor((message) => message.type === 'time:pong' && message.requestId === requestId(id));
      }

      const create = { version: 1, type: 'room:create', requestId: requestId(111), themeId: 'retro', role: 'a' };
      await client.send(create);
      const limited = await client.waitFor((message) => message.type === 'error' && message.requestId === requestId(111));
      expect(fixture.store.countOccupiedPlaces()).toBe(0);
      expect(limited.type).toBe('error');
      if (limited.type !== 'error') throw new Error('rate-limit response missing');
      expect(limited.code).toBe('rate_limited');

      fixture.setNow(1000);
      await client.send(create);
      const replay = await client.waitFor((message) =>
        (message.type === 'error' && message.requestId === requestId(111)) ||
        (message.type === 'room:joined' && message.requestId === requestId(111)));
      expect(fixture.store.countOccupiedPlaces()).toBe(0);
      expect(replay.type).toBe('error');
      if (replay.type !== 'error') throw new Error('cached rate-limit response missing');
      expect(replay.code).toBe('rate_limited');
    } finally {
      await fixture.close(clients);
    }
  });

  it('keeps a TCP socket in the connection cap until the peer actually closes', async () => {
    const fixture = await createRealtimeFixture({ socketLimit: 1 });
    const clients = [];
    let raw: Socket | undefined;
    try {
      raw = await openRawWebSocket(fixture.url);
      expect(fixture.store.countSockets()).toBe(1);
      fixture.setNow(5000);
      fixture.handle.advance(5000);
      expect(fixture.store.countSockets()).toBe(1);

      const blocked = await rejectUpgrade(fixture.url);
      expect(blocked).toBe(503);

      raw.destroy();
      await waitUntil(() => fixture.store.countSockets() === 0);
      const replacement = await openClient(fixture.url);
      clients.push(replacement);
      expect(fixture.store.countSockets()).toBe(1);
    } finally {
      raw?.destroy();
      await fixture.close(clients);
    }
  });

  it('releases a reserved socket slot when the WebSocket handshake key is malformed', async () => {
    const fixture = await createRealtimeFixture({ socketLimit: 2 });
    const clients: Awaited<ReturnType<typeof openClient>>[] = [];
    try {
      expect(await rejectMalformedHandshake(fixture.url)).toBe(400);
      expect(await rejectMalformedHandshake(fixture.url)).toBe(400);

      const replacement = await openClient(fixture.url);
      clients.push(replacement);
      expect(fixture.store.countSockets()).toBe(1);
    } finally {
      await fixture.close(clients);
    }
  });

  it('detects a missing pong from the last pong time and starts the 30-second reserve on detection', async () => {
    const fixture = await createRealtimeFixture();
    const client = await openClient(fixture.url, TEST_ORIGIN, false);
    try {
      await client.send({ version: 1, type: 'room:create', requestId: requestId(40), themeId: 'winter', role: 'a' });
      const joined = await client.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('credential missing');

      fixture.setNow(10_000);
      fixture.handle.advance(10_000);
      fixture.setNow(20_000);
      fixture.handle.advance(20_000);
      await waitForClientClose(client.socket);
      await waitUntil(() => fixture.store.getSession(joined.credential.playerId)?.reserveDeadline === 50_000);
      const session = fixture.store.getSession(joined.credential.playerId);
      expect(session?.reserveDeadline).toBe(50_000);

      fixture.setNow(49_999);
      fixture.handle.advance(49_999);
      expect(fixture.store.countOccupiedPlaces()).toBe(1);
      fixture.setNow(50_000);
      fixture.handle.advance(50_000);
      expect(fixture.store.countOccupiedPlaces()).toBe(0);
    } finally {
      await fixture.close([client]);
    }
  });

  it('skips periodic snapshots under buffer pressure, disconnects after five seconds, and exposes bounded aggregate metrics', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    const bufferedAmount = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(262_145);
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(41), themeId: 'retro', role: 'a' });
      const joined = await host.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('host credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(42), roomId: joined.credential.roomId });
      await peer.waitFor((message) => message.type === 'room:joined');
      await host.send({ version: 1, type: 'player:ready', requestId: requestId(43), ready: true });
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(44), ready: true });
      await host.waitFor((message) => message.type === 'round:start');

      fixture.setNow(5000);
      fixture.handle.advance(5000);
      fixture.setNow(10_000);
      fixture.handle.advance(10_000);
      const closeCodes = await Promise.all(clients.map((client) => waitForClientClose(client.socket)));
      expect(closeCodes).toEqual([1013, 1013]);
      const metrics = fixture.handle.metrics.snapshot();
      expect(metrics.backpressureSkips).toBeGreaterThan(0);
      expect(metrics.steps).toBeGreaterThan(0);
      expect(metrics.droppedSimulationMs).toBeGreaterThan(0);
      const metricValues = [metrics.steps, metrics.droppedSimulationMs, metrics.queuedInputs, metrics.backpressureSkips,
        metrics.socketCount, metrics.roomCount, metrics.occupiedPlaces, metrics.tickDuration.count,
        metrics.tickDuration.p50, metrics.tickDuration.p95, metrics.tickDuration.p99, metrics.tickDuration.max];
      expect(metricValues.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(metrics).toMatchObject({ queuedInputs: expect.any(Number), socketCount: expect.any(Number), roomCount: expect.any(Number), occupiedPlaces: expect.any(Number) });
      expect(metrics.tickDuration).toMatchObject({ count: expect.any(Number), p50: expect.any(Number), p95: expect.any(Number), p99: expect.any(Number), max: expect.any(Number) });
      expect(JSON.stringify(metrics)).not.toMatch(/sessionToken|playerId|ABCDEFGH/);
    } finally {
      bufferedAmount.mockRestore();
      await fixture.close(clients);
    }
  });

  it('measures periodic snapshot encoding as part of total tick duration', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    let simulatedCpuMs = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => simulatedCpuMs);
    const originalStringify = JSON.stringify.bind(JSON);
    const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'world:update') simulatedCpuMs += 7;
      return originalStringify(value);
    });
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(121), themeId: 'retro', role: 'a' });
      const joined = await host.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('host credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(122), roomId: joined.credential.roomId });
      await peer.waitFor((message) => message.type === 'room:joined');
      await host.send({ version: 1, type: 'player:ready', requestId: requestId(123), ready: true });
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(124), ready: true });
      await host.waitFor((message) => message.type === 'round:start');

      simulatedCpuMs = 0;
      fixture.setNow(50);
      fixture.handle.advance(50);
      expect(fixture.handle.metrics.snapshot().tickDuration.max).toBeGreaterThanOrEqual(7);
    } finally {
      stringifySpy.mockRestore();
      nowSpy.mockRestore();
      await fixture.close(clients);
    }
  });

  it('clears the realtime interval during shutdown and makes later advances inert', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const fixture = await createRealtimeFixture({ autoSchedule: true });
      expect(vi.getTimerCount()).toBe(1);
      await fixture.handle.close();
      expect(vi.getTimerCount()).toBe(0);
      fixture.handle.advance(50);
      expect(fixture.handle.metrics.snapshot().steps).toBe(0);
      await fixture.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function openRawWebSocket(url: string): Promise<Socket> {
  const { hostname, port } = new URL(url);
  const socket = createConnection({ host: hostname, port: Number(port) });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('raw TCP connect timed out')), 1500);
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    function finish(error?: Error): void {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    socket.once('connect', onConnect);
    socket.once('error', onError);
  }).catch((error: unknown) => { socket.destroy(); throw error; });

  const response = new Promise<string>((resolve, reject) => {
    let bytes = '';
    const timer = setTimeout(() => finish(new Error('raw websocket handshake timed out')), 1500);
    const onData = (chunk: Buffer) => {
      bytes += chunk.toString('latin1');
      const end = bytes.indexOf('\r\n\r\n');
      if (end >= 0) finish(undefined, bytes.slice(0, end));
    };
    function finish(error?: Error, headers?: string): void {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      if (error) reject(error);
      else resolve(headers ?? '');
    }
    socket.on('data', onData);
    socket.write([
      'GET /date-run/ws HTTP/1.1',
      `Host: ${hostname}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Origin: ${TEST_ORIGIN}`,
      '',
      '',
    ].join('\r\n'));
  });
  const headers = await response.catch((error: unknown) => { socket.destroy(); throw error; });
  if (!headers.startsWith('HTTP/1.1 101')) {
    socket.destroy();
    throw new Error('raw websocket upgrade was rejected');
  }
  return socket;
}

async function rejectUpgrade(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin: TEST_ORIGIN });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('rejected upgrade timed out')); }, 1500);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => { clearTimeout(timer); reject(new Error('upgrade unexpectedly succeeded')); });
    socket.once('error', () => undefined);
  });
}

async function rejectMalformedHandshake(url: string): Promise<number> {
  const target = new URL(url);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('malformed websocket handshake timed out')), 1500);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('latin1');
      const match = /^HTTP\/1\.1 (\d+)/.exec(text);
      if (match?.[1]) finish(undefined, Number(match[1]));
    };
    const onError = (error: Error) => finish(error);
    const onConnect = () => socket.write([
      'GET /date-run/ws HTTP/1.1',
      `Host: ${target.hostname}:${target.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: malformed',
      'Sec-WebSocket-Version: 13',
      `Origin: ${TEST_ORIGIN}`,
      '',
      '',
    ].join('\r\n'));
    function finish(error?: Error, status?: number): void {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('connect', onConnect);
      socket.destroy();
      if (error) reject(error);
      else resolve(status ?? 0);
    }
    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('error', onError);
  });
}
