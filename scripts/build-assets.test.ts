import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnimationState } from '../src/client/themes/theme-schema.js';
import type { Role } from '../src/shared/model.js';
import { buildThemeAssets, parseSourceThemeManifest, type SourceArtImage, type SourceFrame, type SourceThemeManifest, type ThemeArtKind } from './build-assets.js';

const states: readonly AnimationState[] = ['idle', 'run', 'jump', 'fall', 'land', 'interact', 'happy'];
const roots: string[] = [];
const artKinds: readonly ThemeArtKind[] = ['background', 'finish', 'gateClosed', 'gateOpen', 'plateIdle', 'plateActive', 'giftA', 'giftB'];

function frameCount(state: AnimationState): number {
  switch (state) {
    case 'idle': return 4;
    case 'run': return 8;
    case 'jump': return 1;
    case 'fall': return 1;
    case 'land': return 2;
    case 'interact': return 4;
    case 'happy': return 6;
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'date-run-assets-'));
  roots.push(root);
  return root;
}

function frame(role: Role, state: AnimationState, index: number, sourcePath: string): SourceFrame {
  return {
    role,
    state,
    index,
    sourcePath,
    rect: { x: 1, y: 1, width: 2, height: 2 },
    pivot: { x: 1, y: 1 },
    scale: 1,
  };
}

function requiredFrame(frames: readonly SourceFrame[], index: number): SourceFrame {
  const selected = frames[index];
  if (selected === undefined) throw new Error(`Fixture frame ${index} is missing`);
  return selected;
}

async function createTheme(root: string, mode: 'pilot' | 'release' = 'pilot'): Promise<SourceThemeManifest> {
  await mkdir(path.join(root, 'source'), { recursive: true });
  const selectedStates = mode === 'pilot' ? states.slice(0, 2) : states;
  const frames: SourceFrame[] = [];
  let colorIndex = 1;

  for (const role of ['a', 'b'] as const) {
    for (const state of selectedStates) {
      for (let index = 0; index < frameCount(state); index += 1) {
        const sourcePath = `source/${role}-${state}-${index}.png`;
        const red = colorIndex;
        const pixels = Buffer.from([
          red, 31, 47, 255,
          red, 31, 47, 96,
          red, 31, 47, 0,
          red, 31, 47, 255,
        ]);
        await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } })
          .extend({ top: 1, bottom: 1, left: 1, right: 1, background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toFile(path.join(root, sourcePath));
        frames.push(frame(role, state, index, sourcePath));
        colorIndex += 1;
      }
    }
  }

  return { schemaVersion: 1, themeId: 'first-date', mode, frames };
}

async function createArt(root: string): Promise<Record<ThemeArtKind, SourceArtImage>> {
  await mkdir(path.join(root, 'art'), { recursive: true });
  async function createImage(kind: ThemeArtKind, index: number): Promise<SourceArtImage> {
    const sourcePath = `art/${kind}.png`;
    const pixels = Buffer.from([
      10 + index, 20, 30, 0,
      10 + index, 20, 30, 96,
      40, 50, 60, 255,
      40, 50, 60, 0,
    ]);
    await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(path.join(root, sourcePath));
    return { sourcePath, rect: { x: 0, y: 0, width: 2, height: 2 }, scale: 2 };
  }
  return {
    background: await createImage('background', 0),
    finish: await createImage('finish', 1),
    gateClosed: await createImage('gateClosed', 2),
    gateOpen: await createImage('gateOpen', 3),
    plateIdle: await createImage('plateIdle', 4),
    plateActive: await createImage('plateActive', 5),
    giftA: await createImage('giftA', 6),
    giftB: await createImage('giftB', 7),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('buildThemeAssets', () => {
  it('preserves the exact RGBA crop and alpha values in its normalized frame', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const report = await buildThemeAssets(source, { projectRoot, outputDir: 'out' });
    const selected = report.manifest.frames['a-idle-0'];
    if (selected === undefined) throw new Error('Build report omitted a-idle-0');
    const pagePathFromReport = report.pagePaths.find((file) => file.endsWith('.png'));
    if (pagePathFromReport === undefined) throw new Error('Build report omitted atlas page paths');
    const pagePath = path.join(projectRoot, pagePathFromReport);
    const { data, info } = await sharp(pagePath).raw().toBuffer({ resolveWithObject: true });

    expect(info.channels).toBe(4);
    expect(info.width).toBeLessThanOrEqual(2048);
    expect(info.height).toBeLessThanOrEqual(2048);
    const frameX = selected.x;
    const frameY = selected.y;
    const cropPixel = (x: number, y: number): readonly number[] => {
      const offset = ((frameY + y) * info.width + frameX + x) * info.channels;
      return [...data.subarray(offset, offset + info.channels)];
    };

    expect(cropPixel(127, 224)).toEqual([1, 31, 47, 255]);
    expect(cropPixel(128, 224)).toEqual([1, 31, 47, 96]);
    expect(cropPixel(127, 225)).toEqual([1, 31, 47, 0]);
    expect(cropPixel(128, 225)).toEqual([1, 31, 47, 255]);
  });

  it('produces byte-identical atlas pages and metadata across independent builds', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const first = await buildThemeAssets(source, { projectRoot, outputDir: 'first' });
    const second = await buildThemeAssets(source, { projectRoot, outputDir: 'second' });
    const firstPages = await Promise.all(first.pagePaths.map((file) => readFile(path.join(projectRoot, file))));
    const secondPages = await Promise.all(second.pagePaths.map((file) => readFile(path.join(projectRoot, file))));
    const firstManifest = await readFile(path.join(projectRoot, first.manifestPath));
    const secondManifest = await readFile(path.join(projectRoot, second.manifestPath));

    expect(firstPages).toEqual(secondPages);
    expect(firstManifest).toEqual(secondManifest);
    expect(first.manifestPath).not.toContain(projectRoot);
    expect(first.pagePaths.every((file) => !file.includes(projectRoot))).toBe(true);
  });

  it('rejects duplicate, missing, and unexpected frame identities', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const original = requiredFrame(source.frames, 0);
    const duplicate = requiredFrame(source.frames, 1);

    await expect(buildThemeAssets({ ...source, frames: [...source.frames, original] }, { projectRoot, outputDir: 'duplicate' })).rejects.toThrow();
    await expect(buildThemeAssets({ ...source, frames: source.frames.slice(1) }, { projectRoot, outputDir: 'missing' })).rejects.toThrow();
    await expect(buildThemeAssets({ ...source, frames: [...source.frames, { ...duplicate, state: 'happy', index: 0 }] }, { projectRoot, outputDir: 'extra' })).rejects.toThrow();
  });

  it('requires every release animation state for both roles', async () => {
    const projectRoot = await makeRoot();
    const release = await createTheme(projectRoot, 'release');
    await expect(buildThemeAssets({ ...release, frames: release.frames.filter((item) => item.state !== 'happy') }, { projectRoot, outputDir: 'missing-release-state' })).rejects.toThrow();
  });

  it('builds the exact release frame inventory for both roles', async () => {
    const projectRoot = await makeRoot();
    const release = await createTheme(projectRoot, 'release');
    const report = await buildThemeAssets(release, { projectRoot, outputDir: 'release-output' });

    expect(Object.keys(report.manifest.frames)).toHaveLength(52);
    expect(report.manifest.animations.a).toMatchObject({
      idle: expect.arrayContaining(['a-idle-0', 'a-idle-1', 'a-idle-2', 'a-idle-3']),
      run: expect.arrayContaining(['a-run-0', 'a-run-7']),
      jump: ['a-jump-0'],
      fall: ['a-fall-0'],
      land: ['a-land-0', 'a-land-1'],
      interact: expect.arrayContaining(['a-interact-0', 'a-interact-3']),
      happy: expect.arrayContaining(['a-happy-0', 'a-happy-5']),
    });
    expect(Object.keys(report.manifest.animations.b)).toHaveLength(7);
  });

  it('builds the complete independent art set with deterministic paths and preserved RGBA pixels', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot, 'release');
    const art = await createArt(projectRoot);
    const report = await buildThemeAssets({ ...source, mode: 'release', art }, { projectRoot, outputDir: 'out' });

    expect(Object.keys(report.manifest.art ?? {}).sort()).toEqual([...artKinds].sort());
    expect(Object.keys(report.artPaths).sort()).toEqual([...artKinds].sort());
    for (const kind of artKinds) {
      const pathFromReport = report.artPaths[kind];
      const metadata = report.manifest.art?.[kind];
      expect(pathFromReport).toBe(`out/art-${kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.png`);
      expect(metadata).toMatchObject({ width: 4, height: 4 });
      if (!pathFromReport) throw new Error(`Build report omitted ${kind}`);
      const imagePath = path.join(projectRoot, pathFromReport);
      const { data, info } = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([info.width, info.height]).toEqual([4, 4]);
      const pixel = (x: number, y: number): readonly number[] => {
        const offset = (y * info.width + x) * info.channels;
        return [...data.subarray(offset, offset + info.channels)];
      };
      expect(pixel(0, 0)[3]).toBe(0);
      expect(pixel(3, 3)[3]).toBe(0);
      expect(data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
      expect(data.some((value, index) => index % 4 === 3 && value > 0 && value < 255)).toBe(true);
    }
  });

  it('rejects partial art inventories, invalid art crop bounds, and unsafe art paths', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const art = await createArt(projectRoot);
    const partial: Partial<Record<ThemeArtKind, SourceArtImage>> = { ...art };
    delete partial.giftB;
    expect(() => parseSourceThemeManifest({ ...source, art: partial })).toThrow();
    await expect(buildThemeAssets({ ...source, art: { ...art, giftA: { ...art.giftA, rect: { x: 1, y: 1, width: 2, height: 2 } } } }, { projectRoot, outputDir: 'bad-art-bounds' })).rejects.toThrow();
    await expect(buildThemeAssets({ ...source, art: { ...art, giftA: { ...art.giftA, sourcePath: '../outside.png' } } }, { projectRoot, outputDir: 'unsafe-art' })).rejects.toThrow();
  });

  it('keeps generic release builds without theme art valid', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot, 'release');
    const report = await buildThemeAssets(source, { projectRoot, outputDir: 'no-art' });

    expect(Object.keys(report.manifest.frames)).toHaveLength(52);
    expect(report.manifest.art).toBeUndefined();
    expect(report.artPaths).toEqual({});
  });

  it.each(['/tmp/absolute.png', '../outside.png', 'source\\frame.png', 'source/./frame.png', 'source//frame.png'])(
    'rejects unsafe source path %s', async (sourcePath) => {
      const projectRoot = await makeRoot();
      const source = await createTheme(projectRoot);
      const first = requiredFrame(source.frames, 0);
      const badFrame = { ...first, sourcePath };
      await expect(buildThemeAssets({ ...source, frames: [badFrame, ...source.frames.slice(1)] }, { projectRoot, outputDir: 'unsafe' })).rejects.toThrow();
    },
  );

  it('rejects a source symlink that resolves outside the project root', async () => {
    const projectRoot = await makeRoot();
    const outsideRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } })
      .png()
      .toFile(path.join(outsideRoot, 'outside.png'));
    await symlink(path.join(outsideRoot, 'outside.png'), path.join(projectRoot, 'source/link.png'));
    const first = requiredFrame(source.frames, 0);

    await expect(buildThemeAssets({ ...source, frames: [{ ...first, sourcePath: 'source/link.png' }, ...source.frames.slice(1)] }, { projectRoot, outputDir: 'symlink' })).rejects.toThrow();
  });

  it.each(['../outside-output', 'source/../../outside-output'])(
    'rejects output directory traversal %s', async (outputDir) => {
      const projectRoot = await makeRoot();
      const source = await createTheme(projectRoot);

      await expect(buildThemeAssets(source, { projectRoot, outputDir })).rejects.toThrow();
    },
  );

  it('rejects an output directory symlink that resolves outside the project root', async () => {
    const projectRoot = await makeRoot();
    const outsideRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    await mkdir(path.join(outsideRoot, 'destination'), { recursive: true });
    await symlink(path.join(outsideRoot, 'destination'), path.join(projectRoot, 'output-link'));

    await expect(buildThemeAssets(source, { projectRoot, outputDir: 'output-link/atlas' })).rejects.toThrow();
  });

  it('rejects malformed crop rectangles and poses whose visible pixels would clip', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const first = requiredFrame(source.frames, 0);

    await expect(buildThemeAssets({
      ...source,
      frames: [{ ...first, rect: { ...first.rect, width: 0 } }, ...source.frames.slice(1)],
    }, { projectRoot, outputDir: 'bad-rectangle' })).rejects.toThrow();

    await expect(buildThemeAssets({
      ...source,
      frames: [{ ...first, rect: { ...first.rect, x: 3 } }, ...source.frames.slice(1)],
    }, { projectRoot, outputDir: 'out-of-source-bounds' })).rejects.toThrow();

    await expect(buildThemeAssets({
      ...source,
      frames: [{ ...first, scale: 200 }, ...source.frames.slice(1)],
    }, { projectRoot, outputDir: 'clipped-pose' })).rejects.toThrow();
  });

  it('sanitizes source path details from build errors', async () => {
    const projectRoot = await makeRoot();
    const source = await createTheme(projectRoot);
    const first = requiredFrame(source.frames, 0);
    const secretPath = 'source/private-frame.png';
    await writeFile(path.join(projectRoot, secretPath), Buffer.from('not an image'));
    const error = await buildThemeAssets({ ...source, frames: [{ ...first, sourcePath: secretPath }, ...source.frames.slice(1)] }, { projectRoot, outputDir: 'broken' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain(projectRoot);
    expect(message).not.toContain(secretPath);
  });
});
