import { describe, expect, it } from 'vitest';
import { FinishPresenter, type FinishStage } from './finish-sequence.js';
import { makeSnapshot, localPlayerId, peerPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import type { WorldSnapshot } from '../../shared/model.js';

function completedSnapshot(options: { roomId?: WorldSnapshot['roomId']; epoch?: number; finishStartedAt?: number | null } = {}): WorldSnapshot {
  const snapshot = makeSnapshot({
    ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
  });
  return {
    ...snapshot,
    state: { ...snapshot.state, phase: 'complete', finishStartedAt: options.finishStartedAt === undefined ? 10_000 : options.finishStartedAt },
  };
}

function viewAt(presenter: FinishPresenter, elapsed: number) {
  return presenter.apply(completedSnapshot(), 10_000 + elapsed);
}

describe('FinishPresenter', () => {
  it.each([
    [0, 'approach'],
    [500, 'approach'],
    [999, 'approach'],
    [1000, 'exchange'],
    [1500, 'exchange'],
    [1799, 'exchange'],
    [1800, 'happy'],
    [2500, 'happy'],
    [2999, 'happy'],
    [3000, 'result'],
  ] satisfies readonly [number, FinishStage][])('uses the synchronized finish stage at +%ims', (elapsed, stage) => {
    const presenter = new FinishPresenter();

    expect(viewAt(presenter, elapsed).stage).toBe(stage);
    expect(viewAt(presenter, elapsed).resultsVisible).toBe(elapsed >= 3000);
    presenter.destroy();
  });

  it('requires a real clock sample and finish timestamp before advancing', () => {
    const presenter = new FinishPresenter();

    expect(presenter.apply(completedSnapshot(), null)).toMatchObject({ stage: 'syncing', resultsVisible: false });
    expect(presenter.apply(completedSnapshot({ finishStartedAt: null }), 20_000)).toMatchObject({ stage: 'syncing', resultsVisible: false });
    presenter.destroy();
  });

  it('shows the result immediately when a synchronized reconnect clock is already past the finish', () => {
    const presenter = new FinishPresenter();

    expect(presenter.apply(completedSnapshot(), 14_000)).toMatchObject({ stage: 'result', resultsVisible: true });
    presenter.destroy();
  });

  it('keeps the original start across duplicate completion snapshots', () => {
    const presenter = new FinishPresenter();
    const first = completedSnapshot();
    const duplicate = { ...first, tick: first.tick + 1, revision: first.revision + 1 };

    expect(presenter.apply(first, 11_500).stage).toBe('exchange');
    expect(presenter.apply(duplicate, 11_500).stage).toBe('exchange');
    expect(presenter.apply(duplicate, 13_000).resultsVisible).toBe(true);
    presenter.destroy();
  });

  it('clears presentation when the room epoch changes or the phase leaves complete', () => {
    const presenter = new FinishPresenter();
    expect(presenter.apply(completedSnapshot(), 13_000).resultsVisible).toBe(true);

    const nextEpoch = completedSnapshot({ epoch: 2, finishStartedAt: 20_000 });
    expect(presenter.apply(nextEpoch, 20_500).stage).toBe('approach');
    expect(presenter.apply(makeSnapshot({ epoch: 3 }), 30_000)).toMatchObject({ stage: 'inactive', resultsVisible: false });
    presenter.destroy();
  });

  it('resets explicitly and produces presentation positions without mutating server bodies', () => {
    const presenter = new FinishPresenter();
    const snapshot = completedSnapshot();
    const original = structuredClone(snapshot.state.players.map(({ body }) => body));
    const view = presenter.apply(snapshot, 10_500);
    const first = view.players.get(localPlayerId);
    const second = view.players.get(peerPlayerId);

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.x).toBeGreaterThan(snapshot.state.players[0]!.body.x);
    expect(second?.x).toBeLessThan(snapshot.state.players[1]!.body.x);
    expect((second?.x ?? 0) - (first?.x ?? 0)).toBeLessThan(
      snapshot.state.players[1]!.body.x - snapshot.state.players[0]!.body.x,
    );
    expect(first?.facing).toBe(1);
    expect(second?.facing).toBe(-1);
    expect(snapshot.state.players.map(({ body }) => body)).toEqual(original);

    presenter.reset();
    expect(presenter.apply(makeSnapshot(), 10_500)).toMatchObject({ stage: 'inactive', resultsVisible: false });
    presenter.destroy();
  });
});
