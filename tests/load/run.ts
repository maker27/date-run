import { createServer, connect, type Server, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';
import { LoadClient } from './client.js';
import { loadFailures, ReportCollector, type LoadReport } from './report.js';
import { PlayerRoute, type ScenarioMode } from './scenarios.js';

export interface LoadOptions {
  targetUrl: string;
  clients: number;
  rooms: number;
  warmupSeconds: number;
  durationSeconds: number;
  rttMs: number;
  confirmTestTarget: boolean;
  mode?: ScenarioMode;
  signal?: AbortSignal;
}

function numberOption(args: readonly string[], name: string, fallback: number): number {
  const values = args.filter((value) => value.startsWith(`--${name}=`));
  if (values.length > 1) throw new Error(`Duplicate ${name}`);
  if (!values.length) return fallback;
  const value = Number(values[0]?.split('=')[1]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function parseLoadOptions(args: readonly string[], env: Readonly<Record<string, string | undefined>>): LoadOptions {
  const targetUrl = env.TARGET_URL;
  if (!targetUrl) throw new Error('TARGET_URL is required');
  const known = /^(--clients=|--rooms=|--warmup=|--duration=|--rtt=|--mode=|--confirm-test-target$)/;
  if (args.some((arg) => !known.test(arg))) throw new Error('Unknown load option');
  const confirmTestTarget = args.includes('--confirm-test-target');
  if (!confirmTestTarget) throw new Error('--confirm-test-target is required');
  const clients = numberOption(args, 'clients', 200);
  const rooms = numberOption(args, 'rooms', 100);
  const warmupSeconds = numberOption(args, 'warmup', 300);
  const durationSeconds = numberOption(args, 'duration', 1800);
  const rttMs = numberOption(args, 'rtt', 100);
  const modeOption = args.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) ?? 'steady';
  if (modeOption !== 'steady' && modeOption !== 'completion') throw new Error('Invalid mode');
  if (!Number.isInteger(clients) || clients < 2 || clients > 200 || clients % 2 !== 0) throw new Error('Invalid clients');
  if (!Number.isInteger(rooms) || rooms < 1 || rooms > 100 || rooms * 2 !== clients) throw new Error('Invalid rooms');
  if (!Number.isInteger(warmupSeconds) || warmupSeconds < 0 || warmupSeconds > 3600) throw new Error('Invalid warmup');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 7200) throw new Error('Invalid duration');
  if (!Number.isInteger(rttMs) || rttMs < 0 || rttMs > 1000) throw new Error('Invalid rtt');
  validateTarget(targetUrl);
  return { targetUrl, clients, rooms, warmupSeconds, durationSeconds, rttMs, confirmTestTarget, mode: modeOption };
}

function validateTarget(targetUrl: string): URL {
  let target: URL;
  try { target = new URL(targetUrl); } catch { throw new Error('Invalid TARGET_URL'); }
  if (!['ws:', 'wss:'].includes(target.protocol) || !['/', '/date-run/ws'].includes(target.pathname) || target.username || target.password || target.search || target.hash) {
    throw new Error('Invalid TARGET_URL: expected ws(s)://host/date-run/ws');
  }
  if (target.pathname === '/') target.pathname = '/date-run/ws';
  return target;
}

interface DelayProxy { url: string; close(): Promise<void> }

async function createDelayProxy(target: URL, rttMs: number): Promise<DelayProxy> {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: Server = createServer((incoming) => {
    const outgoing = connect(Number(target.port || (target.protocol === 'wss:' ? 443 : 80)), target.hostname);
    sockets.add(incoming);
    sockets.add(outgoing);
    const relay = (source: Socket, destination: Socket) => {
      let pendingBytes = 0;
      source.on('data', (chunk: Buffer) => {
        pendingBytes += chunk.length;
        if (pendingBytes > 262_144) { source.destroy(); destination.destroy(); return; }
        const timer = setTimeout(() => {
          timers.delete(timer);
          pendingBytes -= chunk.length;
          if (!destination.destroyed && !destination.write(chunk)) source.pause();
        }, rttMs / 2);
        timers.add(timer);
      });
      destination.on('drain', () => source.resume());
      source.on('error', () => destination.destroy());
      source.on('close', () => { sockets.delete(source); destination.destroy(); });
    };
    relay(incoming, outgoing);
    relay(outgoing, incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Delay proxy failed to bind');
  return {
    url: `${target.protocol}//127.0.0.1:${address.port}${target.pathname}`,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Load run aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error('Load run aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function waitUntilPlaying(clients: readonly LoadClient[], signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + 5000;
  while (roomCounts(clients).playing !== clients.length / 2) {
    if (performance.now() >= deadline) throw new Error('Rooms did not enter playing');
    await delay(20, signal);
  }
}

function roomCounts(clients: readonly LoadClient[]): { playing: number; complete: number } {
  let playing = 0;
  let complete = 0;
  for (let index = 0; index < clients.length; index += 2) {
    const first = clients[index];
    const second = clients[index + 1];
    if (!first || !second || !first.connected || !second.connected) continue;
    const a = first.snapshot;
    const b = second.snapshot;
    if (!a || !b || a.roomId !== b.roomId || a.epoch !== b.epoch) continue;
    if (a.state.phase === 'playing' && b.state.phase === 'playing' && !a.state.paused && !b.state.paused && first.hasFreshSnapshot && second.hasFreshSnapshot) playing += 1;
    if (a.state.phase === 'complete' && b.state.phase === 'complete') complete += 1;
  }
  return { playing, complete };
}

async function drive(routes: readonly PlayerRoute[], clients: readonly LoadClient[], seconds: number, report: ReportCollector, signal?: AbortSignal): Promise<{ minimumPlaying: number; maximumComplete: number }> {
  const end = performance.now() + seconds * 1000;
  let next = performance.now();
  let minimumPlaying = clients.length / 2;
  let maximumComplete = 0;
  while (performance.now() < end) {
    if (signal?.aborted) throw new Error('Load run aborted');
    const now = performance.now();
    const outcomes = await Promise.allSettled(clients.map((client, index) => client.input(routes[index]?.next(now) ?? { axis: 0, jumpPressed: false })));
    for (const outcome of outcomes) if (outcome.status === 'rejected') report.error(outcome.reason instanceof Error ? outcome.reason.message : 'Input send failed');
    const counts = roomCounts(clients);
    minimumPlaying = Math.min(minimumPlaying, counts.playing);
    maximumComplete = Math.max(maximumComplete, counts.complete);
    next += 1000 / 60;
    await delay(Math.max(0, next - performance.now()), signal);
    if (next < performance.now() - 1000 / 60) next = performance.now();
  }
  return { minimumPlaying, maximumComplete };
}

export async function runLoadScenario(options: LoadOptions): Promise<LoadReport> {
  if (!options.confirmTestTarget) throw new Error('--confirm-test-target is required');
  const target = validateTarget(options.targetUrl);
  if (!Number.isInteger(options.clients) || options.clients < 2 || options.clients > 200 || options.clients % 2 || options.rooms * 2 !== options.clients) throw new Error('Invalid clients/rooms');
  if (!Number.isInteger(options.warmupSeconds) || options.warmupSeconds < 0 || options.warmupSeconds > 3600
    || !Number.isInteger(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 7200
    || !Number.isInteger(options.rttMs) || options.rttMs < 0 || options.rttMs > 1000
    || options.mode !== undefined && options.mode !== 'steady' && options.mode !== 'completion') throw new Error('Invalid load duration, RTT or mode');
  if (options.signal?.aborted) throw new Error('Load run aborted');
  const report = new ReportCollector();
  const origin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
  const proxy = options.rttMs > 0 ? await createDelayProxy(target, options.rttMs) : null;
  const url = proxy?.url ?? target.href;
  const clients: LoadClient[] = [];
  let measured: { minimumPlaying: number; maximumComplete: number } | undefined;
  try {
    for (let index = 0; index < options.rooms; index += 1) {
      if (options.signal?.aborted) throw new Error('Load run aborted');
      const tlsServername = proxy && target.protocol === 'wss:' ? target.hostname : undefined;
      const first = new LoadClient(url, origin, 'a', report, target.host, tlsServername);
      const second = new LoadClient(url, origin, 'b', report, target.host, tlsServername);
      clients.push(first, second);
      await first.connect();
      const roomId = await first.create();
      await second.connect();
      await second.join(roomId);
      await first.ready();
      await second.ready();
      if (index % 10 === 9) await delay(100, options.signal);
    }
    await waitUntilPlaying(clients, options.signal);
    const routes = clients.map((client) => new PlayerRoute(client, options.mode ?? 'steady'));
    if (options.warmupSeconds) await drive(routes, clients, options.warmupSeconds, report, options.signal);
    if (options.clients >= 20 && options.mode !== 'completion') {
      for (let index = 0; index < 20; index += 1) {
        const client = clients[index];
        if (!client) throw new Error('Missing reconnect client');
        await client.rejoin();
        await waitUntilPlaying(clients.slice(index - index % 2, index - index % 2 + 2), options.signal);
        report.reconnectsRecovered += 1;
      }
    }
    report.resetMeasurement();
    measured = await drive(routes, clients, options.durationSeconds, report, options.signal);
  } finally {
    const flushed = await Promise.allSettled(clients.map((client) => client.connected ? client.flush() : Promise.resolve()));
    for (const result of flushed) if (result.status === 'rejected') report.error(result.reason instanceof Error ? result.reason.message : 'Flush failed');
    const departed = await Promise.allSettled(clients.map((client) => client.leave()));
    for (const result of departed) if (result.status === 'rejected') report.error(result.reason instanceof Error ? result.reason.message : 'Leave failed');
    await Promise.all(clients.map((client) => client.close()));
    await proxy?.close();
  }
  if (!measured) throw new Error('Load measurement did not complete');
  return report.result(measured.minimumPlaying, measured.maximumComplete, options.durationSeconds, options.clients);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseLoadOptions(process.argv.slice(2), process.env);
    const report = await runLoadScenario(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    const failures = loadFailures(report, options);
    if (failures.length) { process.stderr.write(`${failures.join('\n')}\n`); process.exitCode = 1; }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Load run failed'}\n`);
    process.exitCode = 1;
  }
}
