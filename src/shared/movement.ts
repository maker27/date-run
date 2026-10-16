import type { PlayerBody, PlayerInput, Rect, Role } from './model.js';
import type { LevelDefinition } from './level.js';
import { STEP_SECONDS } from './timing.js';
import {
  ACCELERATION,
  DECELERATION,
  GRAVITY,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
} from './simulation-config.js';

export interface CollisionWorld {
  bounds: Rect;
  solids: readonly Rect[];
  oneWays: readonly Rect[];
}

export function collisionWorld(level: LevelDefinition, gateOpen: boolean): CollisionWorld {
  const floor = {
    x: level.bounds.x,
    y: level.groundY,
    width: level.bounds.width,
    height: level.bounds.y + level.bounds.height - level.groundY,
  };
  return {
    bounds: level.bounds,
    solids: gateOpen ? [floor, ...level.solids] : [floor, ...level.solids, level.gate],
    oneWays: level.oneWays,
  };
}

export function spawnBody(role: Role, level: LevelDefinition): PlayerBody {
  return { ...level.spawns[role], vx: 0, vy: 0, grounded: true, facing: role === 'a' ? 1 : -1 };
}

export function stepPlayer(body: PlayerBody, input: PlayerInput, world: CollisionWorld): PlayerBody {
  const targetVx = input.axis * MOVE_SPEED;
  const rate = input.axis === 0 ? DECELERATION : ACCELERATION;
  const currentVx = Math.max(-MOVE_SPEED, Math.min(body.vx, MOVE_SPEED));
  const vx = currentVx < targetVx
    ? Math.min(currentVx + rate * STEP_SECONDS, targetVx)
    : Math.max(currentVx - rate * STEP_SECONDS, targetVx);
  let vy = input.jumpPressed && body.grounded ? -JUMP_SPEED : body.vy;
  vy = Math.min(vy + GRAVITY * STEP_SECONDS, MAX_FALL_SPEED);

  let x = Math.max(world.bounds.x, Math.min(body.x + vx * STEP_SECONDS, world.bounds.x + world.bounds.width - PLAYER_WIDTH));
  let resolvedVx = x === body.x + vx * STEP_SECONDS ? vx : 0;
  for (const solid of world.solids) {
    if (body.y >= solid.y + solid.height || body.y + PLAYER_HEIGHT <= solid.y) continue;
    if (vx > 0 && body.x + PLAYER_WIDTH <= solid.x && x + PLAYER_WIDTH >= solid.x) {
      x = Math.min(x, solid.x - PLAYER_WIDTH);
      resolvedVx = 0;
    } else if (vx < 0 && body.x >= solid.x + solid.width && x <= solid.x + solid.width) {
      x = Math.max(x, solid.x + solid.width);
      resolvedVx = 0;
    }
  }

  let y = Math.max(world.bounds.y, Math.min(body.y + vy * STEP_SECONDS, world.bounds.y + world.bounds.height - PLAYER_HEIGHT));
  let resolvedVy = y === body.y + vy * STEP_SECONDS ? vy : 0;
  let grounded = false;
  for (const solid of world.solids) {
    if (x + PLAYER_WIDTH <= solid.x || x >= solid.x + solid.width) continue;
    if (vy >= 0 && body.y + PLAYER_HEIGHT <= solid.y && y + PLAYER_HEIGHT >= solid.y) {
      y = Math.min(y, solid.y - PLAYER_HEIGHT);
      resolvedVy = 0;
      grounded = true;
    } else if (vy < 0 && body.y >= solid.y + solid.height && y <= solid.y + solid.height) {
      y = Math.max(y, solid.y + solid.height);
      resolvedVy = 0;
    }
  }
  if (vy >= 0) {
    for (const platform of world.oneWays) {
      if (x + PLAYER_WIDTH <= platform.x || x >= platform.x + platform.width) continue;
      if (body.y + PLAYER_HEIGHT <= platform.y && y + PLAYER_HEIGHT >= platform.y) {
        y = Math.min(y, platform.y - PLAYER_HEIGHT);
        resolvedVy = 0;
        grounded = true;
      }
    }
  }

  return {
    x,
    y,
    vx: resolvedVx,
    vy: resolvedVy,
    grounded,
    facing: input.axis === 0 ? body.facing : input.axis,
  };
}
