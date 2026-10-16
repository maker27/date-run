import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { RolePicker } from './RolePicker.js';

afterEach(cleanup);

describe('RolePicker', () => {
  it('lets the user choose a starting side with Russian accessible labels', () => {
    const onChange = vi.fn();
    render(<RolePicker value="a" onChange={onChange} />);

    expect(screen.getByRole('radiogroup', { name: 'Стартовая сторона' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Слева' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('radio', { name: 'Справа' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('disables both roles while ready or when the player is not host', () => {
    render(<RolePicker value="b" disabled onChange={() => undefined} />);

    expect(screen.getByRole('radio', { name: 'Слева' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('radio', { name: 'Справа' }).hasAttribute('disabled')).toBe(true);
  });
});
