import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SessionStore } from './realtime/session-store.js';
import { attachWebSocketServer } from './realtime/ws-server.js';
import { resolveClientIp, parseServerConfig, type ServerConfig } from './http/config.js';
import { createHttpServer } from './http/http-server.js';

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new RangeError('Invalid PORT');
  const store = new SessionStore({ clock: () => performance.now(), uuid: randomUUID });
  const http = createHttpServer(store, config);
  const realtime = attachWebSocketServer(http.server, store, {
    allowedOrigins: config.allowedOrigins,
    resolveClientIp: (request) => resolveClientIp(request, config),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { http.server.off('listening', onListening); reject(error); };
      const onListening = () => { http.server.off('error', onError); resolve(); };
      http.server.once('error', onError);
      http.server.once('listening', onListening);
      http.server.listen(config.port, config.host);
    });
  } catch (error) {
    await realtime.close();
    throw error;
  }
  const address = http.server.address();
  if (!address || typeof address === 'string') { await realtime.close(); throw new Error('Server listen failed'); }
  let closePromise: Promise<void> | undefined;
  return {
    port: address.port,
    close() {
      if (closePromise) return closePromise;
      http.setShuttingDown();
      closePromise = (async () => {
        const deadline = setTimeout(() => http.server.closeAllConnections(), 8000);
        try {
          await realtime.close();
          await new Promise<void>((resolve, reject) => {
            http.server.close((error) => error ? reject(error) : resolve());
            http.server.closeIdleConnections();
          });
        } finally { clearTimeout(deadline); }
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = parseServerConfig(process.env);
    const handle = await startServer(config);
    process.stdout.write(`Date Run listening on port ${handle.port}, revision ${config.revision}\n`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void handle.close().catch(() => {
          process.stderr.write('Server shutdown failed\n');
          process.exitCode = 1;
        });
      });
    }
  } catch {
    process.stderr.write('Server startup failed\n');
    process.exitCode = 1;
  }
}
