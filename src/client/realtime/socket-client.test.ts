import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequest } from '../../shared/protocol.js';
import { FakeClientSocket } from '../../../tests/fixtures/fake-client-socket.js';
import { SocketClient, SocketClientError } from './socket-client.js';

const leaveRequest = {
  version: 1,
  type: 'room:leave',
  requestId: '00000000-0000-4000-8000-000000000010',
} satisfies ClientRequest;

function setup(random = 0) {
  const sockets: FakeClientSocket[] = [];
  const client = new SocketClient('wss://example.org/date-run/ws', {
    socketFactory: () => {
      const socket = new FakeClientSocket();
      sockets.push(socket);
      return socket;
    },
    random: () => random,
  });

  return { client, sockets };
}

async function connect(client: SocketClient, sockets: FakeClientSocket[]): Promise<FakeClientSocket> {
  const connected = client.connect();
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('socket was not created');
  socket.open();
  await connected;
  return socket;
}

afterEach(() => vi.useRealTimers());

describe('SocketClient', () => {
  it('resolves connect on open and reports the current status to subscribers', async () => {
    const { client, sockets } = setup();
    const statuses: string[] = [];
    client.onStatus((status) => statuses.push(status));

    await connect(client, sockets);

    expect(statuses).toEqual(['closed', 'connecting', 'connected']);
    client.destroy();
  });

  it('times out a connection attempt and permits an explicit manual retry', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const first = client.connect();
    const rejection = expect(first).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(sockets).toHaveLength(1);

    const retry = client.connect();
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    await expect(retry).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    client.destroy();
  });

  it('aborts an in-progress connection and clears its connection timer', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const controller = new AbortController();
    const connecting = client.connect(controller.signal);
    const rejection = expect(connecting).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();

    await rejection;
    expect(sockets[0]?.closeCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    client.destroy();
  });

  it('applies capped jittered reconnect delays and stops after eight retry attempts', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const initial = await connect(client, sockets);

    initial.emitClose(1011);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = Math.min(500 * 2 ** attempt, 5000) * 0.8;
      await vi.advanceTimersByTimeAsync(delay);
      const retrySocket = sockets.at(-1);
      expect(retrySocket).toBeDefined();
      retrySocket?.emitClose(1011);
    }

    await vi.runOnlyPendingTimersAsync();
    expect(sockets).toHaveLength(9);
    expect(client.status).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    client.destroy();
  });

  it.each([1000, 1008, 1009, 4001, 4002, 4003])('does not retry fatal close code %i', async (code) => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);

    socket.emitClose(code);
    await vi.runOnlyPendingTimersAsync();

    expect(sockets).toHaveLength(1);
    expect(client.status).toBe('closed');
    client.destroy();
  });

  it('rejects timed out and aborted requests and removes their pending timers', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const timedOut = client.request(leaveRequest);
    const timeoutRejection = expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await timeoutRejection;

    const controller = new AbortController();
    const aborted = client.request({ ...leaveRequest, requestId: '00000000-0000-4000-8000-000000000011' }, controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted' });
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.sent).toHaveLength(2);
    client.destroy();
  });

  it('rejects pending work on destroy, clears timers and ignores callbacks from the old socket', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const pending = client.request(leaveRequest);
    const outcome = expect(pending).rejects.toMatchObject({ code: 'destroyed' });

    client.destroy();
    socket.receive({ version: 1, type: 'command:result', requestId: leaveRequest.requestId, command: 'room:leave', outcome: 'ok' });
    await outcome;

    expect(vi.getTimerCount()).toBe(0);
    expect(client.status).toBe('closed');
  });

  it('routes correlated replies only to their promise and publishes uncorrelated events once', async () => {
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));

    const reply = client.request(leaveRequest);
    socket.receive({ version: 1, type: 'command:result', requestId: leaveRequest.requestId, command: 'room:leave', outcome: 'ok' });
    await expect(reply).resolves.toMatchObject({ type: 'command:result' });
    socket.receive({ version: 1, type: 'room:closing', reason: 'idle', remainingMs: 1000 });
    expect(events).toEqual(['room:closing']);

    socket.receive({ version: 1, type: 'command:result', requestId: '00000000-0000-4000-8000-000000000099', command: 'room:leave', outcome: 'ok' });
    expect(events).toEqual(['room:closing']);

    const serverError = client.request({ ...leaveRequest, requestId: '00000000-0000-4000-8000-000000000012' });
    socket.receive({ version: 1, type: 'error', requestId: '00000000-0000-4000-8000-000000000012', code: 'rate_limited' });
    await expect(serverError).resolves.toMatchObject({ type: 'error', code: 'rate_limited' });
    socket.receive({ version: 1, type: 'error', code: 'room_full' });
    expect(events).toEqual(['room:closing', 'error']);
    client.destroy();
  });

  it('closes malformed protocol data with 4003 and exposes no raw packet', async () => {
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const pending = client.request(leaveRequest);
    const outcome = expect(pending).rejects.toBeInstanceOf(SocketClientError);

    socket.receive({ version: 1, type: 'error', code: 'private-packet-content' });
    await outcome;

    expect(socket.closeCalls[0]).toMatchObject({ code: 4003 });
    expect(String(await pending.catch((error: unknown) => error))).not.toContain('private-packet-content');
    expect(client.status).toBe('closed');
    client.destroy();
  });

  it.each(['disconnect', 'destroy', 'protocol_failure'] as const)('removes socket listeners after %s and ignores late callbacks', async (termination) => {
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const events: string[] = [];
    client.onEvent((event) => events.push(event.type));
    expect(socket.activeListenerCount).toBeGreaterThan(0);

    if (termination === 'disconnect') client.disconnect();
    else if (termination === 'destroy') client.destroy();
    else socket.receive({ version: 1, type: 'room:closing', reason: 'idle' });

    socket.receive({ version: 1, type: 'room:closing', reason: 'idle', remainingMs: 1000 });
    expect(socket.activeListenerCount).toBe(0);
    expect(events).toEqual([]);
    client.destroy();
  });

  it('never replays a request across a transient reconnect and rejects input while disconnected', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    const socket = await connect(client, sockets);
    const create = client.request({
      version: 1,
      type: 'room:create',
      requestId: '00000000-0000-4000-8000-000000000013',
      themeId: 'winter',
      role: 'a',
    });
    const interact = client.request({
      version: 1,
      type: 'world:interact',
      requestId: '00000000-0000-4000-8000-000000000014',
      epoch: 0,
      objectId: 'gift-a',
    });
    const createRejection = expect(create).rejects.toMatchObject({ code: 'disconnected' });
    const interactRejection = expect(interact).rejects.toMatchObject({ code: 'disconnected' });

    socket.emitClose(1011);
    await Promise.all([createRejection, interactRejection]);
    expect(socket.sent).toHaveLength(2);
    expect(() => client.sendInput({
      version: 1,
      type: 'input:update',
      epoch: 0,
      inputGeneration: 1,
      seq: 1,
      input: { axis: 0, jumpPressed: false },
    })).toThrowError(SocketClientError);
    client.destroy();
  });

  it('applies the jitter upper bound and caps the backoff at five seconds', async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup(1);
    const initial = await connect(client, sockets);
    initial.emitClose(1011);

    await vi.advanceTimersByTimeAsync(600);
    expect(sockets).toHaveLength(2);
    sockets[1]?.emitClose(1011);
    await vi.advanceTimersByTimeAsync(1200);
    expect(sockets).toHaveLength(3);
    sockets[2]?.emitClose(1011);
    await vi.advanceTimersByTimeAsync(2400);
    expect(sockets).toHaveLength(4);
    sockets[3]?.emitClose(1011);
    await vi.advanceTimersByTimeAsync(6000);
    expect(sockets).toHaveLength(5);
    client.destroy();
  });
});
