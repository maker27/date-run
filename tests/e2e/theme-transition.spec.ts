import { expect, test } from '@playwright/test';
import { controlPost, createRoom, joinRoom, startRound } from './helpers.js';

test('keeps the scene dimensions and chosen theme when both players become ready', async ({ browser, request }) => {
  for (const viewport of [{ width: 1100, height: 900 }, { width: 390, height: 844 }, { width: 850, height: 390 }]) {
    const context = await browser.newContext({ viewport });
    try {
      const host = await context.newPage();
      const guest = await context.newPage();
      await host.goto('/date-run/');
      const room = await createRoom(host, 'first-date', 'a');
      await guest.goto('/date-run/');
      await joinRoom(guest, room);
      await expect(host.getByRole('button', { name: 'Готов', exact: true })).toBeEnabled();
      await host.locator('.game-canvas').scrollIntoViewIfNeeded();
      const before = await host.locator('.game-canvas').boundingBox();
      if (!before) throw new Error('Lobby canvas must be visible');
      await expect(host.locator('.scene-player-label:visible')).toHaveCount(0);
      const themeRequests: string[] = [];
      host.on('request', (event) => {
        if (/\/(winter|retro)-[^/]+\.js/.test(new URL(event.url()).pathname)) themeRequests.push(event.url());
      });
      await startRound(host, guest, request, room);
      await host.locator('.game-canvas').scrollIntoViewIfNeeded();
      const after = await host.locator('.game-canvas').boundingBox();
      if (!after) throw new Error('Game canvas must be visible');
      expect(after.width).toBe(before.width);
      expect(after.height).toBe(before.height);
      await expect(host.locator('.scene-player-label:visible')).toHaveCount(2);
      expect(themeRequests).toEqual([]);
    } finally {
      await context.close();
      await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
    }
  }
});
