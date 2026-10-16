import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import { releaseThemeSchema } from './theme-schema.js';
import { manifest, metadata, urls } from './first-date.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const artKinds = ['background', 'finish', 'gateClosed', 'gateOpen', 'plateIdle', 'plateActive', 'giftA', 'giftB'] as const;
const animationStates = ['idle', 'run', 'jump', 'fall', 'land', 'interact', 'happy'] as const;

describe('first-date production theme', () => {
  it('exports one validated release manifest with exactly 52 frames and the shared gift identities', () => {
    const validated = releaseThemeSchema.parse(manifest);
    expect(metadata).toEqual(validated);
    expect(validated.themeId).toBe('first-date');
    expect(validated.mode).toBe('release');
    expect(Object.keys(validated.frames)).toHaveLength(52);
    expect(Object.keys(validated.animations.a).sort()).toEqual([...animationStates].sort());
    expect(Object.keys(validated.animations.b).sort()).toEqual([...animationStates].sort());
    expect(Object.values(validated.animations.a).flat()).toHaveLength(26);
    expect(Object.values(validated.animations.b).flat()).toHaveLength(26);
    expect(validated.animations.a.run).toHaveLength(8);
    expect(validated.animations.b.run).toHaveLength(8);
    expect(validated.art && Object.keys(validated.art).sort()).toEqual([...artKinds].sort());
    expect(LEVEL.gifts.map(({ id, ownerRole }) => [id, ownerRole])).toEqual([
      ['gift-a', 'a'],
      ['gift-b', 'b'],
    ]);
  });

  it('exports Vite URLs for exactly the image keys declared in metadata', () => {
    const imageKeys = [
      ...manifest.pages.map(({ imageKey }) => imageKey),
      ...artKinds.map((kind) => manifest.art[kind].imageKey),
    ];
    expect(Object.keys(urls).sort()).toEqual([...imageKeys].sort());
    expect(Object.values(urls).every((url) => url.length > 0)).toBe(true);
  });

  it('ships bounded RGBA atlases with visible pixels inside every declared frame', async () => {
    for (const page of manifest.pages) {
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/first-date', `${page.imageKey}.png`);
      const image = sharp(await readFile(imagePath));
      const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([info.width, info.height]).toEqual([page.width, page.height]);
      expect(info.width).toBeLessThanOrEqual(2048);
      expect(info.height).toBeLessThanOrEqual(2048);
      const frames = Object.values(manifest.frames).filter((frame) => frame.imageKey === page.imageKey);
      for (const frame of frames) {
        let visiblePixel = false;
        for (let y = frame.y; y < frame.y + frame.height && !visiblePixel; y += 1) {
          for (let x = frame.x; x < frame.x + frame.width; x += 1) {
            if (data[(y * info.width + x) * 4 + 3] !== 0) {
              visiblePixel = true;
              break;
            }
          }
        }
        expect(visiblePixel, `frame ${frame.imageKey}:${frame.x},${frame.y}`).toBe(true);
      }
    }
  });

  it('ships all eight separate bounded art images and preserves transparent prop pixels', async () => {
    for (const kind of artKinds) {
      const image = manifest.art[kind];
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/first-date', `${image.imageKey}.png`);
      const { data, info } = await sharp(await readFile(imagePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([info.width, info.height]).toEqual([image.width, image.height]);
      expect(info.width).toBeLessThanOrEqual(2048);
      expect(info.height).toBeLessThanOrEqual(2048);
      expect(data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
      if (kind !== 'background' && kind !== 'finish') {
        expect(data.some((value, index) => index % 4 === 3 && value === 0), `${kind} needs transparent pixels`).toBe(true);
      }
    }
  });
});
