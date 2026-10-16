import type { LevelDefinition } from '../../shared/level.js';
import type { PlayerBody } from '../../shared/model.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';

export interface CameraView { x: number; y: number; scale: number; width: number; height: number }
export interface Viewport { width: number; height: number; insets?: { top: number; bottom: number } }

export function computeFinishCamera(level: LevelDefinition, viewport: Viewport): CameraView {
  const scale = Math.min(1.01, Math.max(1, viewport.width) / (level.finish.width + 48));
  const width = Math.max(1, viewport.width) / scale;
  const height = Math.max(1, viewport.height) / scale;
  const x = clamp(level.finish.x + level.finish.width / 2 - width / 2, level.bounds.x, level.bounds.x + level.bounds.width - width);
  const y = clamp(level.groundY - height + 24 / scale, level.bounds.y, level.bounds.y + level.bounds.height - height);
  return { x, y, scale, width, height };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeCamera(body: PlayerBody, level: LevelDefinition, viewport: Viewport): CameraView {
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const top = clamp(viewport.insets?.top ?? 0, 0, viewportHeight);
  const bottom = clamp(viewport.insets?.bottom ?? 0, 0, viewportHeight - top);
  const scale = 1.01 * Math.max(
    1,
    viewportWidth / level.bounds.width,
    viewportHeight / level.bounds.height,
    bottom / Math.max(1, level.bounds.y + level.bounds.height - level.groundY),
    top / Math.max(1, level.groundY - PLAYER_HEIGHT - level.bounds.y),
  );
  const width = viewportWidth / scale;
  const height = viewportHeight / scale;
  const actorCenterX = body.x + PLAYER_WIDTH / 2;
  const actorCenterY = body.y + PLAYER_HEIGHT / 2;
  const usableCenterY = (top + viewportHeight - bottom) / 2;
  const x = clamp(actorCenterX - width / 2, level.bounds.x, level.bounds.x + level.bounds.width - width);
  const y = clamp(actorCenterY - usableCenterY / scale, level.bounds.y, level.bounds.y + level.bounds.height - height);
  return { x, y, scale, width, height };
}
