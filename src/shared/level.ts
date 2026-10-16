import type { ObjectId, Rect, Role, Vec2 } from './model.js';

export interface GiftDefinition {
  id: ObjectId;
  ownerRole: Role;
  position: Vec2;
}

export interface SwitchDefinition {
  id: ObjectId;
  bounds: Rect;
}

export interface LevelDefinition {
  bounds: Rect;
  groundY: number;
  solids: readonly Rect[];
  oneWays: readonly Rect[];
  spawns: Readonly<Record<Role, Vec2>>;
  gate: Rect;
  finish: Rect;
  gifts: readonly GiftDefinition[];
  switches: readonly SwitchDefinition[];
}

const hurdleXs = [1200, 2600, 3900, 5300, 6700, 8100];
const platformXs = [1800, 4600, 7400];
const worldWidth = 18000;

export const LEVEL: LevelDefinition = {
  bounds: { x: 0, y: 0, width: 18000, height: 960 },
  groundY: 848,
  solids: [
    ...hurdleXs.map((x) => ({ x, y: 776, width: 80, height: 72 })),
    ...hurdleXs.map((x) => ({ x: worldWidth - x - 80, y: 776, width: 80, height: 72 })),
  ],
  oneWays: [
    ...platformXs.map((x) => ({ x, y: 740, width: 240, height: 16 })),
    ...platformXs.map((x) => ({ x: worldWidth - x - 240, y: 740, width: 240, height: 16 })),
  ],
  spawns: { a: { x: 64, y: 792 }, b: { x: 17904, y: 792 } },
  gate: { x: 8990, y: 0, width: 20, height: 848 },
  finish: { x: 8840, y: 760, width: 320, height: 88 },
  gifts: [
    { id: 'gift-a', ownerRole: 'a', position: { x: 4500, y: 816 } },
    { id: 'gift-b', ownerRole: 'b', position: { x: 13500, y: 816 } },
  ],
  switches: [
    { id: 'switch-left', bounds: { x: 8792, y: 840, width: 32, height: 8 } },
    { id: 'switch-right', bounds: { x: 9176, y: 840, width: 32, height: 8 } },
  ],
};
