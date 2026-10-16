import { describe, expect, it } from 'vitest';
import { LEVEL } from './level.js';

describe('LEVEL', () => {
  it('defines the shared dimensions, safe spawns, and mirrored objective positions', () => {
    expect(LEVEL.bounds).toEqual({ x: 0, y: 0, width: 18000, height: 960 });
    expect(LEVEL.groundY).toBe(848);
    expect(LEVEL.spawns.a).toEqual({ x: 64, y: 792 });
    expect(LEVEL.spawns.b).toEqual({ x: 17904, y: 792 });
    expect(LEVEL.gate).toEqual({ x: 8990, y: 0, width: 20, height: 848 });
    expect(LEVEL.finish).toEqual({ x: 8840, y: 760, width: 320, height: 88 });
  });

  it('places each role’s personal gift and a reachable switch on its side', () => {
    expect(LEVEL.gifts).toEqual([
      { id: 'gift-a', ownerRole: 'a', position: { x: 4500, y: 816 } },
      { id: 'gift-b', ownerRole: 'b', position: { x: 13500, y: 816 } },
    ]);
    expect(LEVEL.switches.map(({ id }) => id)).toEqual(['switch-left', 'switch-right']);
    expect(LEVEL.oneWays.every((platform) => platform.y === 740)).toBe(true);
  });
});
