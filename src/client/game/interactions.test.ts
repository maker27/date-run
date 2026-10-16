import { describe, expect, it } from 'vitest';
import { makeSnapshot, localPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import { SHORT_LEVEL } from '../../../tests/fixtures/short-level.js';
import { findOwnInteractable } from './interactions.js';

describe('findOwnInteractable', () => {
  it('offers only the uncollected gift owned by the local player within 48 units', () => {
    const snapshot = makeSnapshot({ localBody: { x: 4436, y: 788, vx: 0, vy: 0, grounded: true, facing: 1 } });

    expect(findOwnInteractable(snapshot, localPlayerId)).toBe('gift-a');
    expect(findOwnInteractable(makeSnapshot({ localBody: { x: 4435.99, y: 788, vx: 0, vy: 0, grounded: true, facing: 1 } }), localPlayerId)).toBeNull();
  });

  it('does not hint a foreign gift, even when the local player is beside it', () => {
    const snapshot = makeSnapshot({ localBody: { x: 13500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });

    expect(findOwnInteractable(snapshot, localPlayerId)).toBeNull();
  });

  it('returns null when the own gift is already collected', () => {
    const snapshot = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    snapshot.state.gifts[0]!.collectedBy = localPlayerId;

    expect(findOwnInteractable(snapshot, localPlayerId)).toBeNull();
  });

  it('uses the supplied short level rather than production gift coordinates', () => {
    const snapshot = makeSnapshot({ localBody: { x: 220, y: 316, vx: 0, vy: 0, grounded: true, facing: 1 } });

    expect(findOwnInteractable(snapshot, localPlayerId, SHORT_LEVEL)).toBe('gift-a');
    expect(findOwnInteractable(snapshot, localPlayerId)).toBeNull();
  });

  it.each([
    ['paused', { phase: 'playing' as const, paused: true }],
    ['lobby', { phase: 'lobby' as const, paused: false }],
    ['complete', { phase: 'complete' as const, paused: false }],
  ])('returns null when the room is %s', (_name, state) => {
    const snapshot = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    snapshot.state.phase = state.phase;
    snapshot.state.paused = state.paused;

    expect(findOwnInteractable(snapshot, localPlayerId)).toBeNull();
  });
});
