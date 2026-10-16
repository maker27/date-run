import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Histogram, type LoadReport } from './report.js';
import { parseLoadOptions, runLoadScenario } from './run.js';
import { SessionStore } from '../../src/server/realtime/session-store.js';
import { attachWebSocketServer } from '../../src/server/realtime/ws-server.js';

async function createTarget(): Promise<{ url: string; socketCount(): number; close(): Promise<void> }> {
  const server: HttpServer = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test target did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  const store = new SessionStore({ clock: () => performance.now(), uuid: randomUUID });
  const realtime = attachWebSocketServer(server, store, { allowedOrigins: [origin] });
  return {
    url: `ws://127.0.0.1:${address.port}/date-run/ws`,
    socketCount: () => store.countSockets(),
    async close() {
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}

describe('load scenario runner', () => {
  it('requires an explicit target and confirmation, and validates scenario bounds', () => {
    expect(() => parseLoadOptions([], {})).toThrow(/TARGET_URL/);
    expect(() => parseLoadOptions(['--clients=2'], { TARGET_URL: 'ws://127.0.0.1:3000' })).toThrow(/confirm-test-target/);
    expect(() => parseLoadOptions(['--clients=0', '--confirm-test-target'], { TARGET_URL: 'ws://127.0.0.1:3000' })).toThrow(/clients/);
    expect(parseLoadOptions(['--clients=2', '--rooms=1', '--confirm-test-target'], { TARGET_URL: 'ws://127.0.0.1:3000' })).toMatchObject({ clients: 2, rooms: 1 });
  });

  it('measures an actual WebSocket target and reports bounded aggregate observations', async () => {
    const target = await createTarget();
    try {
      const report = await runLoadScenario({
        targetUrl: target.url,
        clients: 2,
        rooms: 1,
        warmupSeconds: 0,
        durationSeconds: 1,
        rttMs: 0,
        confirmTestTarget: true,
      });

      expect(report.activePlayingRooms).toBe(1);
      expect(report.unexpectedDisconnects).toBe(0);
      expect(report.reconnectsRecovered).toBe(0);
      expect(report.snapshots).toBeGreaterThan(0);
      expect(Number.isFinite(report.snapshotAgeP95Ms)).toBe(true);
      expect(report.errors).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('rejects an unexpected WebSocket path before connecting', async () => {
    await expect(runLoadScenario({
      targetUrl: 'ws://127.0.0.1:1/room',
      clients: 2,
      rooms: 1,
      warmupSeconds: 0,
      durationSeconds: 1,
      rttMs: 0,
      confirmTestTarget: true,
    })).rejects.toThrow(/TARGET_URL/);
  });

  it.each([
    ['warmup', -1],
    ['duration', 0],
    ['rtt', -1],
  ] as const)('rejects invalid direct %s values before connecting', async (name, value) => {
    const target = await createTarget();
    try {
      await expect(runLoadScenario({
        targetUrl: target.url,
        clients: 2,
        rooms: 1,
        warmupSeconds: name === 'warmup' ? value : 0,
        durationSeconds: name === 'duration' ? value : 1,
        rttMs: name === 'rtt' ? value : 0,
        confirmTestTarget: true,
      })).rejects.toThrow();
      expect(target.socketCount()).toBe(0);
    } finally {
      await target.close();
    }
  });

  it('rejects an already-aborted run before opening client sockets', async () => {
    const target = await createTarget();
    const controller = new AbortController();
    controller.abort();
    try {
      const options = {
        targetUrl: target.url,
        clients: 2,
        rooms: 1,
        warmupSeconds: 0,
        durationSeconds: 1,
        rttMs: 0,
        confirmTestTarget: true,
        signal: controller.signal,
      };
      await expect(runLoadScenario(options)).rejects.toThrow(/abort/i);
      expect(target.socketCount()).toBe(0);
    } finally {
      await target.close();
    }
  });

  it('applies the configured RTT through a local TCP proxy', async () => {
    const target = await createTarget();
    const startedAt = performance.now();
    try {
      const report = await runLoadScenario({
        targetUrl: target.url,
        clients: 2,
        rooms: 1,
        warmupSeconds: 0,
        durationSeconds: 1,
        rttMs: 100,
        confirmTestTarget: true,
      });

      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(report.activePlayingRooms).toBe(1);
      expect(report.snapshots).toBeGreaterThan(0);
      expect(report.errors).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('keeps percentile estimates meaningful after the bounded histogram saturates', () => {
    const histogram = new Histogram();
    for (let value = 0; value < 1000; value += 1) histogram.record(value);

    expect(histogram.percentile(0.95)).toBeGreaterThanOrEqual(950);
  });

  it('rejects a steady load report when input cadence falls below its acceptance target', async () => {
    const { loadFailures } = await import('./report.js');
    const report: LoadReport = {
      activePlayingRooms: 100,
      completedRooms: 0,
      snapshots: 100,
      inputsSent: 11_880,
      inputHzPerClient: 59.4,
      expectedLateInputs: 0,
      snapshotAgeP95Ms: 200,
      unexpectedDisconnects: 0,
      reconnectsRecovered: 20,
      acceptedGifts: 0,
      duplicateGifts: 0,
      queueOverflows: 0,
      bytesReceivedPerSecond: 1,
      bytesSentPerSecond: 1,
      errors: [],
    };

    expect(loadFailures(report, { rooms: 100, clients: 200, mode: 'steady' })).toEqual([]);
    expect(loadFailures({ ...report, inputHzPerClient: 10 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, duplicateGifts: 1 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, snapshots: 0 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, activePlayingRooms: 99 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, unexpectedDisconnects: 1 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, queueOverflows: 1 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, snapshotAgeP95Ms: 201 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, errors: ['target rejected input'] }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
    expect(loadFailures({ ...report, reconnectsRecovered: 19 }, { rooms: 100, clients: 200, mode: 'steady' })).not.toEqual([]);
  });

  it('requires all rooms and gifts in completion mode', async () => {
    const { loadFailures } = await import('./report.js');
    const report: LoadReport = {
      activePlayingRooms: 0,
      completedRooms: 100,
      snapshots: 100,
      inputsSent: 0,
      inputHzPerClient: 0,
      expectedLateInputs: 0,
      snapshotAgeP95Ms: 200,
      unexpectedDisconnects: 0,
      reconnectsRecovered: 0,
      acceptedGifts: 200,
      duplicateGifts: 0,
      queueOverflows: 0,
      bytesReceivedPerSecond: 1,
      bytesSentPerSecond: 1,
      errors: [],
    };

    expect(loadFailures(report, { rooms: 100, clients: 200, mode: 'completion' })).toEqual([]);
    expect(loadFailures({ ...report, completedRooms: 99 }, { rooms: 100, clients: 200, mode: 'completion' })).not.toEqual([]);
    expect(loadFailures({ ...report, acceptedGifts: 199 }, { rooms: 100, clients: 200, mode: 'completion' })).not.toEqual([]);
    expect(loadFailures({ ...report, duplicateGifts: 1 }, { rooms: 100, clients: 200, mode: 'completion' })).not.toEqual([]);
  });
});
