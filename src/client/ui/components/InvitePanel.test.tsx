import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { InvitePanel } from './InvitePanel.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InvitePanel', () => {
  it('copies the invite link and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<InvitePanel roomId="ABCD2345" inviteUrl="https://date.test/?room=ABCD2345" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скопировать ссылку' }));
    });

    expect(writeText).toHaveBeenCalledWith('https://date.test/?room=ABCD2345');
    expect(screen.getByRole('status').textContent).toMatch(/скопирована/i);
  });

  it('shows selectable invite text and a clear message when clipboard access is denied', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('private browser detail', 'NotAllowedError'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<InvitePanel roomId="ABCD2345" inviteUrl="https://date.test/?room=ABCD2345" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скопировать ссылку' }));
    });

    const url = screen.getByRole('textbox', { name: 'Ссылка-приглашение' });
    expect(url).toHaveProperty('value', 'https://date.test/?room=ABCD2345');
    expect(url).toHaveProperty('readOnly', true);
    expect(screen.getByRole('alert').textContent).toMatch(/не удалось скопировать/i);
    expect(document.body.textContent).not.toContain('private browser detail');
  });

  it('exposes the room code for selection when clipboard access is unavailable', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('permission denied', 'NotAllowedError'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<InvitePanel roomId="ABCD2345" inviteUrl="https://date.test/?room=ABCD2345" />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скопировать код' })); });

    expect(writeText).toHaveBeenCalledWith('ABCD2345');
    expect(screen.getByRole('textbox', { name: 'Код комнаты' })).toHaveProperty('value', 'ABCD2345');
    expect(screen.getByRole('alert').textContent).toMatch(/не удалось скопировать/i);
    expect(document.body.textContent).not.toContain('permission denied');
  });

  it('shows the same selectable fallback when the Clipboard API is absent', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    render(<InvitePanel roomId="ABCD2345" inviteUrl="https://date.test/date-run/?room=ABCD2345" />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Скопировать ссылку' })); });

    expect(screen.getByRole('textbox', { name: 'Ссылка-приглашение' })).toHaveProperty('value', 'https://date.test/date-run/?room=ABCD2345');
    expect(screen.getByRole('alert').textContent).toMatch(/выделите и скопируйте/i);
  });
});
