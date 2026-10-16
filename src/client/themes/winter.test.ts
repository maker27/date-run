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
import { urls as retroUrls } from './retro.js';
import { manifest, metadata, urls } from './winter.js';

type ReleaseThemeManifest = Omit<RuntimeThemeManifest, 'mode' | 'art'> & { mode: 'release'; art: NonNullable<RuntimeThemeManifest['art']> };
const runtimeManifest: ReleaseThemeManifest = releaseThemeSchema.parse(manifest);
const themeUrls: Readonly<Record<string, string>> = urls;
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

describe('winter production theme', () => {
  it('exports a strict release manifest with both complete roles and the shared gift identities', () => {
    const validated = releaseThemeSchema.parse(manifest);
    expect(metadata).toEqual(validated);
    expect(validated.themeId).toBe('winter');
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
    expect(() => releaseThemeSchema.parse({ ...manifest, colliders: [] })).toThrow();
    expect(LEVEL.gifts.map(({ id, ownerRole }) => [id, ownerRole])).toEqual([
      ['gift-a', 'a'],
      ['gift-b', 'b'],
    ]);
  });

  it('exports Vite URLs for exactly the manifest image keys', () => {
    const imageKeys = [...runtimeManifest.pages.map(({ imageKey }) => imageKey), ...artKinds.map((kind) => runtimeManifest.art[kind].imageKey)];
    expect(Object.keys(themeUrls).sort()).toEqual([...imageKeys].sort());
    expect(Object.values(themeUrls).every((url) => url.length > 0)).toBe(true);
  });

  it('ships bounded RGBA atlases with visible pixels inside every declared frame', async () => {
    for (const page of runtimeManifest.pages) {
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/winter', `${page.imageKey}.png`);
      const { data, info } = await sharp(await readFile(imagePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([info.width, info.height]).toEqual([page.width, page.height]);
      expect(info.width).toBeLessThanOrEqual(2048);
      expect(info.height).toBeLessThanOrEqual(2048);
      const frames = Object.values(runtimeManifest.frames).filter((frame) => frame.imageKey === page.imageKey);
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

  it('keeps the run-cycle head landmark near the shared idle body origin', async () => {
    const atlases = new Map<string, { data: Buffer; width: number }>();
    for (const page of runtimeManifest.pages) {
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/winter', `${page.imageKey}.png`);
      const { data, info } = await sharp(await readFile(imagePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      atlases.set(page.imageKey, { data, width: info.width });
    }

    function headCenterX(role: 'a' | 'b', state: 'idle' | 'run', index: number): number {
      const frameIds = runtimeManifest.animations[role][state];
      if (!frameIds) throw new Error(`Missing ${role} ${state} frames`);
      const frameId = frameIds[index];
      if (!frameId) throw new Error(`Missing ${role} ${state} frame ${index}`);
      const frame = runtimeManifest.frames[frameId];
      if (!frame) throw new Error(`Missing ${role} ${state} frame ${index}`);
      const atlas = atlases.get(frame.imageKey);
      if (!atlas) throw new Error(`Missing atlas ${frame.imageKey}`);
      let firstVisibleRow: number = frame.height;
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const alpha = atlas.data[((frame.y + y) * atlas.width + frame.x + x) * 4 + 3];
          if (alpha !== undefined && alpha > 16) {
            firstVisibleRow = Math.min(firstVisibleRow, y);
            break;
          }
        }
        if (firstVisibleRow < frame.height) break;
      }

      let pixelCount = 0;
      let xTotal = 0;
      for (let y = firstVisibleRow; y < Math.min(frame.height, firstVisibleRow + 45); y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const alpha = atlas.data[((frame.y + y) * atlas.width + frame.x + x) * 4 + 3];
          if (alpha !== undefined && alpha > 16) {
            pixelCount += 1;
            xTotal += x;
          }
        }
      }
      expect(pixelCount, `${role} ${state} ${index} has visible head pixels`).toBeGreaterThan(0);
      return xTotal / pixelCount;
    }

    const anchorX = runtimeManifest.anchor.x * 256;
    for (const role of ['a', 'b'] as const) {
      const idleFrames = runtimeManifest.animations[role].idle;
      const runFrames = runtimeManifest.animations[role].run;
      if (!idleFrames || !runFrames) throw new Error(`Missing ${role} idle or run frames`);
      const idleCenters = idleFrames.map((_frameId, index) => headCenterX(role, 'idle', index));
      const runCenters = runFrames.map((_frameId, index) => headCenterX(role, 'run', index));
      const idleCenter = idleCenters.reduce((total, center) => total + center, 0) / idleCenters.length;
      const maxRunOffset = Math.max(...runCenters.map((center) => Math.abs(center - idleCenter)));
      const maxAdjacentRunShift = runCenters.reduce((maximum, center, index) => {
        const previousCenter = runCenters[index - 1];
        return previousCenter === undefined ? maximum : Math.max(maximum, Math.abs(center - previousCenter));
      }, 0);

      expect(Math.abs(idleCenter - anchorX), `${role} idle head landmark stays near the 256px slot's body origin`).toBeLessThanOrEqual(12);
      expect(maxRunOffset, `${role} run head landmark allows a natural lean around its idle origin`).toBeLessThanOrEqual(14);
      expect(maxAdjacentRunShift, `${role} adjacent run frames avoid visible head jumps`).toBeLessThanOrEqual(14);
    }
  });

  it('ships all eight separate bounded art images with visible alpha and transparent prop pixels', async () => {
    for (const kind of artKinds) {
      const image = runtimeManifest.art[kind];
      const imagePath = path.join(projectRoot, 'src/client/themes/generated/winter', `${image.imageKey}.png`);
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

  it('ships a separate thumbnail small enough for the theme catalog', async () => {
    const imagePath = path.join(projectRoot, 'src/client/themes/assets/winter/thumbnail.png');
    const { width, height } = await sharp(await readFile(imagePath)).metadata();

    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(512);
    expect(height).toBeLessThanOrEqual(512);
  });

  it('loads only winter through the default catalog and releases its ten real Pixi textures', async () => {
    const imageSizes = new Map(imagesForTheme(runtimeManifest).map(({ imageKey, width, height }) => [themeUrls[imageKey], { width, height }]));
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

    const theme = await loadTheme('winter', new AbortController().signal);
    expect(theme.themeId).toBe('winter');
    expect(theme.pages.size).toBe(10);
    expect(load).toHaveBeenCalledTimes(10);
    expect(load.mock.calls.map(([url]) => url).sort()).toEqual(Object.values(themeUrls).sort());
    expect(load.mock.calls.map(([url]) => url)).not.toContain(firstDateUrls['atlas-0']);
    expect(load.mock.calls.map(([url]) => url)).not.toContain(firstDateUrls['atlas-1']);
    expect(load.mock.calls.map(([url]) => url)).not.toContain(retroUrls['atlas-0']);
    expect(load.mock.calls.map(([url]) => url)).not.toContain(retroUrls['atlas-1']);
    expect(loaded.size).toBe(10);

    theme.release();

    expect(unload).toHaveBeenCalledTimes(10);
    expect(loaded.size).toBe(0);
  });
});
