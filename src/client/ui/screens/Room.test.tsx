import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { makeSnapshot, localPlayerId } from '../../../../tests/fixtures/world-snapshot.js';
import { projectUi } from '../../application/ui-summary.js';
import { appUrls } from '../../platform/app-urls.js';
import { Room } from './Room.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const context = {
  connection: 'connected' as const,
  loading: false,
  error: null,
  storageWarning: false,
  closing: null,
  sceneReady: true,
  resultsVisible: false,
};

describe('Room', () => {
  it('attaches the scene once and preserves its canvas while summary state changes', async () => {
    const session = {
      preview: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      setReady: vi.fn().mockResolvedValue(undefined),
      attachScene: vi.fn().mockResolvedValue(undefined),
      detachScene: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn().mockResolvedValue(undefined),
      backToLobby: vi.fn().mockResolvedValue(undefined),
    };
    const first = makeSnapshot();
    const firstSummary = projectUi(first, localPlayerId, context);
    const view = render(<Room session={session} summary={firstSummary} onRetryGraphics={() => undefined} />);
    const canvas = screen.getByRole('img', { name: 'Игровой мир Date Run' });

    expect(session.attachScene).toHaveBeenCalledTimes(1);
    const changed = { ...first, state: { ...first.state, paused: true } };
    view.rerender(<Room session={session} summary={projectUi(changed, localPlayerId, context)} onRetryGraphics={() => undefined} />);

    expect(screen.getByRole('img', { name: 'Игровой мир Date Run' })).toBe(canvas);
    expect(session.attachScene).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: 'Игра' })).toBeDefined();
    view.unmount();
    expect(session.detachScene).toHaveBeenCalledTimes(1);
  });

  it('uses the current host and the deployed invite path in the lobby', () => {
    const session = {
      preview: vi.fn(), create: vi.fn(), join: vi.fn(), configure: vi.fn(), setReady: vi.fn(),
      attachScene: vi.fn().mockResolvedValue(undefined), detachScene: vi.fn(), leave: vi.fn(), retry: vi.fn(),
      rematch: vi.fn(), backToLobby: vi.fn(),
    };
    const snapshot = makeSnapshot();
    const lobby = { ...snapshot, state: { ...snapshot.state, phase: 'lobby' as const } };
    render(<Room session={session} summary={projectUi(lobby, localPlayerId, context)} onRetryGraphics={() => undefined} />);

    expect(screen.getByRole('textbox', { name: 'Ссылка-приглашение' })).toHaveProperty('value', appUrls(location.origin).invite(lobby.roomId));
  });

  it('does not expose world coordinates in the room HUD', () => {
    const session = {
      preview: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      setReady: vi.fn().mockResolvedValue(undefined),
      attachScene: vi.fn().mockResolvedValue(undefined),
      detachScene: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn().mockResolvedValue(undefined),
      backToLobby: vi.fn().mockResolvedValue(undefined),
    };
    const snapshot = makeSnapshot();
    const summary = projectUi(snapshot, localPlayerId, context);
    const { container } = render(<Room session={session} summary={summary} onRetryGraphics={() => undefined} />);

    expect(container.textContent).not.toMatch(/x\s*[:=]\s*\d+|y\s*[:=]\s*\d+/i);
  });

  it('shows both rematch votes and sends the result actions to the session', async () => {
    const session = {
      preview: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      setReady: vi.fn().mockResolvedValue(undefined),
      attachScene: vi.fn().mockResolvedValue(undefined),
      detachScene: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn().mockResolvedValue(undefined),
      backToLobby: vi.fn().mockResolvedValue(undefined),
    };
    const snapshot = makeSnapshot();
    const complete = {
      ...snapshot,
      state: {
        ...snapshot.state,
        phase: 'complete' as const,
        players: snapshot.state.players.map((player) => ({ ...player, rematch: player.role === 'b' })),
      },
    };
    render(<Room session={session} summary={projectUi(complete, localPlayerId, { ...context, resultsVisible: true })} onRetryGraphics={() => undefined} />);

    expect(screen.getByText('Сыграть снова')).toBeDefined();
    expect(screen.getByText('Игрок A: ожидает')).toBeDefined();
    expect(screen.getByText('Игрок B: готов')).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Сыграть снова' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /в лобби/i })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /выйти/i })); });

    expect(session.rematch).toHaveBeenCalledOnce();
    expect(session.backToLobby).toHaveBeenCalledOnce();
    expect(session.leave).toHaveBeenCalledOnce();
  });

  it('presents connection, storage and graphics recovery state without exposing raw errors', async () => {
    const session = {
      preview: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      setReady: vi.fn().mockResolvedValue(undefined),
      attachScene: vi.fn().mockResolvedValue(undefined),
      detachScene: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn().mockResolvedValue(undefined),
      backToLobby: vi.fn().mockResolvedValue(undefined),
    };
    const snapshot = makeSnapshot();
    const context = {
      connection: 'reconnecting' as const,
      loading: false,
      error: 'graphics_error' as const,
      storageWarning: true,
      closing: 'restart' as const,
      sceneReady: false,
      resultsVisible: false,
    };
    const onRetryGraphics = vi.fn();
    render(<Room session={session} summary={projectUi(snapshot, localPlayerId, context)} onRetryGraphics={onRetryGraphics} />);

    expect(screen.getByText(/соедин/i)).toBeDefined();
    expect(screen.getByText(/место|данные|сохран/i)).toBeDefined();
    expect(screen.getByRole('alert').textContent).not.toMatch(/graphics_error|Error/i);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Повторить' })); });
    expect(onRetryGraphics).toHaveBeenCalledOnce();
  });

  it('lets a replaced session leave without offering a reconnect retry', () => {
    const session = {
      preview: vi.fn(),
      create: vi.fn().mockResolvedValue(undefined),
      join: vi.fn().mockResolvedValue(undefined),
      configure: vi.fn().mockResolvedValue(undefined),
      setReady: vi.fn().mockResolvedValue(undefined),
      attachScene: vi.fn().mockResolvedValue(undefined),
      detachScene: vi.fn(),
      leave: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn().mockResolvedValue(undefined),
      backToLobby: vi.fn().mockResolvedValue(undefined),
    };
    const context = {
      connection: 'closed' as const,
      loading: false,
      error: 'session_replaced' as const,
      storageWarning: false,
      closing: null,
      sceneReady: false,
      resultsVisible: false,
    };
    render(<Room session={session} summary={projectUi(makeSnapshot(), localPlayerId, context)} onRetryGraphics={() => undefined} />);

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
    expect(screen.getByRole('button', { name: /выйти/i })).toBeDefined();
  });

  it('offers manual retry after the connection closes without an application error', async () => {
    const session = {
      preview: vi.fn(), create: vi.fn(), join: vi.fn(), configure: vi.fn(), setReady: vi.fn(),
      attachScene: vi.fn().mockResolvedValue(undefined), detachScene: vi.fn(), leave: vi.fn(), retry: vi.fn().mockResolvedValue(undefined),
      rematch: vi.fn(), backToLobby: vi.fn(),
    };
    const closed = { ...context, connection: 'closed' as const, error: null };
    render(<Room session={session} summary={projectUi(makeSnapshot(), localPlayerId, closed)} onRetryGraphics={() => undefined} />);

    expect(screen.getByText(/соединение прервано/i)).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Повторить' })); });
    expect(session.retry).toHaveBeenCalledOnce();
  });

  it('updates offline status from browser events and removes listeners on unmount', () => {
    const session = {
      preview: vi.fn(), create: vi.fn(), join: vi.fn(), configure: vi.fn(), setReady: vi.fn(),
      attachScene: vi.fn().mockResolvedValue(undefined), detachScene: vi.fn(), leave: vi.fn(), retry: vi.fn(),
      rematch: vi.fn(), backToLobby: vi.fn(),
    };
    const browser = { ...navigator, onLine: false };
    vi.stubGlobal('navigator', browser);
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(<Room session={session} summary={projectUi(makeSnapshot(), localPlayerId, context)} onRetryGraphics={() => undefined} />);

    expect(screen.getByText(/нет подключения к интернету/i)).toBeDefined();
    browser.onLine = true;
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.queryByText(/нет подключения к интернету/i)).toBeNull();
    view.unmount();

    expect(removeListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('offline', expect.any(Function));
    removeListener.mockRestore();
  });
});
