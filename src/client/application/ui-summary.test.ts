import { describe, expect, it } from 'vitest';
import { projectUi, sameUiSummary, type UiContext } from './ui-summary.js';
import { makeSnapshot } from '../../../tests/fixtures/world-snapshot.js';

const context: UiContext = {
  connection: 'connected',
  loading: false,
  error: null,
  storageWarning: false,
  closing: null,
  sceneReady: false,
  resultsVisible: false,
};

describe('projectUi', () => {
  it('projects public room state without exposing credentials or simulation details', () => {
    const snapshot = makeSnapshot({ localGeneration: 8, lastAcceptedSeq: 12, lastProcessedSeq: 9 });
    const summary = projectUi(snapshot, '00000000-0000-4000-8000-000000000001', context);

    expect(summary).toMatchObject({
      screen: 'game',
      roomId: 'ABCD2345',
      phase: 'playing',
      connection: 'connected',
      selectedTheme: 'first-date',
      ownRole: 'a',
      isHost: true,
      ownGift: false,
      partnerGift: false,
      gateOpen: false,
      paused: false,
      loading: false,
      error: null,
      storageWarning: false,
      closing: null,
      sceneReady: false,
    });
    expect(summary.players).toEqual([
      { role: 'a', connected: true, ready: false, rematch: false },
      { role: 'b', connected: true, ready: false, rematch: false },
    ]);
    expect(Object.keys(summary).join(' ')).not.toMatch(/body|tick|revision|generation|seq|token|credential/i);
    expect(JSON.stringify(summary)).not.toMatch(/00000000-0000-4000-8000-000000000001/);
  });

  it('shows landing with the default theme when there is no session snapshot', () => {
    expect(projectUi(null, null, context)).toMatchObject({
      screen: 'landing',
      roomId: null,
      phase: null,
      selectedTheme: 'first-date',
      ownRole: null,
      players: [],
    });
  });

  it('keeps the shared game screen until the finish presentation reveals results', () => {
    const snapshot = makeSnapshot();
    const complete = { ...snapshot, state: { ...snapshot.state, phase: 'complete' as const, finishStartedAt: 10_000 } };
    const finishing = projectUi(complete, '00000000-0000-4000-8000-000000000001', context);
    const results = projectUi(complete, '00000000-0000-4000-8000-000000000001', { ...context, resultsVisible: true });

    expect(finishing).toMatchObject({ screen: 'game', phase: 'complete', resultsVisible: false });
    expect(results).toMatchObject({ screen: 'result', phase: 'complete', resultsVisible: true });
    expect(results).not.toHaveProperty('x');
    expect(results).not.toHaveProperty('y');
  });

  it('does not change the public projection when only simulation fields change', () => {
    const first = makeSnapshot({ tick: 10, revision: 1, localBody: { x: 100, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 } });
    const moved = makeSnapshot({ tick: 11, revision: 2, localBody: { x: 120, y: 792, vx: 180, vy: 0, grounded: true, facing: 1 }, localGeneration: 4, lastAcceptedSeq: 40 });

    expect(sameUiSummary(
      projectUi(first, '00000000-0000-4000-8000-000000000001', context),
      projectUi(moved, '00000000-0000-4000-8000-000000000001', context),
    )).toBe(true);
  });

  it('detects every public goal change', () => {
    const first = projectUi(makeSnapshot(), '00000000-0000-4000-8000-000000000001', context);
    const changed = makeSnapshot({ gateOpen: true });

    expect(sameUiSummary(first, projectUi(changed, '00000000-0000-4000-8000-000000000001', context))).toBe(false);
  });

  it('detects scene readiness changes without exposing scene internals', () => {
    const loading = projectUi(makeSnapshot(), '00000000-0000-4000-8000-000000000001', context);
    const ready = { ...loading, sceneReady: true };

    expect(sameUiSummary(loading, ready)).toBe(false);
    expect(ready).not.toHaveProperty('x');
    expect(ready).not.toHaveProperty('y');
    expect(ready).not.toHaveProperty('body');
    expect(ready).not.toHaveProperty('tick');
  });

  it('treats result visibility as a public projection change', () => {
    const hidden = projectUi(makeSnapshot(), '00000000-0000-4000-8000-000000000001', context);
    const visible = { ...hidden, resultsVisible: true };

    expect(sameUiSummary(hidden, visible)).toBe(false);
  });
});
