import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Texture, TextureSource } from 'pixi.js';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import { releaseThemeSchema, type RuntimeThemeManifest } from './theme-schema.js';
import { loadTheme, pixiTextureAssets } from './theme-loader.js';
import { urls as firstDateUrls } from './first-date.js';
import { manifest, metadata, urls } from './retro.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const artKinds = ['background', 'finish', 'gateClosed', 'gateOpen', 'plateIdle', 'plateActive', 'giftA', 'giftB'] as const;
const animationStates = ['idle', 'run', 'jump', 'fall', 'land', 'interact', 'happy'] as const;
const expectedFrameCounts = { idle: 4, run: 8, jump: 1, fall: 1, land: 2, interact: 4, happy: 6 } as const;

function imagesForTheme(theme: RuntimeThemeManifest): Array<{ imageKey: string; width: number; height: number }> {
  const art = theme.art;
  if (!art) throw new Error('Release theme must include all eight art images');
  return [...theme.pages, ...artKinds.map((kind) => art[kind])];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retro production theme', () => {
  it('exports a strict release manifest with both complete roles and the shared gift identities', () => {
    const validated = releaseThemeSchema.parse(manifest);
    expect(metadata).toEqual(validated);
    expect(validated.themeId).toBe('retro');
    expect(validated.mode).toBe('release');
    expect(Object.keys(validated.frames)).toHaveLength(52);
    expect(Object.keys(validated.animations).sort()).toEqual(['a', 'b']);
    for (const role of ['a', 'b'] as const) {
      expect(Object.keys(validated.animations[role]).sort()).toEqual([...animationStates].sort());
      expect(Object.values(validated.animations[role]).flat()).toHaveLength(26);
      animationStates.forEach((state) => {
        expect(validated.animations[role][state]).toHaveLength(expectedFrameCounts[state]);
      });
    }
    expect(validated.art && Object.keys(validated.art).sort()).toEqual([...artKinds].sort());
    expect(Object.hasOwn(validated, 'colliders')).toBe(false);
    expect(LEVEL.gifts.map(({ id, ownerRole }) => [id, ownerRole])).toEqual([
      ['gift-a', 'a'],
      ['gift-b', 'b'],
    ]);
  });

  it('exports Vite URLs for exactly the manifest image keys', () => {
    const imageKeys = [...manifest.pages.map(({ imageKey }) => imageKey), ...artKinds.map((kind) => manifest.art[kind].imageKey)];
    expect(Object.keys(urls).sort()).toEqual([...imageKeys].sort());
    expect(Object.values(urls).every((url) => url.length > 0)).toBe(true);
  });

  it('ships bounded RGBA atlases with visible pixels inside every declared frame', async () => {
    for (const page of manifest.pages) {
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/retro', `${page.imageKey}.png`);
      const { data, info } = await sharp(await readFile(imagePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
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

  it('ships all eight separate bounded art images with visible alpha and transparent prop pixels', async () => {
    for (const kind of artKinds) {
      const image = manifest.art[kind];
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/retro', `${image.imageKey}.png`);
      const { data, info } = await sharp(await readFile(imagePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([info.width, info.height]).toEqual([image.width, image.height]);
      expect(info.width).toBeLessThanOrEqual(2048);
      expect(info.height).toBeLessThanOrEqual(2048);
      const alpha = data.filter((_value, index) => index % 4 === 3);
      expect(alpha.some((value) => value > 0)).toBe(true);
      if (kind !== 'background' && kind !== 'finish') {
        expect(alpha.some((value) => value === 0), `${kind} needs transparent pixels`).toBe(true);
      }
    }
  });

  it('loads only retro through the default catalog and releases its ten real Pixi textures', async () => {
    const imageSizes = new Map(imagesForTheme(manifest).map(({ imageKey, width, height }) => [urls[imageKey], { width, height }]));
    const loaded = new Set<Texture>();
    const load = vi.spyOn(pixiTextureAssets, 'load').mockImplementation(async (url, signal) => {
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const size = imageSizes.get(url);
      if (!size) throw new Error('Unexpected theme URL');
      const texture = new Texture({ source: new TextureSource(size) });
      loaded.add(texture);
      return texture;
    });
    const unload = vi.spyOn(pixiTextureAssets, 'unload').mockImplementation((texture) => {
      loaded.delete(texture);
      texture.destroy(true);
    });

    const theme = await loadTheme('retro', new AbortController().signal);
    expect(theme.themeId).toBe('retro');
    expect(theme.pages.size).toBe(10);
    expect(load).toHaveBeenCalledTimes(10);
    expect(load.mock.calls.map(([url]) => url).sort()).toEqual(Object.values(urls).sort());
    expect(load.mock.calls.map(([url]) => url)).not.toContain(firstDateUrls['atlas-0']);
    expect(load.mock.calls.map(([url]) => url)).not.toContain(firstDateUrls['atlas-1']);
    expect(loaded.size).toBe(10);

    theme.release();

    expect(unload).toHaveBeenCalledTimes(10);
    expect(loaded.size).toBe(0);
  });
});
