import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../../shared/model.js';
import { themeManifestSchema, type AnimationState, type RuntimeThemeManifest } from './theme-schema.js';
import { createThemeLoader, type ThemeAssetModule, type TextureAssets } from './theme-loader.js';

interface FakeTexture {
  width: number;
  height: number;
  url: string;
}

const animationStates: readonly AnimationState[] = ['idle', 'run', 'jump', 'fall', 'land', 'interact', 'happy'];
const artKinds = ['background', 'finish', 'gateClosed', 'gateOpen', 'plateIdle', 'plateActive', 'giftA', 'giftB'] as const;

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
const pageWidth = 1600;
const pageHeight = 1300;
const textureAssets: TextureAssets<FakeTexture> = {
  load: async (url) => ({ width: pageWidth, height: pageHeight, url }),
  unload: vi.fn(),
};

function runtimeManifest(
  themeId: ThemeId = 'first-date',
  pageKeys: readonly string[] = ['atlas-a', 'atlas-b'],
  mode: 'release' | 'pilot' = 'release',
): RuntimeThemeManifest {
  const pages = pageKeys.map((imageKey) => ({ imageKey, width: pageWidth, height: pageHeight }));
  const frames: RuntimeThemeManifest['frames'] = {};
  const animations: RuntimeThemeManifest['animations'] = { a: {}, b: {} };
  const roles = ['a', 'b'] as const;
  let frameNumber = 0;
  for (const role of roles) {
    const states = mode === 'pilot' ? animationStates.slice(0, 2) : animationStates;
    for (const state of states) {
      const count = frameCount(state);
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const id = `${role}-${state}-${index}`;
        const pageIndex = Math.floor(frameNumber / 26);
        const imageKey = pageKeys[pageIndex];
        if (imageKey === undefined) throw new Error('A runtime fixture needs at least one atlas page');
        const slot = frameNumber % 26;
        frames[id] = {
          imageKey,
          x: 2 + (slot % 6) * 260,
          y: 2 + Math.floor(slot / 6) * 260,
          width: 256,
          height: 256,
        };
        ids.push(id);
        frameNumber += 1;
      }
      animations[role][state] = ids;
    }
  }

  return {
    schemaVersion: 1,
    themeId,
    mode,
    anchor: { x: 0.5, y: 0.88 },
    pages,
    frames,
    animations,
  };
}

function assetModule(manifest: RuntimeThemeManifest, urls?: Readonly<Record<string, string>>): ThemeAssetModule {
  return {
    metadata: manifest,
    urls: urls ?? Object.fromEntries(manifest.pages.map((page) => [page.imageKey, `${page.imageKey}.png`])),
  };
}

function runtimeManifestWithArt(): RuntimeThemeManifest {
  return {
    ...runtimeManifest(),
    art: {
      background: { imageKey: 'art-background', width: 1800, height: 900 },
      finish: { imageKey: 'art-finish', width: 800, height: 600 },
      gateClosed: { imageKey: 'art-gate-closed', width: 140, height: 220 },
      gateOpen: { imageKey: 'art-gate-open', width: 140, height: 220 },
      plateIdle: { imageKey: 'art-plate-idle', width: 100, height: 40 },
      plateActive: { imageKey: 'art-plate-active', width: 100, height: 40 },
      giftA: { imageKey: 'art-gift-a', width: 80, height: 80 },
      giftB: { imageKey: 'art-gift-b', width: 80, height: 80 },
    },
  };
}

function artAssetModule(manifest: RuntimeThemeManifest): ThemeAssetModule {
  const art = manifest.art;
  if (!art) throw new Error('The art fixture needs a complete art set');
  return {
    metadata: manifest,
    urls: Object.fromEntries([
      ...manifest.pages.map(({ imageKey }) => [imageKey, `${imageKey}.png`]),
      ...artKinds.map((kind) => [art[kind].imageKey, `${art[kind].imageKey}.png`]),
    ]),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('createThemeLoader', () => {
  it('returns the active texture reference count to zero after final release', async () => {
    const activeTextures = new Set<FakeTexture>();
    const assets: TextureAssets<FakeTexture> = {
      load: async (url) => {
        const texture = { width: pageWidth, height: pageHeight, url };
        activeTextures.add(texture);
        return texture;
      },
      unload: (texture) => {
        activeTextures.delete(texture);
      },
    };
    const loader = createThemeLoader({
      catalog: { 'first-date': async () => assetModule(runtimeManifest()) },
      assets,
    });
    const lease = await loader('first-date', new AbortController().signal);
    expect(activeTextures.size).toBe(2);

    lease.release();

    expect(activeTextures.size).toBe(0);
  });

  it('loads art images into the same lease and releases all ten textures at the final reference', async () => {
    const manifest = runtimeManifestWithArt();
    const art = manifest.art;
    if (!art) throw new Error('Runtime fixture omitted art');
    const dimensions = new Map<string, { width: number; height: number }>();
    for (const { imageKey, width, height } of manifest.pages) dimensions.set(imageKey, { width, height });
    for (const kind of artKinds) {
      const { imageKey, width, height } = art[kind];
      dimensions.set(imageKey, { width, height });
    }
    const active = new Set<FakeTexture>();
    const load = vi.fn(async (url: string) => {
      const imageKey = url.replace(/\.png$/, '');
      const size = dimensions.get(imageKey);
      if (!size) throw new Error('Unknown fixture URL');
      const texture = { ...size, url };
      active.add(texture);
      return texture;
    });
    const unload = vi.fn<(texture: FakeTexture) => void>((texture) => { active.delete(texture); });
    const module = artAssetModule(manifest);
    const loader = createThemeLoader({ catalog: { 'first-date': async () => module }, assets: { load, unload } });
    const firstLease = await loader('first-date', new AbortController().signal);
    const secondLease = await loader('first-date', new AbortController().signal);

    expect(firstLease.pages.size).toBe(10);
    expect(Object.keys(module.urls)).toHaveLength(10);
    expect(active.size).toBe(10);
    firstLease.release();
    expect(active.size).toBe(10);
    secondLease.release();
    expect(active.size).toBe(0);
    expect(unload).toHaveBeenCalledTimes(10);
  });

  it('releases atlases and earlier art after a late art failure, then loads the full set on retry', async () => {
    const manifest = runtimeManifestWithArt();
    const module = artAssetModule(manifest);
    const active = new Set<FakeTexture>();
    let failed = false;
    const unload = vi.fn<(texture: FakeTexture) => void>((texture) => { active.delete(texture); });
    const load = vi.fn(async (url: string) => {
      if (url === 'art-gift-b.png' && !failed) {
        failed = true;
        throw new Error('image decode failed');
      }
      const imageKey = url.replace(/\.png$/, '');
      const page = manifest.pages.find((item) => item.imageKey === imageKey);
      const art = Object.values(manifest.art ?? {}).find((item) => item.imageKey === imageKey);
      const size = page ?? art;
      if (!size) throw new Error('Unknown fixture URL');
      const texture = { width: size.width, height: size.height, url };
      active.add(texture);
      return texture;
    });
    const loader = createThemeLoader({ catalog: { 'first-date': async () => module }, assets: { load, unload } });

    await expect(loader('first-date', new AbortController().signal)).rejects.toThrow();
    expect(active.size).toBe(0);
    expect(unload).toHaveBeenCalledTimes(9);
    const lease = await loader('first-date', new AbortController().signal);
    expect(lease.pages.size).toBe(10);
    expect(active.size).toBe(10);
    lease.release();
    expect(active.size).toBe(0);
    expect(unload).toHaveBeenCalledTimes(19);
  });

  it('loads only the requested theme and unloads each page after the final lease', async () => {
    const winterImport = vi.fn<() => Promise<ThemeAssetModule>>();
    const retroImport = vi.fn<() => Promise<ThemeAssetModule>>();
    const firstDateImport = vi.fn(async () => assetModule(runtimeManifest()));
    const unload = vi.fn<(texture: FakeTexture) => void>();
    const load = vi.fn(async (url: string) => ({ width: pageWidth, height: pageHeight, url }));
    const loader = createThemeLoader({
      catalog: {
        'first-date': firstDateImport,
        retro: retroImport,
        winter: winterImport,
      },
      assets: { load, unload },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstLease = await loader('first-date', firstController.signal);
    const secondLease = await loader('first-date', secondController.signal);

    expect(firstDateImport).toHaveBeenCalledTimes(1);
    expect(retroImport).not.toHaveBeenCalled();
    expect(winterImport).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    firstLease.release();
    expect(unload).not.toHaveBeenCalled();
    secondLease.release();
    secondLease.release();
    expect(unload).toHaveBeenCalledTimes(2);
  });

  it('shares a theme load while allowing one waiter to abort independently', async () => {
    const pendingImport = deferred<ThemeAssetModule>();
    const catalogLoader = vi.fn(() => pendingImport.promise);
    const loader = createThemeLoader({
      catalog: { 'first-date': catalogLoader },
      assets: textureAssets,
    });
    const canceled = new AbortController();
    const retained = new AbortController();
    const canceledLoad = loader('first-date', canceled.signal);
    const retainedLoad = loader('first-date', retained.signal);
    canceled.abort();
    pendingImport.resolve(assetModule(runtimeManifest()));

    await expect(canceledLoad).rejects.toMatchObject({ name: 'AbortError' });
    const lease = await retainedLoad;
    expect(catalogLoader).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('does not allocate textures when every waiter aborts before a lazy import resolves', async () => {
    const pendingImport = deferred<ThemeAssetModule>();
    const load = vi.fn(async (url: string) => ({ width: pageWidth, height: pageHeight, url }));
    const unload = vi.fn<(texture: FakeTexture) => void>();
    const loader = createThemeLoader({
      catalog: { 'first-date': () => pendingImport.promise },
      assets: { load, unload },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstLoad = loader('first-date', firstController.signal);
    const secondLoad = loader('first-date', secondController.signal);
    firstController.abort();
    secondController.abort();
    pendingImport.resolve(assetModule(runtimeManifest()));

    await expect(firstLoad).rejects.toMatchObject({ name: 'AbortError' });
    await expect(secondLoad).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
    expect(unload).not.toHaveBeenCalled();
  });

  it('rejects an already aborted request without importing the theme', async () => {
    const catalogLoader = vi.fn(async () => assetModule(runtimeManifest()));
    const loader = createThemeLoader({ catalog: { 'first-date': catalogLoader }, assets: textureAssets });
    const controller = new AbortController();
    controller.abort();

    await expect(loader('first-date', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(catalogLoader).not.toHaveBeenCalled();
  });

  it('rejects unknown page image keys, out-of-bounds frames, and missing frame records', () => {
    const valid = runtimeManifest();
    const unknownImageKey = structuredClone(valid);
    const firstFrame = unknownImageKey.frames['a-idle-0'];
    if (firstFrame === undefined) throw new Error('Runtime fixture omitted a-idle-0');
    unknownImageKey.frames['a-idle-0'] = { ...firstFrame, imageKey: 'missing-page' };

    const outOfBounds = structuredClone(valid);
    const boundedFrame = outOfBounds.frames['a-idle-0'];
    if (boundedFrame === undefined) throw new Error('Runtime fixture omitted a-idle-0');
    outOfBounds.frames['a-idle-0'] = { ...boundedFrame, x: pageWidth - 255 };

    const missingFrame = structuredClone(valid);
    delete missingFrame.frames['a-idle-0'];

    expect(themeManifestSchema.safeParse(valid).success).toBe(true);
    expect(themeManifestSchema.safeParse(unknownImageKey).success).toBe(false);
    expect(themeManifestSchema.safeParse(outOfBounds).success).toBe(false);
    expect(themeManifestSchema.safeParse(missingFrame).success).toBe(false);
  });

  it('rejects overlapping atlas frame rectangles', () => {
    const valid = runtimeManifest();
    const overlap = structuredClone(valid);
    const firstFrame = overlap.frames['a-idle-0'];
    if (firstFrame === undefined) throw new Error('Runtime fixture omitted a-idle-0');
    overlap.frames['a-idle-1'] = { ...firstFrame };

    expect(themeManifestSchema.safeParse(valid).success).toBe(true);
    expect(themeManifestSchema.safeParse(overlap).success).toBe(false);
  });

  it('rejects atlas frame rectangles with less than two pixels of spacing', () => {
    const valid = runtimeManifest();
    const narrowGap = structuredClone(valid);
    const nextFrame = narrowGap.frames['a-idle-1'];
    if (nextFrame === undefined) throw new Error('Runtime fixture omitted a-idle-1');
    narrowGap.frames['a-idle-1'] = { ...nextFrame, x: 2 + 256 + 1 };

    expect(themeManifestSchema.safeParse(valid).success).toBe(true);
    expect(themeManifestSchema.safeParse(narrowGap).success).toBe(false);
  });

  it('rejects pilot metadata in the default release loader before allocating textures', async () => {
    const load = vi.fn(async (url: string) => ({ width: pageWidth, height: pageHeight, url }));
    const pilot = runtimeManifest('first-date', ['pilot-atlas'], 'pilot');
    const loader = createThemeLoader({
      catalog: { 'first-date': async () => assetModule(pilot) },
      assets: { load, unload: vi.fn() },
    });

    await expect(loader('first-date', new AbortController().signal)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it('unloads partial allocations after a page failure and permits retry', async () => {
    const pageBLoads: string[] = [];
    const activeTextures = new Set<FakeTexture>();
    const unload = vi.fn((texture: FakeTexture) => {
      activeTextures.delete(texture);
    });
    const load = vi.fn(async (url: string) => {
      if (url === 'page-b.png') pageBLoads.push(url);
      if (url === 'page-b.png' && pageBLoads.length === 1) {
        throw new Error('decoder failed');
      }
      const texture = { width: pageWidth, height: pageHeight, url };
      activeTextures.add(texture);
      return texture;
    });
    const assets: TextureAssets<FakeTexture> = {
      load,
      unload,
    };
    const module = assetModule(runtimeManifest('first-date', ['page-a', 'page-b']), {
      'page-a': 'page-a.png',
      'page-b': 'page-b.png',
    });
    const loader = createThemeLoader({ catalog: { 'first-date': async () => module }, assets });
    const first = new AbortController();

    await expect(loader('first-date', first.signal)).rejects.toThrow();
    expect(unload).toHaveBeenCalledTimes(1);
    expect(assets.load).toHaveBeenCalledTimes(2);
    expect(activeTextures.size).toBe(0);

    const retry = await loader('first-date', new AbortController().signal);
    expect(assets.load).toHaveBeenCalledTimes(4);
    retry.release();
    expect(unload).toHaveBeenCalledTimes(3);
    expect(activeTextures.size).toBe(0);
  });

  it('cleans completed pages when all waiters abort during page loading', async () => {
    const pendingPage = deferred<FakeTexture>();
    const loadedTexture = { width: pageWidth, height: pageHeight, url: 'page-a.png' };
    const unload = vi.fn<(texture: FakeTexture) => void>();
    const load = vi.fn((url: string, signal: AbortSignal): Promise<FakeTexture> => {
      if (url === 'page-a.png') return Promise.resolve(loadedTexture);
      return new Promise((resolve, reject) => {
        const rejectOnAbort = (): void => reject(abortError());
        signal.addEventListener('abort', rejectOnAbort, { once: true });
        pendingPage.promise.then(resolve, reject);
      });
    });
    const module = assetModule(runtimeManifest('first-date', ['page-a', 'page-b']), {
      'page-a': 'page-a.png',
      'page-b': 'page-b.png',
    });
    const loader = createThemeLoader({ catalog: { 'first-date': async () => module }, assets: { load, unload } });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = loader('first-date', firstController.signal);
    const second = loader('first-date', secondController.signal);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    firstController.abort();
    secondController.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith(loadedTexture);
    pendingPage.reject(abortError());
  });

  it('validates texture dimensions against page metadata and releases allocations on mismatch', async () => {
    const unload = vi.fn<(texture: FakeTexture) => void>();
    const texture = { width: 128, height: pageHeight, url: 'atlas.png' };
    const loader = createThemeLoader({
      catalog: { 'first-date': async () => assetModule(runtimeManifest()) },
      assets: { load: async () => texture, unload },
    });

    await expect(loader('first-date', new AbortController().signal)).rejects.toThrow();
    expect(unload).toHaveBeenCalledWith(texture);
  });

  it('does not expose raw loader errors', async () => {
    const privateFailure = new Error('https://private.example/internal/path.png');
    const loader = createThemeLoader({
      catalog: { 'first-date': async () => assetModule(runtimeManifest()) },
      assets: { load: async () => Promise.reject(privateFailure), unload: vi.fn() },
    });

    await expect(loader('first-date', new AbortController().signal)).rejects.not.toBe(privateFailure);
  });
});
