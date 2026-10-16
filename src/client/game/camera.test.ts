import { describe, expect, it } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';
import type { PlayerBody } from '../../shared/model.js';
import { computeCamera, computeFinishCamera } from './camera.js';

function actorAt(x: number, y: number): PlayerBody {
  return { x, y, vx: 0, vy: 0, grounded: true, facing: 1 };
}

function expectActorVisible(
  body: PlayerBody,
  camera: ReturnType<typeof computeCamera>,
  viewport: { width: number; height: number; insets?: { top: number; bottom: number } },
): void {
  const screenX = (body.x - camera.x) * camera.scale;
  const screenY = (body.y - camera.y) * camera.scale;
  const screenRight = screenX + PLAYER_WIDTH * camera.scale;
  const screenBottom = screenY + PLAYER_HEIGHT * camera.scale;
  const top = viewport.insets?.top ?? 0;
  const bottom = viewport.height - (viewport.insets?.bottom ?? 0);

  expect(screenX).toBeGreaterThanOrEqual(0);
  expect(screenRight).toBeLessThanOrEqual(viewport.width);
  expect(screenY).toBeGreaterThanOrEqual(top);
  expect(screenBottom).toBeLessThanOrEqual(bottom);
}

describe('computeCamera', () => {
  it.each([
    ['role a spawn', actorAt(LEVEL.spawns.a.x, LEVEL.spawns.a.y)],
    ['role b spawn', actorAt(LEVEL.spawns.b.x, LEVEL.spawns.b.y)],
    ['world center', actorAt(8990, LEVEL.groundY - PLAYER_HEIGHT)],
  ])('keeps the %s actor visible inside the usable portrait viewport', (_label, body) => {
    const viewport = { width: 390, height: 844, insets: { top: 96, bottom: 180 } };
    const camera = computeCamera(body, LEVEL, viewport);
    expectActorVisible(body, camera, viewport);
    expect(camera.x).toBeGreaterThanOrEqual(0);
    expect(camera.x + camera.width).toBeLessThanOrEqual(LEVEL.bounds.width);
    expect(camera.y).toBeGreaterThanOrEqual(0);
    expect(camera.y + camera.height).toBeLessThanOrEqual(LEVEL.bounds.height);
  });

  it('keeps the world bounds finite and stable after a landscape resize', () => {
    const body = actorAt(LEVEL.spawns.b.x, LEVEL.spawns.b.y);
    const portrait = computeCamera(body, LEVEL, { width: 390, height: 844, insets: { top: 80, bottom: 170 } });
    const landscape = computeCamera(body, LEVEL, { width: 1280, height: 720, insets: { top: 80, bottom: 0 } });

    for (const camera of [portrait, landscape]) {
      expect(Object.values(camera).every(Number.isFinite)).toBe(true);
      expect(camera.scale).toBeGreaterThan(0);
      expect(camera.x).toBeGreaterThanOrEqual(0);
      expect(camera.x + camera.width).toBeLessThanOrEqual(LEVEL.bounds.width);
      expect(camera.y).toBeGreaterThanOrEqual(0);
      expect(camera.y + camera.height).toBeLessThanOrEqual(LEVEL.bounds.height);
    }
    expectActorVisible(body, portrait, { width: 390, height: 844, insets: { top: 80, bottom: 170 } });
    expectActorVisible(body, landscape, { width: 1280, height: 720, insets: { top: 80, bottom: 0 } });
    expect(landscape.scale).toBeGreaterThanOrEqual(portrait.scale * 0.5);
  });

  it('keeps scale constant between grounded and jump apex at the same viewport', () => {
    const viewport = { width: 390, height: 844, insets: { top: 96, bottom: 180 } };
    const grounded = actorAt(64, 792);
    const jumpApex = { ...actorAt(64, 672), grounded: false, vy: 0 };
    const groundedCamera = computeCamera(grounded, LEVEL, viewport);
    const apexCamera = computeCamera(jumpApex, LEVEL, viewport);

    expect(apexCamera.scale).toBe(groundedCamera.scale);
    expectActorVisible(grounded, groundedCamera, viewport);
    expectActorVisible(jumpApex, apexCamera, viewport);
    for (const camera of [groundedCamera, apexCamera]) {
      expect(camera.x).toBeGreaterThanOrEqual(0);
      expect(camera.x + camera.width).toBeLessThanOrEqual(LEVEL.bounds.width);
      expect(camera.y).toBeGreaterThanOrEqual(0);
      expect(camera.y + camera.height).toBeLessThanOrEqual(LEVEL.bounds.height);
    }
  });
});

it('frames the entire finish on phones without reserving space for touch controls', () => {
  for (const viewport of [{ width: 328, height: 380 }, { width: 942, height: 405 }]) {
    const camera = computeFinishCamera(LEVEL, viewport);
    expect(camera.x).toBeLessThanOrEqual(LEVEL.finish.x);
    expect(camera.x + camera.width).toBeGreaterThanOrEqual(LEVEL.finish.x + LEVEL.finish.width);
    expect((LEVEL.groundY - camera.y) * camera.scale).toBeCloseTo(viewport.height - 24);
  }
});
