import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { ThemePicker } from './ThemePicker.js';

afterEach(cleanup);

describe('ThemePicker', () => {
  it('offers all themes as accessible choices and reports the selected theme', () => {
    const onChange = vi.fn();
    render(<ThemePicker value="first-date" onChange={onChange} />);

    expect(screen.getByRole('radiogroup', { name: 'Тема игры' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Первое свидание' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Ретро' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Зимнее свидание' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Первое свидание' })).toHaveProperty('checked', true);

    fireEvent.click(screen.getByRole('radio', { name: 'Ретро' }));
    expect(onChange).toHaveBeenCalledWith('retro');
  });

  it('keeps choices unavailable when the caller disables configuration', () => {
    render(<ThemePicker value="winter" disabled onChange={() => undefined} />);

    expect(screen.getByRole('radio', { name: 'Зимнее свидание' })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Первое свидание' }).hasAttribute('disabled')).toBe(true);
  });
});
