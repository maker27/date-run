import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { InputController } from '../../game/input.js';
import { TouchControls } from './TouchControls.js';

const controllers: InputController[] = [];

afterEach(() => {
  cleanup();
  controllers.splice(0).forEach((controller) => controller.destroy());
  document.body.replaceChildren();
});

function mountControls() {
  const view = render(<TouchControls />);
  const root = view.container.querySelector('.touch-controls');
  if (!(root instanceof HTMLElement)) throw new Error('Touch controls should render their action group');
  const controller = new InputController({ target: window, touchRoot: root });
  controllers.push(controller);
  return { ...view, root, controller };
}

function activate(button: HTMLElement, code: 'Enter' | 'Space'): void {
  const key = code === 'Space' ? ' ' : 'Enter';
  const keyDownAllowed = fireEvent.keyDown(button, { code, key });
  if (code === 'Enter' && keyDownAllowed) fireEvent.click(button, { detail: 0 });
  fireEvent.keyDown(button, { code, key, repeat: true });
  const keyUpAllowed = fireEvent.keyUp(button, { code, key });
  if (code === 'Space' && keyDownAllowed && keyUpAllowed) fireEvent.click(button, { detail: 0 });
}

function pointer(button: HTMLElement, type: 'pointerdown' | 'pointerup', pointerId: number): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  button.dispatchEvent(event);
}

describe('TouchControls', () => {
  it('renders labeled controls using the shared InputController action keys', () => {
    const { container } = render(<TouchControls />);

    expect(screen.getByRole('group', { name: 'Управление игрой' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Двигаться влево' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Двигаться вправо' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Прыжок' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Взять подарок' })).toBeDefined();
    expect([...container.querySelectorAll('[data-input]')].map((control) => control.getAttribute('data-input')))
      .toEqual(['left', 'right', 'jump', 'interact']);
  });

  it.each(['Enter', 'Space'] as const)('activates jump once with %s on the focused game button', (code) => {
    const { controller } = mountControls();
    const jump = screen.getByRole('button', { name: 'Прыжок' });
    jump.focus();

    activate(jump, code);

    expect(controller.read().jumpPressed).toBe(true);
    expect(controller.read().jumpPressed).toBe(false);
  });

  it.each(['Enter', 'Space'] as const)('activates gift once with %s on the focused game button', (code) => {
    const { controller } = mountControls();
    const interact = vi.fn();
    controller.onInteract(interact);
    const gift = screen.getByRole('button', { name: 'Взять подарок' });
    gift.focus();

    activate(gift, code);

    expect(interact).toHaveBeenCalledOnce();
  });

  it('holds focused direction through the shared controller and releases on keyup, reset, or focus departure', () => {
    const { controller } = mountControls();
    const left = screen.getByRole('button', { name: 'Двигаться влево' });
    left.focus();

    fireEvent.keyDown(left, { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(controller.read().axis).toBe(-1);
    fireEvent.keyUp(left, { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(controller.read().axis).toBe(0);

    fireEvent.keyDown(left, { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(controller.read().axis).toBe(-1);
    act(() => { controller.reset(); });
    expect(controller.read().axis).toBe(0);
    fireEvent.keyUp(left, { code: 'ArrowLeft', key: 'ArrowLeft' });

    fireEvent.keyDown(left, { code: 'ArrowLeft', key: 'ArrowLeft' });
    expect(controller.read().axis).toBe(-1);
    const next = document.createElement('input');
    document.body.append(next);
    next.focus();
    expect(document.activeElement).toBe(next);
    expect(controller.read().axis).toBe(0);
  });

  it('keeps pointer activation single when the browser dispatches its synthesized click', () => {
    const { controller } = mountControls();
    const jump = screen.getByRole('button', { name: 'Прыжок' });
    pointer(jump, 'pointerdown', 11);
    pointer(jump, 'pointerup', 11);
    fireEvent.click(jump, { detail: 1 });
    expect(controller.read().jumpPressed).toBe(true);
    expect(controller.read().jumpPressed).toBe(false);

    const interact = vi.fn();
    controller.onInteract(interact);
    const gift = screen.getByRole('button', { name: 'Взять подарок' });
    pointer(gift, 'pointerdown', 12);
    pointer(gift, 'pointerup', 12);
    fireEvent.click(gift, { detail: 1 });
    expect(interact).toHaveBeenCalledOnce();
  });
});
