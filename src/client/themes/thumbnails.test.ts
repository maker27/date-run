import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it } from 'vitest';

it.each(['first-date', 'retro', 'winter'])('ships a compact opaque scene thumbnail for %s', async (theme) => {
  const bytes = await readFile(new URL(`./assets/${theme}/thumbnail.png`, import.meta.url));
  const image = sharp(bytes);
  expect(await image.metadata()).toMatchObject({ width: 360, height: 240 });
  expect((await image.stats()).isOpaque).toBe(true);
  expect(bytes.byteLength).toBeLessThanOrEqual(250 * 1024);
});
