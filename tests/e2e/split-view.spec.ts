import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { assertNoBrowserIssues, completeRound, controlPost, createRoom, joinRoom, newPage, startRound } from './helpers.js';

const scenarios: Array<{ width: number; height: number; reducedMotion: 'reduce' | 'no-preference' }> = [
  { width: 1100, height: 900, reducedMotion: 'no-preference' },
  { width: 390, height: 844, reducedMotion: 'no-preference' },
  { width: 850, height: 390, reducedMotion: 'no-preference' },
  { width: 390, height: 844, reducedMotion: 'reduce' },
];

for (const { reducedMotion, ...viewport } of scenarios) {
  test(`shows both views and joins them at the finish at ${viewport.width}px with ${reducedMotion} motion`, async ({ browser, request }) => {
    const context = await browser.newContext({ viewport, reducedMotion });
    const diagnostics: Array<() => void> = [];
    try {
      const host = await newPage(context, diagnostics);
      const guest = await newPage(context, diagnostics);
      const room = await createRoom(host, 'first-date', 'b');
      await joinRoom(guest, room);
      await startRound(host, guest, request, room);
      for (const [page, ownRole] of [[host, 'b'], [guest, 'a']] as const) {
        await expect(page.locator('.scene-player-label:visible')).toHaveCount(2);
        await expect(page.locator(`.scene-player-label[data-role=${ownRole}]`)).toContainText('Вы');
        const first = await page.locator('.scene-player-label[data-role=a]').boundingBox();
        const second = await page.locator('.scene-player-label[data-role=b]').boundingBox();
        if (!first || !second) throw new Error('Both view labels must be visible');
        if (viewport.width < 600) {
          expect(second.y - first.y).toBeGreaterThan(200);
          expect(second.x).toBe(first.x);
          const canvas = await page.locator('.game-canvas').boundingBox();
          const controls = await page.getByRole('group', { name: 'Управление игрой' }).boundingBox();
          if (!canvas || !controls) throw new Error('Canvas and controls must be visible');
          expect(controls.y).toBeGreaterThanOrEqual(canvas.y + canvas.height);
        } else {
          expect(second.x - first.x).toBeGreaterThan(300);
          expect(second.y).toBe(first.y);
        }
      }
      await host.locator('.game-canvas').screenshot({ path: `/tmp/date-run-split-${viewport.width}.png` });
      await completeRound(host, guest, request, room, 'b', 'a');
      for (const page of [host, guest]) await expect(page.locator('.scene-player-label:visible')).toHaveCount(0);
      const merged = await host.locator('.game-canvas').screenshot({ path: `/tmp/date-run-merged-${viewport.width}.png` });
      const pixels = await sharp(merged).stats();
      expect(pixels.channels.every(({ mean }) => mean > 245)).toBe(false);
      assertNoBrowserIssues(diagnostics);
    } finally {
      await context.close();
      await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
    }
  });
}
