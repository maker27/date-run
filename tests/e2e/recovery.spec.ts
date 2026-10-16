import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test';
import {
  assertNoBrowserIssues,
  allowExpected404,
  controlPost,
  createRoom,
  joinRoom,
  newPage,
  occupySwitch,
  readSnapshot,
  startRound,
  triggerCompletion,
  watchBrowserIssues,
  waitForSnapshot,
} from './helpers.js';

async function setupPlaying(context: BrowserContext, diagnostics: Array<() => void>, request: APIRequestContext) {
  const host = await newPage(context, diagnostics);
  const guest = await newPage(context, diagnostics);
  const roomId = await createRoom(host, 'first-date', 'a');
  await joinRoom(guest, roomId);
  await startRound(host, guest, request, roomId);
  return { host, guest, roomId };
}

async function restartFixture(request: APIRequestContext): Promise<void> {
  await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
}

test('reloads the session credential and reconnects before the reserve TTL', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, roomId } = await setupPlaying(context, diagnostics, request);
    await host.reload();
    await expect(host.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'playing' && snapshot.state.players.every(({ connected }) => connected));

    const connectionId = await host.evaluate(() => window.__dateRunTest.connectionId());
    await controlPost(request, '/break', { connectionId }, (value) => expect(value).toMatchObject({ status: 'broken' }));
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.paused && snapshot.state.players.some(({ role, connected }) => role === 'a' && !connected));
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'playing' && !snapshot.state.paused && snapshot.state.players.every(({ connected }) => connected));
    await expect(host.getByRole('heading', { name: 'Бегите навстречу!' })).toBeVisible();
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('expires a disconnected player and resets the round while both wait near the gate', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, guest, roomId } = await setupPlaying(context, diagnostics, request);
    expect((await readSnapshot(request, roomId)).state.players.find(({ role }) => role === 'a')).toBeDefined();
    expect(await host.evaluate(() => window.__dateRunTest.attemptInteraction('gift-a'))).toBe('out_of_range');
    await Promise.all([
      occupySwitch(host, request, roomId, 'a'),
      occupySwitch(guest, request, roomId, 'b'),
    ]);
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.gateOpen);

    const connectionId = await host.evaluate(() => window.__dateRunTest.connectionId());
    await controlPost(request, '/break', { connectionId }, (value) => expect(value).toMatchObject({ status: 'broken' }));
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.paused && snapshot.state.players.some(({ role, connected }) => role === 'a' && !connected));
    await host.goto('about:blank');
    await controlPost(request, '/advance', { ms: 30_001 }, (value) => expect(value).toMatchObject({ advancedMs: 30_001 }));
    const reset = await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'lobby' && snapshot.state.players.length === 1);
    expect(reset.state.paused).toBe(false);
    expect(reset.state.gateOpen).toBe(false);
    expect(reset.state.gifts.every(({ collectedBy }) => collectedBy === null)).toBe(true);
    await expect(guest.getByRole('button', { name: 'Готов' })).toBeVisible();
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('leaving beside the open gate returns the remaining player to a clean lobby', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, guest, roomId } = await setupPlaying(context, diagnostics, request);
    await Promise.all([
      occupySwitch(host, request, roomId, 'a'),
      occupySwitch(guest, request, roomId, 'b'),
    ]);
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.gateOpen);
    await host.getByRole('button', { name: 'Выйти' }).click();
    const reset = await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'lobby' && snapshot.state.players.length === 1);
    expect(reset.state.gateOpen).toBe(false);
    expect(reset.state.gifts.every(({ collectedBy }) => collectedBy === null)).toBe(true);
    await expect(guest.getByRole('button', { name: 'Готов' })).toBeVisible();
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('a duplicate tab replaces the old connection without adding a player', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const host = await newPage(context, diagnostics);
    const guest = await newPage(context, diagnostics);
    const roomId = await createRoom(host, 'retro', 'a');
    await joinRoom(guest, roomId);
    const original = await readSnapshot(request, roomId);
    const popupPromise = host.waitForEvent('popup');
    await host.evaluate(() => window.open(location.href, '_blank'));
    const duplicate = await popupPromise;
    diagnostics.push(watchBrowserIssues(duplicate));
    await expect(duplicate.getByRole('heading', { name: `Комната ${roomId}` })).toBeVisible();
    const replaced = await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.players.every(({ connected }) => connected));
    expect(replaced.state.players.map(({ id }) => id).sort()).toEqual(original.state.players.map(({ id }) => id).sort());
    expect(replaced.state.players).toHaveLength(2);
    await expect(host.getByRole('alert')).toHaveText('Это место открыто в другой вкладке.');
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('hidden tabs stop input and visible tabs resynchronize before accepting input again', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, roomId } = await setupPlaying(context, diagnostics, request);
    const before = await readSnapshot(request, roomId);
    const hostPlayer = before.state.players.find(({ role }) => role === 'a');
    expect(hostPlayer).toBeDefined();
    if (!hostPlayer) throw new Error('Host player is missing from authoritative snapshot');
    await host.evaluate(() => window.__dateRunTest.setVisibility('hidden'));
    const hidden = await waitForSnapshot(request, roomId, (snapshot) =>
      (snapshot.state.players.find(({ id }) => id === hostPlayer.id)?.inputGeneration ?? 0) > hostPlayer.inputGeneration,
    );
    await host.keyboard.down('ArrowRight');
    await expect.poll(async () => {
      const current = await readSnapshot(request, roomId);
      return current.tick >= before.tick + 6 && current.state.players.find(({ id }) => id === hostPlayer.id)?.body.x === hostPlayer.body.x;
    }, { timeout: 5000 }).toBe(true);
    await host.keyboard.up('ArrowRight');
    await host.evaluate(() => window.__dateRunTest.setVisibility('visible'));
    await waitForSnapshot(request, roomId, (snapshot) =>
      (snapshot.state.players.find(({ id }) => id === hostPlayer.id)?.inputGeneration ?? 0) >
      (hidden.state.players.find(({ id }) => id === hostPlayer.id)?.inputGeneration ?? hostPlayer.inputGeneration),
    );
    const hiddenGeneration = hidden.state.players.find(({ id }) => id === hostPlayer.id)?.inputGeneration ?? hostPlayer.inputGeneration;
    await expect.poll(() => host.evaluate(() => window.__dateRunTest.lastResyncedInputGeneration())).toBeGreaterThan(hiddenGeneration);
    await host.keyboard.down('ArrowRight');
    try {
      await expect.poll(async () => {
        const current = await readSnapshot(request, roomId);
        const player = current.state.players.find(({ id }) => id === hostPlayer.id);
        return player ? player.body.x > hostPlayer.body.x + 20 : false;
      }, { timeout: 5000 }).toBe(true);
    } finally {
      await host.keyboard.up('ArrowRight');
    }
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('server restart clears credentials and returns users to the lobby', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, guest, roomId } = await setupPlaying(context, diagnostics, request);
    const guestPreviewUrl = new URL(`/date-run/api/rooms/${roomId}`, guest.url()).href;
    const stopAllowing404 = allowExpected404(guest, guestPreviewUrl);
    try {
      const guestPreviewConsoleError = guest.waitForEvent('console', (message) =>
        message.type() === 'error' && message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)' &&
        message.location().url === guestPreviewUrl,
      );
      const previewResponse = guest.waitForResponse((response) => response.url() === guestPreviewUrl && response.status() === 404);
      await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
      expect((await previewResponse).status()).toBe(404);
      await guestPreviewConsoleError;
    } finally {
      stopAllowing404();
    }
    await expect(host.getByRole('alert')).toHaveText('Срок действия приглашения истёк.');
    await expect(host.getByRole('heading', { name: 'Date Run' })).toBeVisible();
    await expect(host.getByRole('heading', { name: `Комната ${roomId}` })).toHaveCount(0);
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});

test('a lost room completion event is restored from the authoritative snapshot after reload', async ({ browser, request }) => {
  const context = await browser.newContext();
  const diagnostics: Array<() => void> = [];
  try {
    const { host, guest, roomId } = await setupPlaying(context, diagnostics, request);
    await host.evaluate(() => window.__dateRunTest.dropNext('room:complete'));
    await triggerCompletion(host, guest, request, roomId, 'a', 'b');
    const deliveredToHost = await host.evaluate(() => window.__dateRunTest.snapshot());
    expect(deliveredToHost?.state.phase).toBe('playing');
    await host.reload();
    await expect(host.getByRole('heading', { name: 'Готовность к новой игре' })).toBeVisible();
    await expect(guest.getByRole('heading', { name: 'Готовность к новой игре' })).toBeVisible();
    assertNoBrowserIssues(diagnostics);
  } finally {
    await context.close();
    await restartFixture(request);
  }
});
