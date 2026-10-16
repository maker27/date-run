import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createHttpServer } from '../../src/server/http/http-server.js';
import { parseServerConfig, resolveClientIp } from '../../src/server/http/config.js';
import { SessionStore } from '../../src/server/realtime/session-store.js';
import { attachWebSocketServer } from '../../src/server/realtime/ws-server.js';

async function main(): Promise<void> {
  const config = parseServerConfig(process.env);
  const quotaCores = Number(process.env.CPU_QUOTA_CORES ?? '2');
  if (!Number.isFinite(quotaCores) || quotaCores <= 0) throw new Error('Invalid CPU_QUOTA_CORES');
  const store = new SessionStore({ clock: () => performance.now(), uuid: randomUUID });
  const http = createHttpServer(store, config);
  const realtime = attachWebSocketServer(http.server, store, {
    allowedOrigins: config.allowedOrigins,
    resolveClientIp: (request) => resolveClientIp(request, config),
  });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    await new Promise<void>((resolve, reject) => {
      http.server.once('error', reject);
      http.server.listen(config.port, config.host, () => { http.server.off('error', reject); resolve(); });
    });
  } catch (error) {
    lag.disable();
    await realtime.close();
    throw error;
  }
  const address = http.server.address();
  if (!address || typeof address === 'string') throw new Error('Load server did not bind');
  process.stdout.write(`${JSON.stringify({ type: 'listening', port: address.port, quotaCoresDeclared: quotaCores })}\n`);
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  let peakRssBytes = 0;
  const interval = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    const elapsedMs = now - previousAt;
    previousCpu = process.cpuUsage();
    previousAt = now;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
    const cpuQuotaPercent = ((cpu.user + cpu.system) / 1000) / (elapsedMs * quotaCores) * 100;
    process.stdout.write(`${JSON.stringify({
      type: 'metrics', windowMs: Math.round(elapsedMs), quotaCoresDeclared: quotaCores,
      tickHistogramWindow: 'cumulative_since_start', cpuQuotaPercent: Math.round(cpuQuotaPercent * 10) / 10,
      rssBytes: process.memoryUsage.rss(), peakRssBytes,
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      ...realtime.metrics.snapshot(),
    })}\n`);
    lag.reset();
  }, 5000);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(interval);
    lag.disable();
    http.setShuttingDown();
    try {
      await realtime.close();
      await new Promise<void>((resolve, reject) => {
        http.server.close((error) => error ? reject(error) : resolve());
        http.server.closeIdleConnections();
      });
    } catch {
      process.stderr.write('Load server shutdown failed\n');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Load server failed'}\n`);
    process.exitCode = 1;
  }
}
