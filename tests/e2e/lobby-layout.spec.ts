import { expect, test } from '@playwright/test';
import { controlPost, createRoom } from './helpers.js';

test('keeps programmatic heading focus quiet and keyboard button focus visible', async ({ page }) => {
  await page.goto('/date-run/');
  const heading = page.getByRole('heading', { name: 'Date Run', exact: true });
  await heading.evaluate((element) => element.focus());
  expect(await heading.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
  await page.getByLabel('Код комнаты').click();
  await page.keyboard.press('Tab');
  const check = page.getByRole('button', { name: 'Проверить комнату' });
  await expect(check).toBeFocused();
  expect(await check.evaluate((element) => getComputedStyle(element).outlineWidth)).toBe('2px');
});

test('separates join and recovery buttons on narrow and desktop screens', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    const host = await context.newPage();
    await host.goto('/date-run/');
    const roomId = await createRoom(host, 'first-date', 'b');
    const guest = await context.newPage();
    await guest.goto(`/date-run/?room=${roomId}`);
    await expect(guest.getByText('Комната найдена:', { exact: false })).toBeVisible();
    for (const width of [320, 410, 768, 1280]) {
      await guest.setViewportSize({ width, height: 900 });
      const join = await guest.getByRole('button', { name: 'Войти в комнату' }).boundingBox();
      const retry = await guest.getByRole('button', { name: 'Повторить', exact: true }).boundingBox();
      if (!join || !retry) throw new Error('Join and recovery buttons must be visible');
      expect(retry.y - (join.y + join.height), `button spacing at ${width}px`).toBeGreaterThanOrEqual(8);
      expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});
