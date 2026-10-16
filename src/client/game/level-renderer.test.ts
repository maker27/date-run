import { expect, it } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import { makeSnapshot, localPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import { LevelRenderer } from './level-renderer.js';
import { createObstacle } from './obstacle-visual.js';

it('marks both plate positions and hides their arrows after the gate opens', () => {
  const renderer = new LevelRenderer(LEVEL);
  try {
    const left = renderer.container.getChildByLabel('plate-hint-switch-left');
    const right = renderer.container.getChildByLabel('plate-hint-switch-right');
    expect(left?.x).toBe(8808);
    expect(right?.x).toBe(9192);
    expect(left?.width).toBeGreaterThanOrEqual(48);
    const snapshot = makeSnapshot();
    snapshot.state.switches[0] = { id: 'switch-left', occupant: localPlayerId };
    renderer.applyWorld(snapshot);
    expect(left?.getChildByLabel('occupied')?.visible).toBe(true);
    expect(right?.getChildByLabel('occupied')?.visible).toBe(false);
    renderer.applyWorld(makeSnapshot({ gateOpen: true }));
    expect(left?.visible).toBe(false);
    expect(right?.visible).toBe(false);
  } finally { renderer.destroy(); }
});

it('covers the full ground depth with themed paving', () => {
  const renderer = new LevelRenderer(LEVEL);
  try {
    const ground = renderer.container.getChildByLabel('ground');
    expect(ground?.y).toBe(LEVEL.groundY);
    expect(ground?.height).toBe(LEVEL.bounds.height - LEVEL.groundY);
    expect(ground?.children.length).toBeGreaterThan(1);
  } finally { renderer.destroy(); }
});

it('keeps obstacle graphics within solid collider bounds and distinguishes all themes', () => {
  const bounds = { x: 120, y: 240, width: 84, height: 60 };
  const cases = [
    ['first-date', 'planter'],
    ['retro', 'luggage'],
    ['winter', 'snowbank'],
  ] as const;

  for (const [themeId, label] of cases) {
    const obstacle = createObstacle(bounds, themeId, 'solid');
    expect(obstacle.label).toBe(label);
    expect(obstacle.x).toBe(bounds.x);
    expect(obstacle.y).toBe(bounds.y);
    expect(obstacle.width).toBe(bounds.width);
    expect(obstacle.height).toBe(bounds.height);
  }
});

it('gives platforms themed supports below the unchanged collision top', () => {
  const bounds = { x: 400, y: 320, width: 240, height: 16 };
  const cases = [
    ['first-date', 'bench'],
    ['retro', 'counter'],
    ['winter', 'ice-shelf'],
  ] as const;

  for (const [themeId, label] of cases) {
    const obstacle = createObstacle(bounds, themeId, 'platform');
    const surface = obstacle.getChildByLabel('collision-surface');
    const support = obstacle.getChildByLabel(label);
    expect(surface?.y).toBe(0);
    expect(surface?.height).toBe(bounds.height);
    expect(obstacle.y).toBe(bounds.y);
    expect(obstacle.height).toBeGreaterThanOrEqual(bounds.height);
    expect(support?.y).toBeGreaterThanOrEqual(bounds.height);
    expect(support?.height).toBeGreaterThan(0);
  }
});

it('highlights the meeting area only while the open gate is awaiting reunion', () => {
  const renderer = new LevelRenderer(LEVEL);
  try {
    const hint = renderer.container.getChildByLabel('finish-hint');
    expect(hint).toBeDefined();
    expect(hint?.visible).toBe(false);
    renderer.applyWorld(makeSnapshot({ gateOpen: true }));
    expect(hint?.visible).toBe(true);
    expect(hint?.x).toBe(9000);
    expect(hint?.getChildByLabel('finish-arrow')?.y).toBeLessThan(-440);
    expect(hint?.getChildByLabel('finish-glow')?.width).toBeGreaterThanOrEqual(LEVEL.finish.width);
    const complete = makeSnapshot({ gateOpen: true });
    complete.state.phase = 'complete';
    renderer.applyWorld(complete);
    expect(hint?.visible).toBe(false);
    renderer.applyWorld(makeSnapshot());
    expect(hint?.visible).toBe(false);
  } finally { renderer.destroy(); }
});

it('keeps the meeting arrow below the HUD when the arch top is outside the viewport', () => {
  const renderer = new LevelRenderer(LEVEL);
  try {
    renderer.applyWorld(makeSnapshot({ gateOpen: true }));
    renderer.updateView(8700, 650);
    const hint = renderer.container.getChildByLabel('finish-hint');
    const arrow = hint?.getChildByLabel('finish-arrow');
    expect((hint?.y ?? 0) + (arrow?.y ?? 0) - 25).toBeGreaterThanOrEqual(650);
    renderer.updateView(8700, 100);
    expect(arrow?.y).toBe(-470);
  } finally { renderer.destroy(); }
});
