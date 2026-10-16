import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { localPlayerId, makeSnapshot } from '../fixtures/world-snapshot.js';
import { ClientMessageSchema, type ClientMessage } from '../../src/shared/protocol.js';
import { LoadClient } from './client.js';
import { ReportCollector } from './report.js';

async function createTarget(onMessage: (socket: WebSocket, message: ClientMessage) => void) {
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  server.on('connection', (socket) => socket.on('message', (data) => onMessage(socket, ClientMessageSchema.parse(JSON.parse(data.toString())))));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Load test server did not bind');
  return {
    url: `ws://127.0.0.1:${address.port}/date-run/ws`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function replyJoined(socket: WebSocket, message: Extract<ClientMessage, { type: 'room:create' }>): void {
  socket.send(JSON.stringify({
    version: 1,
    type: 'room:joined',
    requestId: message.requestId,
    credential: { schemaVersion: 1, roomId: 'ABCD2345', playerId: localPlayerId, sessionToken: randomUUID(), nextSeq: 1 },
    rejoinState: { inputGeneration: 1, nextSeq: 1 },
    snapshot: makeSnapshot(),
  }));
}

function replyPing(socket: WebSocket, message: Extract<ClientMessage, { type: 'time:ping' }>): void {
  socket.send(JSON.stringify({ version: 1, type: 'time:pong', requestId: message.requestId, clientTime: message.clientTime, serverTime: performance.now() }));
}

describe('load client lifecycle accounting', () => {
  it('does not count the server closing a departed session as an unexpected disconnect', async () => {
    const departed = Promise.withResolvers<void>();
    const target = await createTarget((socket, message) => {
      if (message.type === 'time:ping') replyPing(socket, message);
      else if (message.type === 'room:create') replyJoined(socket, message);
      else if (message.type === 'room:leave') {
        socket.once('close', () => departed.resolve());
        socket.send(JSON.stringify({ version: 1, type: 'command:result', requestId: message.requestId, command: 'room:leave', outcome: 'ok' }));
        socket.close(1008, 'session has left');
      }
    });
    const report = new ReportCollector();
    const client = new LoadClient(target.url, 'http://127.0.0.1:4173', 'a', report);
    try {
      await client.connect();
      await client.create();
      await client.leave();
      await departed.promise;
      await expect.poll(() => report.unexpectedDisconnects).toBe(0);
    } finally {
      await client.close();
      await target.close();
    }
  });

  it('counts an invalid-phase reply after completion as a late input, not an unexpected server error', async () => {
    const target = await createTarget((socket, message) => {
      if (message.type === 'time:ping') replyPing(socket, message);
      else if (message.type === 'room:create') replyJoined(socket, message);
      else if (message.type === 'input:update') {
        const completed = makeSnapshot();
        completed.state.phase = 'complete';
        socket.send(JSON.stringify({ version: 1, type: 'room:complete', snapshot: completed }));
        setTimeout(() => socket.send(JSON.stringify({ version: 1, type: 'error', code: 'invalid_phase' })), 10);
      }
    });
    const report = new ReportCollector();
    const client = new LoadClient(target.url, 'http://127.0.0.1:4173', 'a', report);
    try {
      await client.connect();
      await client.create();
      await client.input({ axis: 1, jumpPressed: false });
      await expect.poll(() => report.expectedLateInputs).toBe(1);
      expect(report.errors).toEqual([]);
    } finally {
      await client.close();
      await target.close();
    }
  });

  it('still reports invalid-phase input errors while playing and correlated request errors', async () => {
    const target = await createTarget((socket, message) => {
      if (message.type === 'time:ping') replyPing(socket, message);
      else if (message.type === 'room:create') replyJoined(socket, message);
      else if (message.type === 'input:update') {
        socket.send(JSON.stringify({ version: 1, type: 'error', code: 'invalid_phase' }));
        const completed = makeSnapshot();
        completed.state.phase = 'complete';
        socket.send(JSON.stringify({ version: 1, type: 'room:complete', snapshot: completed }));
      }
      else if (message.type === 'world:interact') socket.send(JSON.stringify({ version: 1, type: 'error', requestId: message.requestId, code: 'invalid_phase' }));
    });
    const report = new ReportCollector();
    const client = new LoadClient(target.url, 'http://127.0.0.1:4173', 'a', report);
    try {
      await client.connect();
      await client.create();
      await client.input({ axis: 1, jumpPressed: false });
      await expect.poll(() => report.errors.length).toBe(1);
      await expect.poll(() => client.snapshot?.state.phase).toBe('complete');
      await expect(client.collectGift('gift-a')).rejects.toThrow(/error/);
      expect(report.errors).toHaveLength(2);
      expect(report.expectedLateInputs).toBe(0);
    } finally {
      await client.close();
      await target.close();
    }
  });
});
