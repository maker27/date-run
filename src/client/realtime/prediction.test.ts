import { describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import type { PlayerBody, PlayerInput } from '../../shared/model.js';
import { collisionWorld, stepPlayer } from '../../shared/movement.js';
import { makeSnapshot, localPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import { Prediction } from './prediction.js';

const startBody: PlayerBody = { x: 100, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 };

describe('Prediction', () => {
  it('reconciles to the authoritative body and replays only unprocessed inputs through the shared solver', () => {
    const prediction = new Prediction();
    const inputs: PlayerInput[] = [
      { axis: 0, jumpPressed: true },
      { axis: 1, jumpPressed: false },
      { axis: 0, jumpPressed: false },
    ];
    prediction.reset(startBody, 1);
    prediction.reconcile(makeSnapshot({ localBody: startBody, localGeneration: 1 }), localPlayerId);
    inputs.forEach((input, index) => prediction.predict(index + 1, input));

    const authoritativeBody = stepPlayer(startBody, { axis: 0, jumpPressed: true }, collisionWorld(LEVEL, false));
    const expectedBody = inputs.slice(1).reduce(
      (body, input) => stepPlayer(body, input, collisionWorld(LEVEL, false)),
      authoritativeBody,
    );
    const reconciled = prediction.reconcile(makeSnapshot({
      tick: 2,
      serverTime: 100,
      localBody: authoritativeBody,
      localGeneration: 1,
      lastAcceptedSeq: 3,
      lastProcessedSeq: 1,
    }), localPlayerId);

    expect(reconciled).toEqual(expectedBody);
    expect(prediction.pendingCount).toBe(2);
  });

  it('keeps accepted but unprocessed input pending until its processed ACK arrives', () => {
    const prediction = new Prediction();
    prediction.reset(startBody, 1);
    prediction.reconcile(makeSnapshot({ localBody: startBody, localGeneration: 1 }), localPlayerId);
    prediction.predict(1, { axis: 1, jumpPressed: false });

    const acceptedOnly = prediction.reconcile(makeSnapshot({
      tick: 2,
      serverTime: 100,
      localBody: startBody,
      localGeneration: 1,
      lastAcceptedSeq: 1,
      lastProcessedSeq: 0,
    }), localPlayerId);
    const expected = stepPlayer(startBody, { axis: 1, jumpPressed: false }, collisionWorld(LEVEL, false));

    expect(acceptedOnly).toEqual(expected);
    expect(prediction.pendingCount).toBe(1);
  });

  it('cancels pending commands when generation or epoch changes', () => {
    const prediction = new Prediction();
    prediction.reset(startBody, 1);
    prediction.reconcile(makeSnapshot({ localBody: startBody, localGeneration: 1 }), localPlayerId);
    prediction.predict(1, { axis: 1, jumpPressed: true });
    prediction.predict(2, { axis: 1, jumpPressed: false });

    const generationResetBody: PlayerBody = { x: 600, y: 792, vx: 0, vy: 0, grounded: true, facing: -1 };
    expect(prediction.reconcile(makeSnapshot({
      tick: 2,
      serverTime: 100,
      localBody: generationResetBody,
      localGeneration: 2,
      lastAcceptedSeq: 2,
      lastProcessedSeq: 0,
    }), localPlayerId)).toEqual(generationResetBody);
    expect(prediction.pendingCount).toBe(0);

    prediction.predict(3, { axis: -1, jumpPressed: false });
    const epochResetBody: PlayerBody = { x: 900, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 };
    expect(prediction.reconcile(makeSnapshot({
      epoch: 2,
      tick: 0,
      serverTime: 0,
      localBody: epochResetBody,
      localGeneration: 2,
      lastAcceptedSeq: 2,
      lastProcessedSeq: 0,
    }), localPlayerId)).toEqual(epochResetBody);
    expect(prediction.pendingCount).toBe(0);
  });

  it('replays pending movement with the latest authoritative gate state', () => {
    const gateBody: PlayerBody = { x: 8958, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 };
    const prediction = new Prediction();
    prediction.reset(gateBody, 1);
    prediction.reconcile(makeSnapshot({ localBody: gateBody, localGeneration: 1, gateOpen: false }), localPlayerId);
    prediction.predict(1, { axis: 1, jumpPressed: false });

    const openedGateBody = prediction.reconcile(makeSnapshot({
      tick: 2,
      serverTime: 100,
      localBody: gateBody,
      localGeneration: 1,
      gateOpen: true,
    }), localPlayerId);
    expect(openedGateBody).toEqual(stepPlayer(gateBody, { axis: 1, jumpPressed: false }, collisionWorld(LEVEL, true)));
    expect(openedGateBody.x).toBeGreaterThan(gateBody.x);
  });

  it('requests one resync at 120 pending inputs and never appends the 121st', () => {
    const onResync = vi.fn();
    const prediction = new Prediction(LEVEL, onResync);
    prediction.reset(startBody, 1);
    prediction.reconcile(makeSnapshot({ localBody: startBody, localGeneration: 1 }), localPlayerId);
    const neutral: PlayerInput = { axis: 0, jumpPressed: false };
    for (let seq = 1; seq <= 120; seq += 1) prediction.predict(seq, neutral);

    const bodyAtCapacity = prediction.body;
    expect(prediction.pendingCount).toBe(120);
    expect(prediction.predict(121, { axis: 1, jumpPressed: false })).toEqual(bodyAtCapacity);
    expect(prediction.pendingCount).toBe(120);
    expect(onResync).toHaveBeenCalledTimes(1);
    prediction.predict(122, neutral);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('rejects a reconcile snapshot without the local player', () => {
    const prediction = new Prediction();
    const snapshot = makeSnapshot();
    const withoutLocal = { ...snapshot, state: { ...snapshot.state, players: snapshot.state.players.slice(1) } };

    expect(() => prediction.reconcile(withoutLocal, localPlayerId)).toThrow();
  });
});
