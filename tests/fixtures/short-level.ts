import type { LevelDefinition } from '../../src/shared/level.js';

export const SHORT_LEVEL = {
  bounds: { x: 0, y: 0, width: 1200, height: 400 },
  groundY: 344,
  solids: [],
  oneWays: [
    { x: 360, y: 240, width: 120, height: 16 },
    { x: 720, y: 240, width: 120, height: 16 },
  ],
  spawns: { a: { x: 32, y: 288 }, b: { x: 1136, y: 288 } },
  gate: { x: 590, y: 0, width: 20, height: 344 },
  finish: { x: 548, y: 288, width: 104, height: 56 },
  gifts: [
    { id: 'gift-a', ownerRole: 'a', position: { x: 220, y: 316 } },
    { id: 'gift-b', ownerRole: 'b', position: { x: 980, y: 316 } },
  ],
  switches: [
    { id: 'switch-left', bounds: { x: 496, y: 336, width: 32, height: 8 } },
    { id: 'switch-right', bounds: { x: 672, y: 336, width: 32, height: 8 } },
  ],
} satisfies LevelDefinition;
