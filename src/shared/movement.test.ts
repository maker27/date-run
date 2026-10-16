import { describe, expect, it } from 'vitest';
import type { PlayerBody, PlayerInput } from './model.js';
import type { Rect } from './model.js';
import { collisionWorld, spawnBody, stepPlayer, type CollisionWorld } from './movement.js';
import { LEVEL } from './level.js';
import { SHORT_LEVEL } from '../../tests/fixtures/short-level.js';

const neutral: PlayerInput = { axis: 0, jumpPressed: false };
const emptyWorld = (groundY = 848, width = 2000, height = 960): CollisionWorld => ({
  bounds: { x: 0, y: 0, width, height },
  solids: [{ x: 0, y: groundY, width, height: height - groundY }],
  oneWays: [],
});
const body = (x: number, y: number, grounded = false): PlayerBody => ({
  x, y, vx: 0, vy: 0, grounded, facing: 1,
});
const runSteps = (
  initial: PlayerBody,
  input: PlayerInput,
  world: CollisionWorld,
  count: number,
): PlayerBody => {
  let current = initial;
  for (let step = 0; step < count; step += 1) current = stepPlayer(current, input, world);
  return current;
};
const overlaps = (player: PlayerBody, rect: Rect): boolean =>
  player.x < rect.x + rect.width && player.x + 32 > rect.x
  && player.y < rect.y + rect.height && player.y + 56 > rect.y;

const moveUntilOverlap = (
  initial: PlayerBody,
  target: Rect,
  world: CollisionWorld,
): PlayerBody => {
  let current = initial;
  for (let step = 0; step < 1000 && !overlaps(current, target); step += 1) {
    const targetCenter = target.x + target.width / 2;
    const playerCenter = current.x + 16;
    current = stepPlayer(current, {
      axis: Math.abs(targetCenter - playerCenter) < 8 ? 0 : targetCenter > playerCenter ? 1 : -1,
      jumpPressed: false,
    }, world);
  }
  return current;
};

const moveAcrossHurdles = (initial: PlayerBody, target: Rect, world: CollisionWorld, hurdles: readonly Rect[]): PlayerBody => {
  let current = initial;
  for (let step = 0; step < 12000 && !overlaps(current, target); step += 1) {
    const targetCenter = target.x + target.width / 2;
    const direction = targetCenter > current.x + 16 ? 1 : -1;
    const hurdleAhead = hurdles.some((hurdle) => direction === 1
      ? hurdle.x >= current.x + 32 && hurdle.x - (current.x + 32) < 60
      : hurdle.x + hurdle.width <= current.x && current.x - (hurdle.x + hurdle.width) < 60);
    current = stepPlayer(current, {
      axis: direction,
      jumpPressed: current.grounded && hurdleAhead,
    }, world);
  }
  return current;
};

const moveWithinGiftRadius = (
  initial: PlayerBody,
  gift: { x: number; y: number },
  world: CollisionWorld,
  hurdles: readonly Rect[],
): PlayerBody => {
  let current = initial;
  for (let step = 0; step < 12000 && Math.hypot(current.x + 16 - gift.x, current.y + 28 - gift.y) > 48; step += 1) {
    const direction = gift.x > current.x + 16 ? 1 : -1;
    const hurdleAhead = hurdles.some((hurdle) => direction === 1
      ? hurdle.x >= current.x + 32 && hurdle.x - (current.x + 32) < 60
      : hurdle.x + hurdle.width <= current.x && current.x - (hurdle.x + hurdle.width) < 60);
    current = stepPlayer(current, {
      axis: direction,
      jumpPressed: current.grounded && hurdleAhead,
    }, world);
  }
  return current;
};

describe('stepPlayer', () => {
  it('lands on the floor at the expected top-left coordinate', () => {
    const landed = runSteps(body(100, 700), neutral, emptyWorld(), 60);
    expect(landed).toMatchObject({ y: 792, vy: 0, grounded: true });
  });

  it('blocks a wall and respects the world bounds', () => {
    const world = {
      bounds: { x: 0, y: 0, width: 240, height: 400 },
      solids: [
        { x: 120, y: 0, width: 16, height: 344 },
        { x: 0, y: 344, width: 240, height: 56 },
      ],
      oneWays: [],
    };
    const stopped = runSteps(body(32, 288, true), { axis: 1, jumpPressed: false }, world, 120);
    expect(stopped.x).toBe(88);
    expect(stopped.vx).toBe(0);

    const edge = runSteps(body(180, 288, true), { axis: 1, jumpPressed: false }, { ...world, solids: [] }, 120);
    expect(edge.x).toBe(208);
  });

  it('passes upward through a one-way platform and lands on it from above', () => {
    const world = {
      ...emptyWorld(),
      oneWays: [{ x: 100, y: 740, width: 200, height: 16 }],
    };
    const jumped = stepPlayer(body(140, 792, true), { axis: 0, jumpPressed: true }, world);
    const passed = runSteps(jumped, neutral, world, 44);
    expect(passed.y).toBeLessThan(740);
    const landed = runSteps(body(140, 600), neutral, world, 60);
    expect(landed).toMatchObject({ y: 684, vy: 0, grounded: true });
  });

  it('stops at a ceiling and begins falling without passing through it', () => {
    const ceilingWorld: CollisionWorld = {
      bounds: { x: 0, y: 0, width: 500, height: 1200 },
      solids: [
        { x: 0, y: 0, width: 500, height: 200 },
        { x: 0, y: 316, width: 500, height: 884 },
      ],
      oneWays: [],
    };
    let current = body(100, 260, true);
    let minimumY = current.y;
    let impactSeen = false;
    let fallingAfterImpact = false;
    for (let step = 0; step < 20; step += 1) {
      current = stepPlayer(current, { axis: 0, jumpPressed: step === 0 }, ceilingWorld);
      minimumY = Math.min(minimumY, current.y);
      if (current.y === 200) impactSeen = true;
      if (impactSeen && current.y > 200 && current.vy > 0) fallingAfterImpact = true;
    }
    expect(minimumY).toBe(200);
    expect(impactSeen).toBe(true);
    expect(fallingAfterImpact).toBe(true);
  });

  it('caps terminal fall speed and lands without tunneling through the floor', () => {
    const world: CollisionWorld = {
      bounds: { x: 0, y: 0, width: 500, height: 1200 },
      solids: [{ x: 0, y: 848, width: 500, height: 352 }],
      oneWays: [],
    };
    const capped = stepPlayer({ ...body(100, 300), vy: 1200 }, neutral, world);
    expect(capped.vy).toBeLessThan(1200);
    expect(capped.y).toBeLessThan(792);
    const landed = runSteps(capped, neutral, world, 100);
    expect(landed).toMatchObject({ y: 792, grounded: true, vy: 0 });
  });

  it('jumps only from grounded and does not repeat a single press', () => {
    const world = emptyWorld();
    const airborne = stepPlayer(body(100, 500), { axis: 0, jumpPressed: true }, world);
    expect(airborne.vy).toBeGreaterThan(0);
    const jump = stepPlayer(body(100, 792, true), { axis: 0, jumpPressed: true }, world);
    expect(jump.vy).toBeLessThan(0);
    const afterPress = runSteps(jump, neutral, world, 120);
    expect(afterPress).toMatchObject({ y: 792, grounded: true });
  });

  it('applies deceleration and caps horizontal speed', () => {
    const world = emptyWorld();
    const decelerated = stepPlayer({ ...body(100, 792, true), vx: 20 }, neutral, world);
    expect(decelerated.vx).toBeLessThan(20);
    const moving = runSteps(body(100, 792, true), { axis: 1, jumpPressed: false }, world, 600);
    expect(moving.vx).toBeLessThanOrEqual(180);
    expect(moving.vx).toBeGreaterThanOrEqual(0);
  });

  it('clamps restored horizontal velocities to the movement speed cap', () => {
    const world = emptyWorld();
    const movingRight = stepPlayer({ ...body(100, 792, true), vx: 300 }, { axis: 1, jumpPressed: false }, world);
    const movingLeft = stepPlayer({ ...body(1000, 792, true), vx: -300, facing: -1 }, { axis: -1, jumpPressed: false }, world);
    expect(movingRight.vx).toBeLessThanOrEqual(180);
    expect(movingLeft.vx).toBeGreaterThanOrEqual(-180);
  });

  it('produces a known position and capped speed after 60 fixed rightward steps', () => {
    const result = runSteps(body(100, 792, true), { axis: 1, jumpPressed: false }, emptyWorld(), 60);
    expect(result.x).toBeCloseTo(268, 8);
    expect(result.y).toBe(792);
    expect(result.vx).toBe(180);
  });

  it('keeps neutral bodies stationary on flat ground and is deterministic over 1000 steps', () => {
    expect(runSteps(body(100, 792, true), neutral, emptyWorld(), 600).y).toBe(792);
    const inputs = Array.from({ length: 1000 }, (_, index): PlayerInput => ({
      axis: index % 180 < 90 ? 1 : -1,
      jumpPressed: index % 113 === 0,
    }));
    const simulate = (): PlayerBody => inputs.reduce((current, input) => stepPlayer(current, input, emptyWorld()), body(100, 792, true));
    expect(simulate()).toEqual(simulate());
  });
});

describe('level topology', () => {
  it('keeps the world, spawns, and colliders mirrored', () => {
    expect(LEVEL.bounds.width).toBe(18000);
    expect(LEVEL.bounds.height).toBe(960);
    expect(LEVEL.spawns.a.x + LEVEL.spawns.b.x + 32).toBe(LEVEL.bounds.width);
    expect(LEVEL.gifts[0]?.position.x).toBe(4500);
    expect(LEVEL.gifts[1]?.position.x).toBe(13500);
    const left = LEVEL.solids.filter((rect) => rect.x < LEVEL.bounds.width / 2);
    const right = LEVEL.solids.filter((rect) => rect.x > LEVEL.bounds.width / 2);
    expect(left).toHaveLength(right.length);
    for (const rect of left) {
      expect(right).toContainEqual({ ...rect, x: LEVEL.bounds.width - rect.x - rect.width });
    }
  });

  it('keeps the closed gate across the passage and removes it when open', () => {
    const closed = collisionWorld(LEVEL, false);
    const open = collisionWorld(LEVEL, true);
    expect(closed.solids).toContainEqual(LEVEL.gate);
    expect(open.solids).not.toContainEqual(LEVEL.gate);
    let player = spawnBody('a', SHORT_LEVEL);
    const world = collisionWorld(SHORT_LEVEL, false);
    for (let index = 0; index < 600; index += 1) player = stepPlayer(player, { axis: 1, jumpPressed: false }, world);
    expect(player.x + 32).toBeLessThanOrEqual(SHORT_LEVEL.gate.x);
  });

  it('reaches gifts, switches, and finish on a small fixture through real movement', () => {
    expect(SHORT_LEVEL.spawns.a.x + SHORT_LEVEL.spawns.b.x + 32).toBe(SHORT_LEVEL.bounds.width);
    expect(SHORT_LEVEL.oneWays).toEqual([
      { x: 360, y: 240, width: 120, height: 16 },
      { x: 720, y: 240, width: 120, height: 16 },
    ]);
    const closed = collisionWorld(SHORT_LEVEL, false);
    const open = collisionWorld(SHORT_LEVEL, true);
    let playerA = spawnBody('a', SHORT_LEVEL);
    const giftA = SHORT_LEVEL.gifts.find(({ ownerRole }) => ownerRole === 'a');
    const switchA = SHORT_LEVEL.switches.find(({ id }) => id === 'switch-left');
    expect(giftA).toBeDefined();
    expect(switchA).toBeDefined();
    if (!giftA || !switchA) throw new Error('SHORT_LEVEL is missing role a objectives');
    const giftATarget: Rect = { x: giftA.position.x - 32, y: 288, width: 64, height: 56 };
    playerA = moveUntilOverlap(playerA, giftATarget, closed);
    expect(overlaps(playerA, giftATarget)).toBe(true);
    playerA = moveUntilOverlap(playerA, switchA.bounds, closed);
    expect(overlaps(playerA, switchA.bounds)).toBe(true);
    const switchB = SHORT_LEVEL.switches.find(({ id }) => id === 'switch-right');
    expect(switchB).toBeDefined();
    if (!switchB) throw new Error('SHORT_LEVEL is missing switch-right');
    playerA = moveUntilOverlap(playerA, switchB.bounds, open);
    expect(overlaps(playerA, switchB.bounds)).toBe(true);
    expect(playerA.x).toBeGreaterThan(SHORT_LEVEL.gate.x + SHORT_LEVEL.gate.width);
    playerA = moveUntilOverlap(playerA, SHORT_LEVEL.finish, open);
    expect(overlaps(playerA, SHORT_LEVEL.finish)).toBe(true);

    let playerB = spawnBody('b', SHORT_LEVEL);
    const giftB = SHORT_LEVEL.gifts.find(({ ownerRole }) => ownerRole === 'b');
    expect(giftB).toBeDefined();
    if (!giftB) throw new Error('SHORT_LEVEL is missing role b gift');
    const giftBTarget: Rect = { x: giftB.position.x - 32, y: 288, width: 64, height: 56 };
    playerB = moveUntilOverlap(playerB, giftBTarget, closed);
    expect(overlaps(playerB, giftBTarget)).toBe(true);
    playerB = moveUntilOverlap(playerB, switchB.bounds, closed);
    expect(overlaps(playerB, switchB.bounds)).toBe(true);
  });

  it('reaches the main-level gift and switch over hurdles, stays behind a closed gate, then reaches finish after opening it', () => {
    const worldClosed = collisionWorld(LEVEL, false);
    const worldOpen = collisionWorld(LEVEL, true);
    const gift = LEVEL.gifts.find(({ ownerRole }) => ownerRole === 'a');
    const leftSwitch = LEVEL.switches.find(({ id }) => id === 'switch-left');
    const rightSwitch = LEVEL.switches.find(({ id }) => id === 'switch-right');
    expect(gift).toBeDefined();
    expect(leftSwitch).toBeDefined();
    expect(rightSwitch).toBeDefined();
    if (!gift || !leftSwitch || !rightSwitch) throw new Error('LEVEL is missing an objective');

    let player = moveWithinGiftRadius(spawnBody('a', LEVEL), gift.position, worldClosed, LEVEL.solids);
    expect(Math.hypot(player.x + 16 - gift.position.x, player.y + 28 - gift.position.y)).toBeLessThanOrEqual(48);
    player = moveAcrossHurdles(player, leftSwitch.bounds, worldClosed, LEVEL.solids);
    expect(overlaps(player, leftSwitch.bounds)).toBe(true);

    let atGate = spawnBody('a', LEVEL);
    atGate = moveAcrossHurdles(atGate, { x: LEVEL.gate.x - 120, y: LEVEL.groundY - 56, width: 32, height: 56 }, worldClosed, LEVEL.solids);
    for (let step = 0; step < 180; step += 1) atGate = stepPlayer(atGate, { axis: 1, jumpPressed: false }, worldClosed);
    expect(atGate.x + 32).toBeLessThanOrEqual(LEVEL.gate.x);

    player = moveAcrossHurdles(player, rightSwitch.bounds, worldOpen, LEVEL.solids);
    expect(overlaps(player, rightSwitch.bounds)).toBe(true);
    expect(player.x).toBeGreaterThan(LEVEL.gate.x + LEVEL.gate.width);
    player = moveAcrossHurdles(player, LEVEL.finish, worldOpen, LEVEL.solids);
    expect(overlaps(player, LEVEL.finish)).toBe(true);
  });

  it('supports role b reaching its own gift and plate, crossing the open gate, and reaching finish', () => {
    const worldClosed = collisionWorld(LEVEL, false);
    const worldOpen = collisionWorld(LEVEL, true);
    const gift = LEVEL.gifts.find(({ ownerRole }) => ownerRole === 'b');
    const rightSwitch = LEVEL.switches.find(({ id }) => id === 'switch-right');
    const leftSwitch = LEVEL.switches.find(({ id }) => id === 'switch-left');
    expect(gift).toBeDefined();
    expect(rightSwitch).toBeDefined();
    expect(leftSwitch).toBeDefined();
    if (!gift || !rightSwitch || !leftSwitch) throw new Error('LEVEL is missing role b objectives');

    let player = moveWithinGiftRadius(spawnBody('b', LEVEL), gift.position, worldClosed, LEVEL.solids);
    expect(Math.hypot(player.x + 16 - gift.position.x, player.y + 28 - gift.position.y)).toBeLessThanOrEqual(48);
    player = moveAcrossHurdles(player, rightSwitch.bounds, worldClosed, LEVEL.solids);
    expect(overlaps(player, rightSwitch.bounds)).toBe(true);

    let atGate = moveAcrossHurdles(
      spawnBody('b', LEVEL),
      { x: LEVEL.gate.x + LEVEL.gate.width + 88, y: LEVEL.groundY - 56, width: 32, height: 56 },
      worldClosed,
      LEVEL.solids,
    );
    for (let step = 0; step < 180; step += 1) atGate = stepPlayer(atGate, { axis: -1, jumpPressed: false }, worldClosed);
    expect(atGate.x).toBeGreaterThanOrEqual(LEVEL.gate.x + LEVEL.gate.width);

    player = moveAcrossHurdles(player, leftSwitch.bounds, worldOpen, LEVEL.solids);
    expect(overlaps(player, leftSwitch.bounds)).toBe(true);
    expect(player.x + 32).toBeLessThan(LEVEL.gate.x);
    player = moveAcrossHurdles(player, LEVEL.finish, worldOpen, LEVEL.solids);
    expect(overlaps(player, LEVEL.finish)).toBe(true);
  });

  it('jumps through and lands on every production one-way platform from the floor below', () => {
    for (const platform of LEVEL.oneWays) {
      const world: CollisionWorld = {
        bounds: LEVEL.bounds,
        solids: [{
          x: LEVEL.bounds.x,
          y: LEVEL.groundY,
          width: LEVEL.bounds.width,
          height: LEVEL.bounds.y + LEVEL.bounds.height - LEVEL.groundY,
        }],
        oneWays: [platform],
      };
      const x = platform.x + platform.width / 2 - 16;
      let player = body(x, LEVEL.groundY - 56, true);
      player = stepPlayer(player, { axis: 0, jumpPressed: true }, world);
      let passedAbovePlatform = false;
      for (let step = 0; step < 120 && !player.grounded; step += 1) {
        player = stepPlayer(player, neutral, world);
        if (player.y + 56 <= platform.y) passedAbovePlatform = true;
      }
      expect(passedAbovePlatform).toBe(true);
      expect(player).toMatchObject({ y: platform.y - 56, grounded: true, vy: 0 });
    }
  });
});
