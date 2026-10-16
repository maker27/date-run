import { expect, test } from './fixtures.js';
import { controlPost, createRoom } from './helpers.js';

test('keeps custom radio choices clickable across landing and room layouts', async ({ browser, request }) => {
  const context = await browser.newContext({ hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto('/date-run/');
    for (const screen of ['landing', 'room']) {
      if (screen === 'room') await createRoom(page, 'first-date', 'a');
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const radio of await page.getByRole('radio').all()) {
          await expect(radio).toBeEnabled();
          await radio.scrollIntoViewIfNeeded();
          expect(await radio.evaluate((element) => {
            const label = element.closest('label');
            if (!label) throw new Error('Radio choice has no label');
            const bounds = label.getBoundingClientRect();
            return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === element;
          }), `radio pointer target on ${screen} at ${width}px`).toBe(true);
          await radio.check({ timeout: 10_000 });
          await expect(radio).toBeChecked();
        }
        const sides = page.getByRole('radiogroup', { name: 'Стартовая сторона' });
        await sides.getByRole('radio', { name: 'Слева' }).tap();
        await expect(sides.getByRole('radio', { name: 'Слева' })).toBeChecked();
        await sides.getByRole('radio', { name: 'Слева' }).focus();
        await page.keyboard.press('ArrowRight');
        await expect(sides.getByRole('radio', { name: 'Справа' })).toBeChecked();
      }
    }
  } finally {
    await context.close();
    await controlPost(request, '/restart', {}, (value) => expect(value).toMatchObject({ status: 'restarted' }));
  }
});

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
