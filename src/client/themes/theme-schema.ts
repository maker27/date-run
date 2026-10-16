import { z } from 'zod';

export const ANIMATION_SPECS = {
  idle: { frameCount: 4, fps: 8, loop: true },
  run: { frameCount: 8, fps: 12, loop: true },
  jump: { frameCount: 1, fps: 0, loop: true },
  fall: { frameCount: 1, fps: 0, loop: true },
  land: { frameCount: 2, fps: 12, loop: false },
  interact: { frameCount: 4, fps: 8, loop: false },
  happy: { frameCount: 6, fps: 8, loop: false },
} as const;
export type AnimationState = keyof typeof ANIMATION_SPECS;
export const ANIMATION_STATES = ['idle', 'run', 'jump', 'fall', 'land', 'interact', 'happy'] as const;
export const THEME_ART_KINDS = ['background', 'finish', 'gateClosed', 'gateOpen', 'plateIdle', 'plateActive', 'giftA', 'giftB'] as const;
export type ThemeArtKind = typeof THEME_ART_KINDS[number];
const imageKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const pageSchema = z.strictObject({ imageKey: imageKeySchema, width: z.number().int().min(1).max(2048), height: z.number().int().min(1).max(2048) });
const artSchema = z.strictObject({ background: pageSchema, finish: pageSchema, gateClosed: pageSchema, gateOpen: pageSchema, plateIdle: pageSchema, plateActive: pageSchema, giftA: pageSchema, giftB: pageSchema });
const frameSchema = z.strictObject({ imageKey: imageKeySchema, x: z.number().int().min(0), y: z.number().int().min(0), width: z.literal(256), height: z.literal(256) });
const animationSchema = z.object({
  idle: z.array(z.string()).optional(), run: z.array(z.string()).optional(), jump: z.array(z.string()).optional(),
  fall: z.array(z.string()).optional(), land: z.array(z.string()).optional(), interact: z.array(z.string()).optional(), happy: z.array(z.string()).optional(),
}).strict();
export const themeManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), themeId: z.enum(['first-date', 'retro', 'winter']), mode: z.enum(['pilot', 'release']),
  anchor: z.strictObject({ x: z.literal(0.5), y: z.literal(0.88) }),
  pages: z.array(pageSchema).min(1), frames: z.record(z.string(), frameSchema),
  art: artSchema.optional(),
  animations: z.strictObject({ a: animationSchema, b: animationSchema }),
}).superRefine((manifest, ctx) => {
  const keys = new Set(manifest.pages.map((page) => page.imageKey));
  const art = manifest.art;
  const artKeys = art ? THEME_ART_KINDS.map((kind) => art[kind].imageKey) : [];
  for (const key of artKeys) keys.add(key);
  if (keys.size !== manifest.pages.length + artKeys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate image key' });
  const usedFrames = new Set<string>();
  const usedPages = new Set<string>();
  for (const role of ['a', 'b'] as const) {
    const expected = manifest.mode === 'pilot' ? ANIMATION_STATES.slice(0, 2) : ANIMATION_STATES;
    if (Object.keys(manifest.animations[role]).length !== expected.length) ctx.addIssue({ code: 'custom', message: 'Invalid animation inventory' });
    for (const state of expected) {
      const ids = manifest.animations[role][state];
      if (!ids || ids.length !== ANIMATION_SPECS[state].frameCount) { ctx.addIssue({ code: 'custom', message: 'Invalid frame count' }); continue; }
      ids.forEach((id, index) => {
        if (id !== `${role}-${state}-${index}` || usedFrames.has(id)) ctx.addIssue({ code: 'custom', message: 'Invalid frame ID' });
        usedFrames.add(id);
        const frame = manifest.frames[id];
        if (!frame) { ctx.addIssue({ code: 'custom', message: 'Missing frame' }); return; }
        const page = manifest.pages.find((item) => item.imageKey === frame.imageKey);
        if (!page || frame.x + frame.width > page.width || frame.y + frame.height > page.height || frame.x < 2 || frame.y < 2 || frame.x + frame.width + 2 > page.width || frame.y + frame.height + 2 > page.height) ctx.addIssue({ code: 'custom', message: 'Frame outside page' });
        usedPages.add(frame.imageKey);
      });
    }
  }
  const rectangles = Object.values(manifest.frames);
  for (let firstIndex = 0; firstIndex < rectangles.length; firstIndex += 1) {
    const first = rectangles[firstIndex];
    if (!first) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < rectangles.length; secondIndex += 1) {
      const second = rectangles[secondIndex];
      if (!second || first.imageKey !== second.imageKey) continue;
      const horizontalGap = first.x + first.width + 2 <= second.x || second.x + second.width + 2 <= first.x;
      const verticalGap = first.y + first.height + 2 <= second.y || second.y + second.height + 2 <= first.y;
      if (!horizontalGap && !verticalGap) ctx.addIssue({ code: 'custom', message: 'Atlas frames require 2px padding' });
    }
  }
  if (usedFrames.size !== Object.keys(manifest.frames).length || usedPages.size !== manifest.pages.length) ctx.addIssue({ code: 'custom', message: 'Unused asset' });
});
export type RuntimeThemeManifest = z.infer<typeof themeManifestSchema>;
export const releaseThemeSchema = themeManifestSchema.safeExtend({ mode: z.literal('release'), art: artSchema });
