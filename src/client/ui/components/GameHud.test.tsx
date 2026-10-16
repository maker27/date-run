import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import { localPlayerId, makeSnapshot } from '../../../../tests/fixtures/world-snapshot.js';
import { projectUi } from '../../application/ui-summary.js';
import { GameHud, gameInstruction } from './GameHud.js';

afterEach(cleanup);

const summary = projectUi(makeSnapshot(), localPlayerId, {
  connection: 'connected', loading: false, error: null, storageWarning: false,
  closing: null, sceneReady: true, resultsVisible: false,
});

it('explains collection, simultaneous plates and automatic exchange in order', () => {
  expect(gameInstruction(summary)).toContain('Заберите свой подарок');
  expect(gameInstruction({ ...summary, ownGift: true })).toContain('партнёра');
  expect(gameInstruction({ ...summary, ownGift: true, partnerGift: true })).toContain('одновременно');
  expect(gameInstruction({ ...summary, gateOpen: true })).toContain('автоматически');
  expect(gameInstruction({ ...summary, phase: 'complete' })).toBe('Обмениваемся подарками…');
  expect(gameInstruction({ ...summary, paused: true })).toContain('Пауза');
});

it('shows which of the two plates is occupied', () => {
  const snapshot = makeSnapshot();
  snapshot.state.switches[0] = { id: 'switch-left', occupant: localPlayerId };
  const projected = projectUi(snapshot, localPlayerId, {
    connection: 'connected', loading: false, error: null, storageWarning: false,
    closing: null, sceneReady: true, resultsVisible: false,
  });
  render(<GameHud summary={projected} />);
  expect(screen.getByText('Площадки: 1 из 2')).toBeDefined();
});
