import { describe, expect, it } from 'vitest';
import type { PlayerBody } from '../../shared/model.js';
import { makeSnapshot, localPlayerId, peerPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import { SnapshotBuffer } from './snapshot-buffer.js';

describe('SnapshotBuffer', () => {
  it('interpolates continuous body values and keeps discrete values from the earlier sample', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    buffer.push(makeSnapshot({ tick: 1, serverTime: 100, localBody: { x: 10, y: 20, vx: 2, vy: 4, grounded: true, facing: 1 } }));
    buffer.push(makeSnapshot({ tick: 2, serverTime: 200, localBody: { x: 30, y: 40, vx: 6, vy: 8, grounded: false, facing: -1 } }));

    const rendered = buffer.sample(150);
    expect(rendered).not.toBeNull();
    expect(rendered).toEqual({
      roomId: 'ABCD2345',
      epoch: 1,
      players: new Map([[localPlayerId, { x: 20, y: 30, vx: 4, vy: 6, grounded: true, facing: 1 }], [peerPlayerId, { x: 17904, y: 792, vx: 0, vy: 0, grounded: true, facing: -1 }]]),
    });
  });

  it('clamps before the oldest and after the newest sample without extrapolation', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    const firstBody: PlayerBody = { x: 10, y: 20, vx: 2, vy: 4, grounded: true, facing: 1 };
    const secondBody: PlayerBody = { x: 30, y: 40, vx: 6, vy: 8, grounded: false, facing: -1 };
    buffer.push(makeSnapshot({ tick: 1, serverTime: 100, localBody: firstBody }));
    buffer.push(makeSnapshot({ tick: 2, serverTime: 200, localBody: secondBody }));

    expect(buffer.sample(0)?.players.get(localPlayerId)).toEqual(firstBody);
    expect(buffer.sample(300)?.players.get(localPlayerId)).toEqual(secondBody);
  });

  it('selects the newest tick at equal server times on and after the catch-up boundary', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    buffer.push(makeSnapshot({ tick: 1, serverTime: 100, localBody: { x: 10, y: 20, vx: 0, vy: 0, grounded: true, facing: 1 } }));
    buffer.push(makeSnapshot({ tick: 2, serverTime: 100, localBody: { x: 20, y: 20, vx: 0, vy: 0, grounded: true, facing: 1 } }));

    expect(buffer.sample(100)?.players.get(localPlayerId)?.x).toBe(20);
    expect(buffer.sample(100.01)?.players.get(localPlayerId)?.x).toBe(20);
  });

  it('selects the newest tick inside a group of equal server times', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    buffer.push(makeSnapshot({ tick: 1, serverTime: 100, localBody: { x: 10, y: 20, vx: 0, vy: 0, grounded: true, facing: 1 } }));
    buffer.push(makeSnapshot({ tick: 2, serverTime: 100, localBody: { x: 20, y: 20, vx: 0, vy: 0, grounded: true, facing: 1 } }));
    buffer.push(makeSnapshot({ tick: 3, serverTime: 200, localBody: { x: 40, y: 20, vx: 0, vy: 0, grounded: true, facing: 1 } }));

    expect(buffer.sample(100)?.players.get(localPlayerId)?.x).toBe(20);
    expect(buffer.sample(100.01)?.players.get(localPlayerId)?.x).toBeGreaterThan(20);
  });

  it('rejects stale tick or revision, accepts newer tick at equal revision, and replaces same tick with newer revision', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    expect(buffer.push(makeSnapshot({ tick: 4, revision: 3, serverTime: 200 }))).toBe(true);
    expect(buffer.push(makeSnapshot({ tick: 5, revision: 3, serverTime: 250 }))).toBe(true);
    expect(buffer.push(makeSnapshot({ tick: 4, revision: 4, serverTime: 260 }))).toBe(false);
    expect(buffer.push(makeSnapshot({ tick: 5, revision: 2, serverTime: 270 }))).toBe(false);
    expect(buffer.push(makeSnapshot({ tick: 5, revision: 3, serverTime: 280 }))).toBe(false);
    expect(buffer.push(makeSnapshot({ tick: 5, revision: 4, serverTime: 300, localBody: { x: 500, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 } }))).toBe(true);

    expect(buffer.length).toBe(2);
    expect(buffer.sample(300)?.players.get(localPlayerId)?.x).toBe(500);
  });

  it('requires explicit reset to change room or epoch and resets ordering on control', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    expect(buffer.push(makeSnapshot({ tick: 3, serverTime: 150 }))).toBe(true);
    expect(buffer.push(makeSnapshot({ epoch: 2, tick: 1, serverTime: 200 }))).toBe(false);
    expect(buffer.push(makeSnapshot({ roomId: 'BCDE3456', epoch: 1, tick: 1, serverTime: 200 }))).toBe(false);

    buffer.reset({ roomId: 'ABCD2345', epoch: 2 });
    expect(buffer.length).toBe(0);
    expect(buffer.push(makeSnapshot({ epoch: 2, tick: 0, serverTime: 10 }))).toBe(true);
  });

  it('keeps at most 32 samples after 10000 pushes and trims history older than 1000ms', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    for (let tick = 1; tick <= 10000; tick += 1) {
      expect(buffer.push(makeSnapshot({ tick, serverTime: tick }))).toBe(true);
    }
    expect(buffer.length).toBeLessThanOrEqual(32);

    buffer.reset({ roomId: 'ABCD2345', epoch: 1 });
    for (let tick = 0; tick <= 12; tick += 1) {
      buffer.push(makeSnapshot({ tick, serverTime: tick * 100 }));
    }
    expect(buffer.length).toBe(11);
  });

  it('rejects decreasing server timestamps and clones render bodies', () => {
    const buffer = new SnapshotBuffer({ roomId: 'ABCD2345', epoch: 1 });
    const sourceBody: PlayerBody = { x: 10, y: 20, vx: 2, vy: 4, grounded: true, facing: 1 };
    buffer.push(makeSnapshot({ tick: 1, serverTime: 100, localBody: sourceBody }));
    expect(buffer.push(makeSnapshot({ tick: 2, serverTime: 99 }))).toBe(false);
    const rendered = buffer.sample(100);
    expect(rendered?.players.get(localPlayerId)).not.toBe(sourceBody);
    expect(rendered).not.toHaveProperty('state');
    expect(rendered).not.toHaveProperty('tick');
  });
});
