import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { parseServerConfig } from '../../src/server/http/config.js';
import { startServer } from '../../src/server/index.ts';

describe('server scaffold', () => {
  it('serves live health and releases its port on close', async () => {
    const server = await startServer({ ...parseServerConfig({}), port: 0 });
    let responseStatus: number | undefined;
    let responseBody: unknown;

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/date-run/health/live`);
      responseStatus = response.status;
      responseBody = await response.json();
    } finally {
      await server.close();
    }

    expect(responseStatus).toBe(200);
    expect(responseBody).toEqual({ status: 'ok', revision: 'dev' });
    await expectPortAvailable(server.port);
  });
});

async function expectPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}
