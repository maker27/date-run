import { mkdir, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { z } from 'zod';
import type { Role, ThemeId } from '../src/shared/model.js';
import { ANIMATION_SPECS, ANIMATION_STATES, THEME_ART_KINDS, themeManifestSchema, type AnimationState, type RuntimeThemeManifest, type ThemeArtKind } from '../src/client/themes/theme-schema.js';
export type { ThemeArtKind } from '../src/client/themes/theme-schema.js';

const relativePath = z.string().min(1).refine((value) => !value.includes('\\') && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const point = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
const sourceFrameSchema = z.strictObject({
  role: z.enum(['a', 'b']), state: z.enum(ANIMATION_STATES), index: z.number().int().min(0), sourcePath: relativePath,
  rect: z.strictObject({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() }),
  pivot: point, scale: z.number().finite().positive(),
});
const sourceArtImageSchema = z.strictObject({ sourcePath: relativePath, rect: sourceFrameSchema.shape.rect, scale: z.number().finite().positive() });
const sourceArtSchema = z.strictObject({ background: sourceArtImageSchema, finish: sourceArtImageSchema, gateClosed: sourceArtImageSchema, gateOpen: sourceArtImageSchema, plateIdle: sourceArtImageSchema, plateActive: sourceArtImageSchema, giftA: sourceArtImageSchema, giftB: sourceArtImageSchema });
const sourceSchema = z.strictObject({ schemaVersion: z.literal(1), themeId: z.enum(['first-date', 'retro', 'winter']), mode: z.enum(['pilot', 'release']), frames: z.array(sourceFrameSchema), art: sourceArtSchema.optional() }).refine((source) => source.mode !== 'pilot' || source.art === undefined, 'Pilot cannot contain art');
export type SourceFrame = { role: Role; state: AnimationState; index: number; sourcePath: string; rect: { x: number; y: number; width: number; height: number }; pivot: { x: number; y: number }; scale: number };
export type SourceArtImage = z.infer<typeof sourceArtImageSchema>;
export type SourceThemeManifest = { schemaVersion: 1; themeId: ThemeId; mode: 'pilot' | 'release'; frames: SourceFrame[]; art?: Record<ThemeArtKind, SourceArtImage> | undefined };
export type BuildReport = { manifest: RuntimeThemeManifest; manifestPath: string; pagePaths: string[]; artPaths: Partial<Record<ThemeArtKind, string>> };
export function parseSourceThemeManifest(input: unknown): SourceThemeManifest { return sourceSchema.parse(input); }
function assetDecodeError(): Error { return new Error('Source image could not be decoded'); }
const FRAME_SIZE = 256;
const SLOT_SIZE = 258;
const SLOTS_PER_ROW = 7;
const PAGE_CAPACITY = 49;

function within(root: string, candidate: string): boolean { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
async function safeExisting(root: string, name: string): Promise<string> {
  const resolved = await realpath(path.join(root, name));
  if (!within(root, resolved)) throw new Error('Asset path escapes project');
  return resolved;
}
async function safeOutput(root: string, name: string): Promise<string> {
  if (!relativePath.safeParse(name).success) throw new Error('Invalid output path');
  let current = root;
  for (const segment of name.split('/')) {
    current = path.join(current, segment);
    try { const resolved = await realpath(current); if (!within(root, resolved)) throw new Error('Output path escapes project'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  return path.join(root, name);
}
function orderedFrames(source: SourceThemeManifest): SourceFrame[] {
  const states = source.mode === 'pilot' ? ANIMATION_STATES.slice(0, 2) : ANIMATION_STATES;
  const byId = new Map<string, SourceFrame>();
  for (const frame of source.frames) {
    const id = `${frame.role}-${frame.state}-${frame.index}`;
    if (byId.has(id)) throw new Error('Duplicate source frame');
    byId.set(id, frame);
  }
  const ordered: SourceFrame[] = [];
  for (const role of ['a', 'b'] as const) for (const state of states) for (let index = 0; index < ANIMATION_SPECS[state].frameCount; index += 1) {
    const item = byId.get(`${role}-${state}-${index}`);
    if (!item) throw new Error('Missing source frame');
    ordered.push(item);
  }
  if (ordered.length !== source.frames.length) throw new Error('Unexpected source frame');
  return ordered;
}
async function normalize(frame: SourceFrame, root: string): Promise<Buffer> {
  let source: string;
  try { source = await safeExisting(root, frame.sourcePath); } catch { throw new Error('Source image unavailable'); }
  try {
    const image = sharp(source, { failOn: 'error' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !metadata.hasAlpha || frame.rect.x + frame.rect.width > metadata.width || frame.rect.y + frame.rect.height > metadata.height) throw new Error('Invalid source image or crop');
    const { data, info } = await image.extract({ left: frame.rect.x, top: frame.rect.y, width: frame.rect.width, height: frame.rect.height }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error('Source image must be RGBA');
    const width = Math.max(1, Math.round(frame.rect.width * frame.scale));
    const height = Math.max(1, Math.round(frame.rect.height * frame.scale));
    if (width > 4096 || height > 4096) throw new Error('Normalized frame too large');
    const resized = frame.scale === 1 ? data : await sharp(data, { raw: { width: frame.rect.width, height: frame.rect.height, channels: 4 } }).resize(width, height).raw().toBuffer();
    const left = 128 - Math.round(frame.pivot.x * frame.scale);
    const top = 225 - Math.round(frame.pivot.y * frame.scale);
    const canvas = Buffer.alloc(FRAME_SIZE * FRAME_SIZE * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const targetX = left + x; const targetY = top + y;
      if (targetX < 0 || targetX >= FRAME_SIZE || targetY < 0 || targetY >= FRAME_SIZE) {
        if (resized[from + 3] !== 0) throw new Error('Visible frame would clip');
      } else resized.copy(canvas, (targetY * FRAME_SIZE + targetX) * 4, from, from + 4);
    }
    return canvas;
  } catch (error) {
    if (error instanceof Error && ['Invalid source image or crop', 'Source image must be RGBA', 'Normalized frame too large', 'Visible frame would clip'].includes(error.message)) throw error;
    throw assetDecodeError();
  }
}
async function normalizeArt(art: SourceArtImage, root: string): Promise<{ buffer: Buffer; width: number; height: number }> {
  let source: string;
  try { source = await safeExisting(root, art.sourcePath); } catch { throw new Error('Source image unavailable'); }
  try {
    const image = sharp(source, { failOn: 'error' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || art.rect.x + art.rect.width > metadata.width || art.rect.y + art.rect.height > metadata.height) throw new Error('Invalid source image or crop');
    const width = Math.max(1, Math.round(art.rect.width * art.scale));
    const height = Math.max(1, Math.round(art.rect.height * art.scale));
    if (width > 2048 || height > 2048) throw new Error('Normalized art too large');
    const buffer = await image.extract({ left: art.rect.x, top: art.rect.y, width: art.rect.width, height: art.rect.height }).resize(width, height).ensureAlpha().png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    return { buffer, width, height };
  } catch (error) {
    if (error instanceof Error && ['Invalid source image or crop', 'Normalized art too large'].includes(error.message)) throw error;
    throw assetDecodeError();
  }
}
export async function buildThemeAssets(input: SourceThemeManifest, options: { projectRoot?: string; outputDir?: string } = {}): Promise<BuildReport> {
  const source = parseSourceThemeManifest(input);
  const root = await realpath(options.projectRoot ?? fileURLToPath(new URL('..', import.meta.url)));
  const outputDir = options.outputDir ?? (source.mode === 'pilot' ? `art/preview/generated/${source.themeId}` : `src/client/themes/generated/${source.themeId}`);
  const outputPath = await safeOutput(root, outputDir);
  const frames = orderedFrames(source);
  const normalized = await Promise.all(frames.map((frame) => normalize(frame, root)));
  const pages: RuntimeThemeManifest['pages'] = [];
  const pagePaths: string[] = [];
  const frameMap: RuntimeThemeManifest['frames'] = {};
  const animations: RuntimeThemeManifest['animations'] = { a: {}, b: {} };
  const files = new Map<string, Buffer>();
  const artPaths: BuildReport['artPaths'] = {};
  const artMetadata: RuntimeThemeManifest['art'] = source.art ? {
    background: { imageKey: '', width: 1, height: 1 }, finish: { imageKey: '', width: 1, height: 1 }, gateClosed: { imageKey: '', width: 1, height: 1 }, gateOpen: { imageKey: '', width: 1, height: 1 },
    plateIdle: { imageKey: '', width: 1, height: 1 }, plateActive: { imageKey: '', width: 1, height: 1 }, giftA: { imageKey: '', width: 1, height: 1 }, giftB: { imageKey: '', width: 1, height: 1 },
  } : undefined;
  if (source.art && artMetadata) for (const kind of THEME_ART_KINDS) {
    const image = await normalizeArt(source.art[kind], root);
    const imageKey = `art-${kind.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    artMetadata[kind] = { imageKey, width: image.width, height: image.height };
    const name = `${imageKey}.png`;
    artPaths[kind] = `${outputDir}/${name}`;
    files.set(name, image.buffer);
  }
  for (let pageIndex = 0; pageIndex * PAGE_CAPACITY < frames.length; pageIndex += 1) {
    const start = pageIndex * PAGE_CAPACITY;
    const count = Math.min(PAGE_CAPACITY, frames.length - start);
    const rows = Math.ceil(count / SLOTS_PER_ROW);
    const pageWidth = SLOTS_PER_ROW * SLOT_SIZE + 2;
    const pageHeight = rows * SLOT_SIZE + 2;
    const pageRaw = Buffer.alloc(pageWidth * pageHeight * 4);
    const imageKey = `atlas-${pageIndex}`;
    for (let slot = 0; slot < count; slot += 1) {
      const frame = frames[start + slot]; const rgba = normalized[start + slot];
      if (!frame || !rgba) throw new Error('Frame packing failed');
      const x = 2 + (slot % SLOTS_PER_ROW) * SLOT_SIZE;
      const y = 2 + Math.floor(slot / SLOTS_PER_ROW) * SLOT_SIZE;
      for (let row = 0; row < FRAME_SIZE; row += 1) rgba.copy(pageRaw, ((y + row) * pageWidth + x) * 4, row * FRAME_SIZE * 4, (row + 1) * FRAME_SIZE * 4);
      const id = `${frame.role}-${frame.state}-${frame.index}`;
      frameMap[id] = { imageKey, x, y, width: FRAME_SIZE, height: FRAME_SIZE };
      const ids = animations[frame.role][frame.state] ?? [];
      ids.push(id); animations[frame.role][frame.state] = ids;
    }
    pages.push({ imageKey, width: pageWidth, height: pageHeight });
    const name = `${imageKey}.png`;
    pagePaths.push(`${outputDir}/${name}`);
    files.set(name, await sharp(pageRaw, { raw: { width: pageWidth, height: pageHeight, channels: 4 } }).png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer());
  }
  const manifest = themeManifestSchema.parse({ schemaVersion: 1, themeId: source.themeId, mode: source.mode, anchor: { x: 0.5, y: 0.88 }, pages, frames: frameMap, animations, ...(artMetadata ? { art: artMetadata } : {}) });
  files.set('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = await mkdtemp(`${outputPath}.tmp-`);
  const backupPath = `${outputPath}.backup-${randomUUID()}`;
  let backedUp = false;
  try {
    for (const [name, buffer] of files) await writeFile(path.join(tempPath, name), buffer);
    try { await stat(outputPath); await rename(outputPath, backupPath); backedUp = true; }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    try { await rename(tempPath, outputPath); }
    catch (error) { if (backedUp) await rename(backupPath, outputPath); throw error; }
    if (backedUp) await rm(backupPath, { recursive: true });
  } finally { await rm(tempPath, { recursive: true, force: true }); }
  return { manifest, manifestPath: `${outputDir}/manifest.json`, pagePaths, artPaths };
}
