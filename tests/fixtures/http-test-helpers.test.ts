import { createHttpFixture } from './http-test-helpers.js';
import { request } from 'node:http';
import { expect, it } from 'vitest';

it('closes a connection that becomes idle after the initial idle sweep', async () => {
  let finishResponse: (() => void) | undefined;
  const responseFinished = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const fixture = await createHttpFixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('first');
    await responseGate;
    response.end('second');
    finishResponse?.();
  });
  let closePromise: Promise<void> | undefined;
  let bodyPromise: Promise<string> | undefined;

  try {
    const response = await fetch(fixture.origin);
    bodyPromise = response.text();
    closePromise = fixture.close();
    releaseResponse?.();

    await expect(bodyPromise).resolves.toBe('firstsecond');
    await responseFinished;
    await expect(closePromise).resolves.toBeUndefined();
  } finally {
    releaseResponse?.();
    if (bodyPromise) await bodyPromise.catch(() => undefined);
    if (closePromise) await closePromise.catch(() => undefined);
    else await fixture.close().catch(() => undefined);
  }
});

it('reports an active response aborted during fixture close', async () => {
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const fixture = await createHttpFixture(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('partial');
    await responseGate;
    response.end('complete');
  });
  let closePromise: Promise<void> | undefined;
  let destroyClient: (() => void) | undefined;

  try {
    const partialBody = new Promise<void>((resolve, reject) => {
      const client = request(fixture.origin, (response) => {
        response.once('data', () => resolve());
        response.once('error', reject);
      });
      client.once('error', () => undefined);
      destroyClient = () => client.destroy();
      client.end();
    });
    await partialBody;
    closePromise = fixture.close();
    destroyClient?.();
    await expect(closePromise).rejects.toThrow('HTTP fixture response aborted during close');
  } finally {
    releaseResponse?.();
    destroyClient?.();
    if (closePromise) await closePromise.catch(() => undefined);
    else await fixture.close().catch(() => undefined);
  }
});
