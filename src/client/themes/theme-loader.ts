import { ImageSource, Texture } from 'pixi.js';
import type { ThemeId } from '../../shared/model.js';
import { THEME_ART_KINDS, themeManifestSchema, type RuntimeThemeManifest } from './theme-schema.js';

export type ThemeAssetModule = { metadata: unknown; urls: Readonly<Record<string, string>> };
export type TextureAssets<T extends { width: number; height: number }> = { load(url: string, signal: AbortSignal): Promise<T>; unload(texture: T): void };
export type LoadedTheme<T extends { width: number; height: number } = Texture> = {
  themeId: ThemeId; manifest: RuntimeThemeManifest; pages: ReadonlyMap<string, T>; release(): void;
};
type Entry<T extends { width: number; height: number }> = {
  controller: AbortController; pages: Map<string, T>; manifest: RuntimeThemeManifest | null;
  promise: Promise<void>; waiters: number; refs: number; canceled: boolean;
};
function loadError(): Error { return new Error('Theme assets could not be loaded'); }
function abortError(): DOMException { return new DOMException('The operation was aborted', 'AbortError'); }
function dispose<T extends { width: number; height: number }>(entry: Entry<T>, assets: TextureAssets<T>): void {
  for (const page of entry.pages.values()) assets.unload(page);
  entry.pages.clear();
}
export function createThemeLoader<T extends { width: number; height: number }>(options: {
  catalog: Partial<Record<ThemeId, () => Promise<ThemeAssetModule>>>; assets: TextureAssets<T>; mode?: 'release' | 'pilot';
}): (id: ThemeId, signal: AbortSignal) => Promise<LoadedTheme<T>> {
  const cache = new Map<ThemeId, Entry<T>>();
  return async (id, signal) => {
    if (signal.aborted) throw abortError();
    const importTheme = options.catalog[id];
    if (!importTheme) throw new Error('Theme assets are unavailable');
    let entry = cache.get(id);
    if (!entry) {
      const created: Entry<T> = { controller: new AbortController(), pages: new Map(), manifest: null, promise: Promise.resolve(), waiters: 0, refs: 0, canceled: false };
      entry = created;
      cache.set(id, created);
      created.promise = (async () => {
        try {
          const module = await importTheme();
          if (created.canceled) throw abortError();
          const manifest = themeManifestSchema.parse(module.metadata);
          if (manifest.themeId !== id || manifest.mode !== (options.mode ?? 'release')) throw new Error('Theme metadata mismatch');
          const keys = Object.keys(module.urls);
          const images = [...manifest.pages, ...(manifest.art ? THEME_ART_KINDS.map((kind) => manifest.art?.[kind]) : [])];
          if (keys.length !== images.length || images.some((image) => !image || !Object.hasOwn(module.urls, image.imageKey))) throw new Error('Theme page URLs mismatch');
          created.manifest = manifest;
          for (const page of images) {
            if (!page) throw new Error('Theme image missing');
            if (created.canceled) throw abortError();
            const url = module.urls[page.imageKey];
            if (!url) throw new Error('Missing page URL');
            const texture = await options.assets.load(url, created.controller.signal);
            if (created.canceled) { options.assets.unload(texture); throw abortError(); }
            if (texture.width !== page.width || texture.height !== page.height) { options.assets.unload(texture); throw new Error('Theme page dimensions mismatch'); }
            created.pages.set(page.imageKey, texture);
          }
        } catch (error) {
          dispose(created, options.assets);
          if (cache.get(id) === created) cache.delete(id);
          if (created.canceled || (error instanceof Error && error.name === 'AbortError')) throw abortError();
          throw loadError();
        }
      })();
      created.promise.catch(() => undefined);
    }
    entry.waiters += 1;
    const current = entry;
    return new Promise<LoadedTheme<T>>((resolve, reject) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        current.waiters -= 1;
        if (current.waiters === 0 && current.refs === 0) {
          current.canceled = true;
          current.controller.abort();
          dispose(current, options.assets);
          if (cache.get(id) === current) cache.delete(id);
        }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.promise.then(() => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        current.waiters -= 1;
        current.refs += 1;
        const manifest = current.manifest;
        if (!manifest) { reject(new Error('Theme metadata unavailable')); return; }
        let released = false;
        resolve({ themeId: id, manifest, pages: current.pages, release: () => {
          if (released) return;
          released = true;
          current.refs -= 1;
          if (current.refs === 0 && current.waiters === 0) {
            dispose(current, options.assets);
            if (cache.get(id) === current) cache.delete(id);
          }
        } });
      }, (error: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        current.waiters -= 1;
        reject(error);
      });
    });
  };
}
const pixiAssets: TextureAssets<Texture> = {
  async load(url, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('Image fetch failed');
      const bitmap = await createImageBitmap(await response.blob());
      if (controller.signal.aborted) { bitmap.close(); throw abortError(); }
      return new Texture({ source: new ImageSource({ resource: bitmap }) });
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  },
  unload(texture) { const resource = texture.source.resource; texture.destroy(true); if (resource instanceof ImageBitmap) resource.close(); },
};
export const loadTheme = createThemeLoader({ catalog: { 'first-date': () => import('./first-date.js'), retro: () => import('./retro.js'), winter: () => import('./winter.js') }, assets: pixiAssets });
export { pixiAssets as pixiTextureAssets };
