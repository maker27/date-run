import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createRealtimeFixture, openClient, requestId, waitForClientClose } from '../../../tests/fixtures/ws-test-helpers.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('WebSocket reconnect and input lifecycle', () => {
  it('continues sequence state on rejoin and makes the replaced socket powerless', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    const close = WebSocket.prototype.close;
    let injected = false;
    const closeSpy = vi.spyOn(WebSocket.prototype, 'close');
    try {
      const oldClient = await openClient(fixture.url);
      clients.push(oldClient);
      await oldClient.send({ version: 1, type: 'room:create', requestId: requestId(10), themeId: 'winter', role: 'a' });
      const first = await oldClient.waitFor((message) => message.type === 'room:joined');
      if (first.type !== 'room:joined') throw new Error('initial credential missing');
      const peer = await openClient(fixture.url);
      clients.push(peer);
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(20), roomId: first.credential.roomId });
      const peerJoined = await peer.waitFor((message) => message.type === 'room:joined');
      if (peerJoined.type !== 'room:joined') throw new Error('peer join missing');
      await oldClient.send({ version: 1, type: 'player:ready', requestId: requestId(21), ready: true });
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(22), ready: true });
      const round = await oldClient.waitFor((message) => message.type === 'round:start');
      if (round.type !== 'round:start') throw new Error('round did not start');
      await oldClient.send({ version: 1, type: 'input:update', epoch: round.snapshot.epoch, inputGeneration: round.snapshot.state.players[0]?.inputGeneration ?? 0, seq: 1, input: { axis: 1, jumpPressed: false } });
      await waitUntil(() => fixture.store.getSession(first.credential.playerId)?.lastAcceptedSeq === 1);
      const previousSocketId = fixture.store.getSession(first.credential.playerId)?.activeSocketId;
      if (!previousSocketId) throw new Error('active socket missing before replacement');
      const acceptedBeforeReplacement = fixture.store.getSession(first.credential.playerId)?.lastAcceptedSeq;

      closeSpy.mockImplementation(function (this: WebSocket, code, data) {
        if (code === 4001 && !injected) {
          injected = true;
          const session = fixture.store.getSession(first.credential.playerId);
          if (!session) throw new Error('Replacement session missing');
          const messages = [
            { version: 1, type: 'input:update', epoch: round.snapshot.epoch, inputGeneration: session.inputGeneration, seq: 2, input: { axis: -1, jumpPressed: true } },
            { version: 1, type: 'room:resync', requestId: requestId(30) },
            { version: 1, type: 'room:leave', requestId: requestId(31) },
            { version: 1, type: 'room:rejoin', requestId: requestId(32), sessionToken: first.credential.sessionToken },
          ];
          for (const message of messages) this.emit('message', Buffer.from(JSON.stringify(message)), false);
        }
        close.call(this, code, data);
      });

      const replacement = await openClient(fixture.url);
      clients.push(replacement);
      await replacement.send({ version: 1, type: 'room:rejoin', requestId: requestId(11), sessionToken: first.credential.sessionToken });
      const rejoined = await replacement.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(11));
      expect(rejoined.type).toBe('room:joined');
      if (rejoined.type !== 'room:joined') throw new Error('rejoin response missing');
      expect(rejoined.rejoinState.nextSeq).toBe(2);
      expect(rejoined.rejoinState.inputGeneration).toBeGreaterThan(first.rejoinState.inputGeneration);
      await oldClient.waitFor((message) => message.type === 'session:replaced');
      expect(await waitForClientClose(oldClient.socket)).toBe(4001);

      const session = fixture.store.getSession(first.credential.playerId);
      if (!session) throw new Error('session disappeared during replacement');
      expect(injected).toBe(true);
      expect(session.inputGeneration).toBe(rejoined.rejoinState.inputGeneration);
      expect(session.lastAcceptedSeq).toBe(acceptedBeforeReplacement);
      expect(fixture.store.getSessionBySocket(previousSocketId)).toBeUndefined();
      expect(session.activeSocketId).not.toBe(previousSocketId);
      expect(fixture.store.getSessionBySocket(session.activeSocketId ?? '')).toBe(session);
      expect(fixture.store.countOccupiedPlaces()).toBe(2);
      expect(fixture.store.getRoom(first.credential.roomId)?.paused).toBe(false);
      await replacement.send({ version: 1, type: 'input:update', epoch: rejoined.snapshot.epoch, inputGeneration: rejoined.rejoinState.inputGeneration, seq: 2, input: { axis: 1, jumpPressed: false } });
      await waitUntil(() => session.lastAcceptedSeq === 2);
      await replacement.send({ version: 1, type: 'room:resync', requestId: requestId(33) });
      const resynced = await replacement.waitFor((message) => message.type === 'room:resynced' && message.requestId === requestId(33));
      expect(resynced.type).toBe('room:resynced');
    } finally {
      closeSpy.mockRestore();
      await fixture.close(clients);
    }
  });

  it('does not extend a session reply cache entry when a repeated command is rate limited', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const originalClient = await openClient(fixture.url);
      clients.push(originalClient);
      await originalClient.send({ version: 1, type: 'room:create', requestId: requestId(710), themeId: 'retro', role: 'a' });
      const joined = await originalClient.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('room credential missing');

      const repeatedResync = { version: 1, type: 'room:resync', requestId: requestId(711) } as const;
      await originalClient.send(repeatedResync);
      const originalReply = await originalClient.waitFor((message) => message.type === 'room:resynced' && message.requestId === repeatedResync.requestId);
      if (originalReply.type !== 'room:resynced') throw new Error('initial resync reply missing');

      fixture.setNow(29_999);
      const replacement = await openClient(fixture.url);
      clients.push(replacement);
      await replacement.send({ version: 1, type: 'room:rejoin', requestId: requestId(712), sessionToken: joined.credential.sessionToken });
      const replacementJoin = await replacement.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(712));
      if (replacementJoin.type !== 'room:joined') throw new Error('replacement rejoin missing');

      for (let ping = 0; ping < 9; ping += 1) {
        const pingId = requestId(720 + ping);
        await replacement.send({ version: 1, type: 'time:ping', requestId: pingId, clientTime: 29_999 });
        await replacement.waitFor((message) => message.type === 'time:pong' && message.requestId === pingId);
      }
      await replacement.send(repeatedResync);
      const rateLimitedReplay = await replacement.waitFor((message) => message.type === 'room:resynced' && message.requestId === repeatedResync.requestId);
      expect(rateLimitedReplay).toEqual(originalReply);

      fixture.setNow(31_000);
      const thirdClient = await openClient(fixture.url);
      clients.push(thirdClient);
      await thirdClient.send({ version: 1, type: 'room:rejoin', requestId: requestId(713), sessionToken: joined.credential.sessionToken });
      const thirdJoin = await thirdClient.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(713));
      if (thirdJoin.type !== 'room:joined') throw new Error('third rejoin missing');
      await thirdClient.send(repeatedResync);
      const freshReply = await thirdClient.waitFor((message) => message.type === 'room:resynced' && message.requestId === repeatedResync.requestId);

      expect(freshReply.type).toBe('room:resynced');
      if (freshReply.type !== 'room:resynced') throw new Error('new resync reply missing');
      expect(freshReply.rejoinState.inputGeneration).toBe(thirdJoin.rejoinState.inputGeneration + 1);
      expect(freshReply.snapshot.serverTime).toBe(31_000);
      expect(freshReply).not.toEqual(originalReply);
    } finally {
      await fixture.close(clients);
    }
  });

  it('clears both players’ queued input and advances generation when disconnect pauses play', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      await host.send({ version: 1, type: 'room:create', requestId: requestId(12), themeId: 'first-date', role: 'a' });
      const joinedHost = await host.waitFor((message) => message.type === 'room:joined');
      if (joinedHost.type !== 'room:joined') throw new Error('host credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(13), roomId: joinedHost.credential.roomId });
      const joinedPeer = await peer.waitFor((message) => message.type === 'room:joined');
      if (joinedPeer.type !== 'room:joined') throw new Error('peer credential missing');
      await host.send({ version: 1, type: 'player:ready', requestId: requestId(14), ready: true });
      await peer.send({ version: 1, type: 'player:ready', requestId: requestId(15), ready: true });
      const playing = await host.waitFor((message) => message.type === 'round:start');
      expect(playing.type).toBe('round:start');
      if (playing.type !== 'round:start') throw new Error('round did not start');
      const generations = playing.snapshot.state.players.map(({ inputGeneration }) => inputGeneration);
      await host.send({ version: 1, type: 'input:update', epoch: playing.snapshot.epoch, inputGeneration: generations[0], seq: 1, input: { axis: 1, jumpPressed: false } });
      await peer.send({ version: 1, type: 'input:update', epoch: playing.snapshot.epoch, inputGeneration: generations[1], seq: 1, input: { axis: -1, jumpPressed: false } });

      const players = playing.snapshot.state.players;
      await waitUntil(() => players.every(({ id }) => fixture.store.getSession(id)?.lastAcceptedSeq === 1));

      peer.socket.terminate();
      await waitUntil(() => fixture.store.getRoom(playing.snapshot.roomId)?.paused === true);
      const paused = await host.waitFor((message) => message.type === 'room:state' && message.snapshot.state.paused);
      expect(paused.type).toBe('room:state');
      if (paused.type !== 'room:state') throw new Error('paused snapshot missing');
      expect(paused.snapshot.state.players.map(({ inputGeneration }) => inputGeneration)).toEqual(generations.map((value) => value + 1));
      expect(paused.snapshot.state.players.map(({ lastProcessedSeq }) => lastProcessedSeq)).toEqual([0, 0]);

      const replacement = await openClient(fixture.url);
      clients.push(replacement);
      await replacement.send({ version: 1, type: 'room:rejoin', requestId: requestId(25), sessionToken: joinedPeer.credential.sessionToken });
      const rejoined = await replacement.waitFor((message) => message.type === 'room:joined' && message.requestId === requestId(25));
      expect(rejoined.type).toBe('room:joined');
      await waitUntil(() => fixture.store.getRoom(playing.snapshot.roomId)?.paused === false);
      fixture.setNow(50);
      fixture.handle.advance(50);
      await waitUntil(() => (fixture.store.getRoom(playing.snapshot.roomId)?.tick ?? 0) >= 3);
      expect(fixture.store.getRoom(playing.snapshot.roomId)?.players.map(({ body }) => body)).toEqual(playing.snapshot.state.players.map(({ body }) => body));
      expect(fixture.store.getSession(joinedHost.credential.playerId)?.lastProcessedSeq).toBe(0);
    } finally {
      await fixture.close(clients);
    }
  });

  it('recovers a collected gift through resync after the interaction acknowledgement is lost', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const client = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(client, peer);
      await client.send({ version: 1, type: 'room:create', requestId: requestId(16), themeId: 'retro', role: 'a' });
      const joined = await client.waitFor((message) => message.type === 'room:joined');
      if (joined.type !== 'room:joined') throw new Error('credential missing');
      await peer.send({ version: 1, type: 'room:join', requestId: requestId(23), roomId: joined.credential.roomId });
      await peer.waitFor((message) => message.type === 'room:joined');

      const room = fixture.store.getRoom(joined.credential.roomId);
      if (!room) throw new Error('room missing');
      fixture.store.setRoom({
        ...room,
        phase: 'playing',
        players: room.players.map((current) => current.role === 'a'
          ? { ...current, body: { ...current.body, x: 204, y: 288, grounded: true } }
          : current),
      });
      const player = fixture.store.getSession(joined.credential.playerId);
      if (!player) throw new Error('session missing');
      const revisionBeforeInteract = fixture.store.getRoom(joined.credential.roomId)?.revision;
      await client.send({ version: 1, type: 'world:interact', requestId: requestId(17), epoch: 0, objectId: 'gift-a' });
      await waitUntil(() => fixture.store.snapshot(joined.credential.roomId, 1)?.state.gifts[0]?.collectedBy === joined.credential.playerId);
      await client.send({ version: 1, type: 'room:resync', requestId: requestId(24) });
      const resynced = await client.waitFor((message) => message.type === 'room:resynced' && message.requestId === requestId(24));
      expect(resynced.type).toBe('room:resynced');
      if (resynced.type !== 'room:resynced') throw new Error('resync response missing');
      expect(resynced.snapshot.state.gifts[0]?.collectedBy).toBe(joined.credential.playerId);
      expect(fixture.store.getRoom(joined.credential.roomId)?.revision).toBe((revisionBeforeInteract ?? 0) + 1);
      expect(client.received.filter((message) => message.type === 'world:interact:result')).toHaveLength(1);
      expect(player.lastAcceptedSeq).toBe(0);
    } finally {
      await fixture.close(clients);
    }
  });

  it('returns an expired disconnected reservation to the remaining player’s lobby', async () => {
    const fixture = await createRealtimeFixture();
    const clients = [];
    try {
      const host = await openClient(fixture.url);
      const peer = await openClient(fixture.url);
      clients.push(host, peer);
      host.send({ version: 1, type: 'room:create', requestId: requestId(18), themeId: 'winter', role: 'a' });
      const hostJoined = await host.waitFor((message) => message.type === 'room:joined');
      if (hostJoined.type !== 'room:joined') throw new Error('host credential missing');
      peer.send({ version: 1, type: 'room:join', requestId: requestId(19), roomId: hostJoined.credential.roomId });
      await peer.waitFor((message) => message.type === 'room:joined');

      peer.socket.terminate();
      await waitUntil(() => fixture.store.getRoom(hostJoined.credential.roomId)?.players.find(({ role }) => role === 'b')?.connected === false);
      fixture.setNow(30_000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('manual pong send timed out')), 1000);
        host.socket.pong(Buffer.alloc(0), true, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
      await host.send({ version: 1, type: 'time:ping', requestId: requestId(26), clientTime: 30_000 });
      await host.waitFor((message) => message.type === 'time:pong' && message.requestId === requestId(26));
      fixture.handle.advance(30_000);
      const returned = await host.waitFor((message) => message.type === 'room:state' && message.snapshot.epoch > hostJoined.snapshot.epoch && message.snapshot.state.players.length === 1);
      expect(returned.type).toBe('room:state');
      if (returned.type !== 'room:state') throw new Error('lobby state missing');
      expect(returned.snapshot.state.phase).toBe('lobby');
      expect(returned.snapshot.state.paused).toBe(false);
    } finally {
      await fixture.close(clients);
    }
  });
});
