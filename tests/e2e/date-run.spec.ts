import { expect, test } from '@playwright/test';
import {
  allowExpected404,
  assertNoBrowserIssues,
  controlPost,
  createRoom,
  completeRound,
  joinRoom,
  newPage,
  readSnapshot,
  startRound,
  waitForSnapshot,
} from './helpers.js';

test.afterEach(async ({ request }) => {
  await test.step('reset the test server', () =>
    controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' })));
});

test('plays a cooperative round through invite, gifts, gate, result and rematch', async ({ context, request }) => {
  const diagnostics: Array<() => void> = [];
  const host = await newPage(context, diagnostics);
  const guest = await newPage(context, diagnostics);
  const third = await newPage(context, diagnostics);
  const roomId = await createRoom(host, 'retro', 'a');

  await test.step('configure the room and reject a third player', async () => {
    await host.getByRole('radiogroup', { name: 'Тема игры' }).getByRole('radio', { name: 'Зимнее свидание' }).check();
    await host.getByRole('radiogroup', { name: 'Стартовая сторона' }).getByRole('radio', { name: 'Справа' }).check();
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.themeId === 'winter' && snapshot.state.players[0]?.role === 'b');

    await joinRoom(guest, roomId);
    await expect(host.getByRole('heading', { name: 'Пригласите партнёра' })).toBeVisible();
    await expect(host.getByRole('radiogroup', { name: 'Стартовая сторона' }).getByRole('radio', { name: 'Справа' })).toBeChecked();
    await expect(host.getByLabel('Ссылка-приглашение')).toHaveValue(`http://127.0.0.1:4173/date-run/?room=${roomId}`);
    await expect(guest.getByRole('heading', { name: `Комната ${roomId}` })).toBeVisible();

    await third.getByLabel('Код комнаты').fill(roomId);
    await third.getByRole('button', { name: 'Проверить комнату' }).click();
    await expect(third.getByRole('alert')).toContainText('В комнате нет свободных мест.');
    await expect(third.getByRole('button', { name: 'Войти в комнату' })).toBeDisabled();
  });

  await test.step('play the cooperative round at mobile and desktop sizes', async () => {
    await startRound(host, guest, request, roomId);
    const desktop = host.viewportSize();
    for (const width of [320, 390]) {
      await host.setViewportSize({ width, height: 844 });
      await expect(host.getByRole('button', { name: 'Взять подарок' })).toBeVisible();
      expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (desktop) await host.setViewportSize(desktop);
    const foreignOutcome = await host.evaluate(() => window.__dateRunTest.attemptInteraction('gift-a'));
    expect(foreignOutcome).toBe('not_owner');
    await expect.poll(async () => (await readSnapshot(request, roomId)).state.gifts.find(({ id }) => id === 'gift-a')?.collectedBy).toBeNull();

    await completeRound(host, guest, request, roomId, 'b', 'a');
  });

  await test.step('agree to a rematch and change the theme', async () => {
    await host.getByRole('button', { name: 'Сыграть снова' }).click();
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.players.find(({ role }) => role === 'b')?.rematch === true);
    await guest.getByRole('button', { name: 'Сыграть снова' }).click();
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.phase === 'lobby' && snapshot.state.players.every(({ ready, rematch }) => !ready && !rematch));
    await expect(host.getByRole('button', { name: 'Готов' })).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Готов' })).toBeVisible();

    await host.getByRole('radiogroup', { name: 'Тема игры' }).getByRole('radio', { name: 'Ретро' }).check();
    await waitForSnapshot(request, roomId, (snapshot) => snapshot.state.themeId === 'retro');
    await expect(guest.getByRole('radiogroup', { name: 'Тема игры' }).getByRole('radio', { name: 'Ретро' })).toBeChecked();
  });

  await test.step('show invalid and missing room errors', async () => {
    await third.getByLabel('Код комнаты').fill('bad');
    await third.getByRole('button', { name: 'Проверить комнату' }).click();
    await expect(third.getByRole('alert')).toHaveText('Введите код комнаты из восьми символов.');
    await third.getByLabel('Код комнаты').fill('ZZZZZZZZ');
    const missingRoomUrl = new URL('/date-run/api/rooms/ZZZZZZZZ', third.url()).href;
    const stopAllowing404 = allowExpected404(third, missingRoomUrl);
    try {
      const [missingRoomResponse] = await Promise.all([
        third.waitForResponse((response) => response.url() === missingRoomUrl && response.status() === 404, { timeout: 10_000 }),
        third.waitForEvent('console', {
          predicate: (message) => message.type() === 'error' &&
            message.text() === 'Failed to load resource: the server responded with a status of 404 (Not Found)' &&
            message.location().url === missingRoomUrl,
          timeout: 10_000,
        }),
        third.getByRole('button', { name: 'Проверить комнату' }).click(),
      ]);
      expect(missingRoomResponse.status()).toBe(404);
      await expect(third.getByRole('alert')).toContainText('Комната не найдена.');
    } finally {
      stopAllowing404();
    }
  });

  assertNoBrowserIssues(diagnostics);
});
