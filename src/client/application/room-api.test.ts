import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from 'node:timers';
import type { RoomPreview } from '../../shared/model.js';
import { appUrls } from '../platform/app-urls.js';
import { RoomApi, RoomApiError } from './room-api.js';

const preview: RoomPreview = {
  roomId: 'ABCD2345',
  themeId: 'first-date',
  availableRole: 'b',
  phase: 'lobby',
  occupiedPlaces: 1,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stalledResponse(): { response: Response; close: () => void } {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    close: () => streamController?.close(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RoomApi.preview', () => {
  it('normalizes the room code, requests the same-origin preview, and validates the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(preview));
    const api = new RoomApi(appUrls('https://example.org'), { fetch });

    await expect(api.preview(' abcd2345 ')).resolves.toEqual(preview);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.org/date-run/api/rooms/ABCD2345');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('rejects invalid room codes before making a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const api = new RoomApi(appUrls('https://example.org'), { fetch });

    await expect(api.preview('bad-code')).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'room_not_found'],
    [429, 'rate_limited'],
    [503, 'network_error'],
  ] as const)('maps HTTP %i to %s without exposing response content', async (status, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ token: 'private-value' }, status));
    const api = new RoomApi(appUrls('https://example.org'), { fetch });

    let caught: unknown;
    try {
      await api.preview('ABCD2345');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RoomApiError);
    expect(caught).toMatchObject({ code });
    expect(String(caught)).not.toContain('private-value');
  });

  it('rejects malformed successful responses as invalid_response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...preview, credential: 'private-value' }));
    const api = new RoomApi(appUrls('https://example.org'), { fetch });

    await expect(api.preview('ABCD2345')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('maps fetch rejection to network_error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('offline'));
    const api = new RoomApi(appUrls('https://example.org'), { fetch });

    await expect(api.preview('ABCD2345')).rejects.toMatchObject({ code: 'network_error' });
  });

  it('calls the default fetch with the global receiver', async () => {
    const nativeReceiverFetch: typeof fetch = function (this: unknown, ...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
      void args;
      if (this !== globalThis) return Promise.reject(new TypeError('Illegal invocation'));
      return Promise.resolve(response(preview));
    };
    vi.stubGlobal('fetch', nativeReceiverFetch);
    const api = new RoomApi(appUrls('https://example.org'));

    await expect(api.preview('ABCD2345')).resolves.toEqual(preview);
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(stalled.response);
    const api = new RoomApi(appUrls('https://example.org'), { fetch });
    const outcome = api.preview('ABCD2345').then(() => null, (error: unknown) => error);

    try {
      await vi.advanceTimersByTimeAsync(5000);
      const result = await Promise.race([outcome, Promise.resolve('pending')]);
      expect(result).toMatchObject({ code: 'timeout' });
    } finally {
      stalled.close();
      await outcome;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors caller abort while reading the response body', async () => {
    vi.useFakeTimers();
    const stalled = stalledResponse();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(stalled.response);
    const api = new RoomApi(appUrls('https://example.org'), { fetch });
    const controller = new AbortController();
    const outcome = api.preview('ABCD2345', controller.signal).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    let deadlineTimer: NodeJS.Timeout | undefined;

    try {
      for (let attempt = 0; attempt < 10 && !stalled.response.body?.locked; attempt += 1) await Promise.resolve();
      expect(stalled.response.body?.locked).toBe(true);
      controller.abort();
      const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
        deadlineTimer = setRealTimeout(() => resolve({ kind: 'deadline' }), 1000);
      });
      const result = await Promise.race([outcome, deadline]);
      expect(result).toMatchObject({ kind: 'rejected', error: { code: 'aborted' } });
    } finally {
      if (deadlineTimer !== undefined) clearRealTimeout(deadlineTimer);
      stalled.close();
      await outcome;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes caller abort from its timeout and removes the timeout after completion', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const api = new RoomApi(appUrls('https://example.org'), { fetch, timeoutMs: 5000 });
    const controller = new AbortController();
    const callerAbort = api.preview('ABCD2345', controller.signal);
    controller.abort();
    await expect(callerAbort).rejects.toMatchObject({ code: 'aborted' });

    const timedOut = api.preview('ABCD2345');
    const timeoutRejection = expect(timedOut).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await timeoutRejection;
    expect(vi.getTimerCount()).toBe(0);

    fetch.mockResolvedValue(response(preview));
    await expect(api.preview('ABCD2345')).resolves.toEqual(preview);
    expect(vi.getTimerCount()).toBe(0);
  });
});
