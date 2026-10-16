import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { makeSnapshot, localPlayerId } from '../../../../tests/fixtures/world-snapshot.js';
import type { RoomPreview } from '../../../shared/model.js';
import { GameSessionError } from '../../application/game-session.js';
import { projectUi } from '../../application/ui-summary.js';
import { Lobby } from './Lobby.js';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

const context = {
  connection: 'connected' as const,
  loading: false,
  error: null,
  storageWarning: false,
  closing: null,
  sceneReady: false,
  resultsVisible: false,
};

function landingSummary() {
  return projectUi(null, null, context);
}

function fakeSession() {
  return {
    preview: vi.fn<(code: string, signal?: AbortSignal) => Promise<RoomPreview>>()
      .mockResolvedValue({ roomId: 'ABCD2345', themeId: 'retro', availableRole: 'b', phase: 'lobby', occupiedPlaces: 1 }),
    create: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn().mockResolvedValue(undefined),
    setReady: vi.fn().mockResolvedValue(undefined),
    leave: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Lobby landing', () => {
  it('moves focus to the landing heading', () => {
    render(<Lobby session={fakeSession()} summary={landingSummary()} />);

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it.each([
    ['first-date', 'a'],
    ['retro', 'b'],
    ['winter', 'a'],
  ] as const)('creates a room with selected theme %s and role %s', async (theme, role) => {
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);

    fireEvent.click(screen.getByRole('radio', { name: theme === 'first-date' ? 'Первое свидание' : theme === 'retro' ? 'Ретро' : 'Зимнее свидание' }));
    fireEvent.click(screen.getByRole('radio', { name: role === 'a' ? 'Слева' : 'Справа' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Создать комнату' })); });

    expect(session.create).toHaveBeenCalledWith(theme, role);
  });

  it('previews an invitation query without joining automatically', async () => {
    window.history.replaceState({}, '', '/?room=ABCD2345');
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);

    await expect.poll(() => session.preview).toHaveBeenCalledWith('ABCD2345', expect.any(AbortSignal));
    expect(session.join).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Войти в комнату' })).toBeDefined();
  });

  it('shows a successful preview and joins only after explicit confirmation', async () => {
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Код комнаты' }), { target: { value: 'abcd2345' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });

    expect(session.preview).toHaveBeenCalledWith('ABCD2345', expect.any(AbortSignal));
    expect(screen.getByRole('button', { name: 'Войти в комнату' })).toBeDefined();
    expect(session.join).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Войти в комнату' })); });
    expect(session.join).toHaveBeenCalledWith('ABCD2345');
  });

  it('ignores an older preview after a newer code has been checked', async () => {
    const first = Promise.withResolvers<RoomPreview>();
    const second = Promise.withResolvers<RoomPreview>();
    const session = fakeSession();
    session.preview.mockImplementation((code) => code === 'ABCD2345' ? first.promise : second.promise);
    render(<Lobby session={session} summary={landingSummary()} />);
    const input = screen.getByRole('textbox', { name: 'Код комнаты' });
    fireEvent.change(input, { target: { value: 'ABCD2345' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });
    fireEvent.change(input, { target: { value: 'EFGH2345' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });
    second.resolve({ roomId: 'EFGH2345', themeId: 'winter', availableRole: 'a', phase: 'lobby', occupiedPlaces: 1 });
    await act(async () => { await second.promise; });
    first.resolve({ roomId: 'ABCD2345', themeId: 'retro', availableRole: 'b', phase: 'lobby', occupiedPlaces: 1 });
    await act(async () => { await first.promise; });

    expect(screen.getByRole('button', { name: 'Войти в комнату' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Зимнее свидание');
    expect(screen.getByRole('status').textContent).not.toContain('Ретро');
    expect(input).toHaveProperty('value', 'EFGH2345');
    expect(session.join).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Войти в комнату' })); });
    expect(session.join).toHaveBeenCalledWith('EFGH2345');
  });

  it('aborts an in-flight invitation preview when the landing screen unmounts', async () => {
    const session = fakeSession();
    let signal: AbortSignal | undefined;
    session.preview.mockImplementation((_code, requestSignal) => {
      signal = requestSignal;
      return new Promise(() => undefined);
    });
    window.history.replaceState({}, '', '/?room=ABCD2345');
    const view = render(<Lobby session={session} summary={landingSummary()} />);
    await expect.poll(() => signal).toBeDefined();
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('keeps malformed pasted code invalid and does not truncate it into a room join', async () => {
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);
    const input = screen.getByRole('textbox', { name: 'Код комнаты' });

    fireEvent.paste(input, { clipboardData: { getData: () => 'ABCD2345<script>' } });
    fireEvent.input(input, { target: { value: 'ABCD2345<script>' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Войти в комнату' })); });

    expect(session.join).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/код комнаты/i);
    expect(document.querySelector('script')).toBeNull();
  });

  it('does not preview an empty or invalid code and tells the user what to fix', async () => {
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Код комнаты' }), { target: { value: 'ABCD0000' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });

    expect(session.preview).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/восьми символов/i);
  });

  it.each([
    ['room_full', 'В комнате нет свободных мест.'],
    ['room_not_found', 'Комната не найдена.'],
    ['session_expired', 'Срок действия приглашения истёк.'],
  ] as const)('shows a retryable preview error for %s', async (code, message) => {
    const session = fakeSession();
    session.preview.mockRejectedValue(new GameSessionError(code));
    render(<Lobby session={session} summary={landingSummary()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Код комнаты' }), { target: { value: 'ABCD2345' } });

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });

    expect(screen.getByRole('alert').textContent).toContain(message);
    expect(session.join).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Проверить комнату' })).toBeDefined();
  });

  it('retries a failed preview and provides a way back to the landing form', async () => {
    const session = fakeSession();
    session.preview.mockRejectedValueOnce(new GameSessionError('room_full'));
    render(<Lobby session={session} summary={landingSummary()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Код комнаты' }), { target: { value: 'ABCD2345' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Повторить' })); });

    expect(session.preview).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Войти в комнату' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByRole('textbox', { name: 'Код комнаты' })).toBeDefined();
    expect(session.join).not.toHaveBeenCalled();
  });

  it('clears the successful room description when a same-code retry fails', async () => {
    const session = fakeSession();
    render(<Lobby session={session} summary={landingSummary()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Код комнаты' }), { target: { value: 'ABCD2345' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Проверить комнату' })); });
    expect(screen.getByRole('status').textContent).toContain('Комната найдена: Ретро.');

    session.preview.mockRejectedValueOnce(new GameSessionError('room_not_found'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Повторить' })); });

    expect(screen.getByRole('alert').textContent).toContain('Комната не найдена.');
    expect(screen.queryByText(/Комната найдена:/)).toBeNull();
    expect(session.join).not.toHaveBeenCalled();
  });
});

describe('Lobby room controls', () => {
  it('disables ready until the current theme and scene are ready', () => {
    const snapshot = makeSnapshot();
    const lobby = {
      ...snapshot,
      state: { ...snapshot.state, phase: 'lobby' as const },
    };
    const summary = projectUi(lobby, localPlayerId, context);
    const session = fakeSession();
    render(<Lobby session={session} summary={summary} />);

    expect(screen.getByRole('button', { name: 'Готов' }).hasAttribute('disabled')).toBe(true);
  });
});
