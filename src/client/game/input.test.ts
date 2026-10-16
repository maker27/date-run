import { afterEach, describe, expect, it } from 'vitest';
import { InputController } from './input.js';

const controllers: InputController[] = [];

function mountInput(touchRoot?: HTMLElement): InputController {
  const controller = new InputController({ target: window, ...(touchRoot ? { touchRoot } : {}) });
  controllers.push(controller);
  return controller;
}

function key(type: 'keydown' | 'keyup', code: string, repeat = false): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, repeat, bubbles: true, cancelable: true }));
}

function pointer(type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'lostpointercapture', pointerId: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.destroy());
  document.body.replaceChildren();
});

describe('InputController', () => {
  it('cancels opposing directions and consumes a jump edge once', () => {
    const controller = mountInput();
    key('keydown', 'ArrowLeft');
    expect(controller.read()).toEqual({ axis: -1, jumpPressed: false });

    key('keydown', 'KeyD');
    expect(controller.read()).toEqual({ axis: 0, jumpPressed: false });

    key('keyup', 'ArrowLeft');
    key('keydown', 'Space');
    expect(controller.read()).toEqual({ axis: 1, jumpPressed: true });
    expect(controller.read()).toEqual({ axis: 1, jumpPressed: false });
  });

  it('ignores repeated jump keydown and editable or control focus', () => {
    const controller = mountInput();
    const interact = () => { interactions += 1; };
    let interactions = 0;
    controller.onInteract(interact);
    key('keydown', 'Space', true);
    expect(controller.read().jumpPressed).toBe(false);

    const form = document.createElement('form');
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const button = document.createElement('button');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.tabIndex = 0;
    const controls = [input, textarea, select, button, editable];
    form.append(...controls);
    document.body.append(form);
    for (const element of controls) {
      element.focus();
      expect(document.activeElement).toBe(element);
      key('keydown', 'ArrowLeft');
      key('keydown', 'Space');
      key('keydown', 'KeyE');
      expect(controller.read()).toEqual({ axis: 0, jumpPressed: false });
      expect(interactions).toBe(0);
      key('keyup', 'ArrowLeft');
      key('keyup', 'Space');
      key('keyup', 'KeyE');
      element.blur();
    }
  });

  it('accepts global movement and interaction keys while a game input button is focused', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-input="left"></button>';
    document.body.append(root);
    const controller = mountInput(root);
    const button = root.querySelector('button');
    if (!button) throw new Error('The game input button should be present');
    const interact = () => { interactions += 1; };
    let interactions = 0;
    controller.onInteract(interact);
    button.focus();
    expect(document.activeElement).toBe(button);

    for (const [code, axis] of [['KeyA', -1], ['KeyD', 1], ['ArrowLeft', -1], ['ArrowRight', 1]] as const) {
      key('keydown', code);
      expect(controller.read().axis).toBe(axis);
      key('keyup', code);
      expect(controller.read().axis).toBe(0);
    }
    key('keydown', 'KeyE');
    expect(interactions).toBe(1);
    key('keyup', 'KeyE');
  });

  it('clears held keyboard movement when an editable control receives focus', () => {
    const controller = mountInput();
    const input = document.createElement('input');
    document.body.append(input);
    key('keydown', 'KeyD');
    expect(controller.read().axis).toBe(1);

    input.focus();
    expect(document.activeElement).toBe(input);
    expect(controller.read()).toEqual({ axis: 0, jumpPressed: false });
  });

  it('clears held keys on blur', () => {
    const controller = mountInput();
    key('keydown', 'KeyA');
    expect(controller.read().axis).toBe(-1);
    window.dispatchEvent(new FocusEvent('blur'));
    expect(controller.read()).toEqual({ axis: 0, jumpPressed: false });
  });

  it('keeps an action held until every pointer that pressed it is released', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-input="right"></button>';
    document.body.append(root);
    const controller = mountInput(root);
    const button = root.querySelector('button');
    expect(button).not.toBeNull();

    button?.focus();
    expect(document.activeElement).toBe(button);
    button?.dispatchEvent(pointer('pointerdown', 11));
    button?.dispatchEvent(pointer('pointerdown', 12));
    button?.dispatchEvent(pointer('pointerup', 11));
    expect(controller.read().axis).toBe(1);

    button?.dispatchEvent(pointer('pointerup', 12));
    expect(controller.read().axis).toBe(0);
  });

  it('uses the control button when a pointer starts on its nested SVG icon', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-input="right"><svg><path d="M0 0h10v10z"></path></svg></button>';
    document.body.append(root);
    const controller = mountInput(root);
    const icon = root.querySelector('path');

    icon?.dispatchEvent(pointer('pointerdown', 31));
    expect(controller.read().axis).toBe(1);
  });

  it('clears only the pointer that lost capture after its button was removed', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-input="right"></button><button data-input="left"></button>';
    document.body.append(root);
    const controller = mountInput(root);
    const [right, left] = root.querySelectorAll('button');
    expect(right).toBeDefined();
    expect(left).toBeDefined();
    if (!right || !left) throw new Error('Touch controls must be present');

    right.dispatchEvent(pointer('pointerdown', 41));
    left.dispatchEvent(pointer('pointerdown', 42));
    right.remove();
    right.dispatchEvent(pointer('lostpointercapture', 41));

    expect(controller.read().axis).toBe(-1);
    left.dispatchEvent(pointer('pointerup', 42));
    expect(controller.read().axis).toBe(0);
  });

  it('clears a touch action on pointercancel', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-input="jump"></button>';
    document.body.append(root);
    const controller = mountInput(root);
    const button = root.querySelector('button');
    button?.dispatchEvent(pointer('pointerdown', 21));
    expect(controller.read().jumpPressed).toBe(true);
    button?.dispatchEvent(pointer('pointercancel', 21));
    expect(controller.read().jumpPressed).toBe(false);
  });

  it('removes owned handlers across repeated mounts', () => {
    let interactions = 0;
    for (let mount = 0; mount < 3; mount += 1) {
      const controller = mountInput();
      controller.onInteract(() => { interactions += 1; });
      controller.destroy();
    }

    key('keydown', 'KeyE');
    expect(interactions).toBe(0);
  });
});
