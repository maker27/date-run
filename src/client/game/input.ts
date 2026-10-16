import type { PlayerInput } from '../../shared/model.js';

type Action = 'left' | 'right' | 'jump' | 'interact';

const keyActions: Readonly<Record<string, Action>> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'jump', ArrowUp: 'jump', KeyW: 'jump', KeyE: 'interact',
};

function isEditing(target: EventTarget | null, touchRoot?: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (touchRoot && actionFrom(target, touchRoot)) return false;
  return target.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])') !== null;
}

function actionFrom(target: EventTarget | null, root: HTMLElement): { action: Action; element: HTMLElement } | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest('[data-input]');
  if (!(button instanceof HTMLElement) || !root.contains(button)) return null;
  const action = button.dataset.input;
  return action === 'left' || action === 'right' || action === 'jump' || action === 'interact'
    ? { action, element: button }
    : null;
}

export class InputController {
  private readonly target: Window;
  private readonly enabled: () => boolean;
  private readonly touchRoot: HTMLElement | undefined;
  private readonly keys = new Set<string>();
  private readonly controlKeys = new Map<string, Action>();
  private readonly pointers = new Map<number, {
    action: Action;
    element: HTMLElement;
    onCaptureLost: (event: PointerEvent) => void;
  }>();
  private readonly interactions = new Set<() => void>();
  private pendingKeyboardJump = false;
  private pendingPointerJump = false;
  private destroyed = false;

  constructor(options: { target?: Window; enabled?: () => boolean; touchRoot?: HTMLElement } = {}) {
    this.target = options.target ?? window;
    this.enabled = options.enabled ?? (() => true);
    this.touchRoot = options.touchRoot;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('blur', this.onBlur);
    this.target.document.addEventListener('focusin', this.onFocusIn);
    this.touchRoot?.addEventListener('pointerdown', this.onPointerDown);
    this.touchRoot?.addEventListener('pointerup', this.onPointerEnd);
    this.touchRoot?.addEventListener('pointercancel', this.onPointerEnd);
    this.touchRoot?.addEventListener('click', this.onControlClick);
  }

  read(): PlayerInput {
    if (!this.enabled() || this.destroyed) {
      this.reset();
      return { axis: 0, jumpPressed: false };
    }
    if (isEditing(this.target.document.activeElement, this.touchRoot)) this.clearKeyboard();
    const left = this.hasAction('left');
    const right = this.hasAction('right');
    const axis = left === right ? 0 : left ? -1 : 1;
    const jumpPressed = this.pendingKeyboardJump || this.pendingPointerJump;
    this.pendingKeyboardJump = false;
    this.pendingPointerJump = false;
    return { axis, jumpPressed };
  }

  onInteract(listener: () => void): () => void {
    this.interactions.add(listener);
    return () => this.interactions.delete(listener);
  }

  reset(): void {
    this.clearKeyboard();
    for (const [id, pointer] of this.pointers) {
      pointer.element.removeEventListener('lostpointercapture', pointer.onCaptureLost);
      if (pointer.element.hasPointerCapture?.(id)) pointer.element.releasePointerCapture(id);
    }
    this.pointers.clear();
    this.pendingPointerJump = false;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.reset();
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.target.document.removeEventListener('focusin', this.onFocusIn);
    this.touchRoot?.removeEventListener('pointerdown', this.onPointerDown);
    this.touchRoot?.removeEventListener('pointerup', this.onPointerEnd);
    this.touchRoot?.removeEventListener('pointercancel', this.onPointerEnd);
    this.touchRoot?.removeEventListener('click', this.onControlClick);
    this.interactions.clear();
  }

  private clearKeyboard(): void {
    this.keys.clear();
    this.controlKeys.clear();
    this.pendingKeyboardJump = false;
  }

  private hasAction(action: Action): boolean {
    for (const code of this.keys) if (keyActions[code] === action) return true;
    for (const held of this.controlKeys.values()) if (held === action) return true;
    for (const pointer of this.pointers.values()) if (pointer.action === action) return true;
    return false;
  }

  private fireInteract(): void {
    for (const listener of this.interactions) listener();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const control = this.touchRoot ? actionFrom(this.target.document.activeElement, this.touchRoot) : null;
    if (control && (event.code === 'Enter' || event.code === 'Space')) {
      if (!this.enabled() || event.repeat) { event.preventDefault(); return; }
      if (control.action === 'left' || control.action === 'right') {
        event.preventDefault();
        this.controlKeys.set(event.code, control.action);
      }
      return;
    }
    const action = keyActions[event.code];
    if (!action || !this.enabled() || isEditing(this.target.document.activeElement, this.touchRoot)) return;
    event.preventDefault();
    if (event.repeat || this.keys.has(event.code)) return;
    this.keys.add(event.code);
    if (action === 'jump') this.pendingKeyboardJump = true;
    if (action === 'interact') this.fireInteract();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.controlKeys.delete(event.code)) { event.preventDefault(); return; }
    if (!keyActions[event.code]) return;
    if (this.keys.delete(event.code) && this.enabled()) event.preventDefault();
  };

  private readonly onBlur = (): void => this.reset();

  private readonly onFocusIn = (event: FocusEvent): void => {
    if (isEditing(event.target, this.touchRoot)) this.clearKeyboard();
  };

  private readonly onControlClick = (event: MouseEvent): void => {
    if (!this.enabled() || event.detail !== 0 || !this.touchRoot) return;
    const control = actionFrom(event.target, this.touchRoot);
    if (control?.action === 'jump') this.pendingKeyboardJump = true;
    if (control?.action === 'interact') this.fireInteract();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled()) return;
    const control = actionFrom(event.target, this.touchRoot ?? this.target.document.body);
    if (!control || this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    control.element.setPointerCapture?.(event.pointerId);
    const onCaptureLost = (lost: PointerEvent): void => {
      if (lost.pointerId === event.pointerId) this.releasePointer(lost.pointerId, true);
    };
    control.element.addEventListener('lostpointercapture', onCaptureLost);
    this.pointers.set(event.pointerId, { ...control, onCaptureLost });
    if (control.action === 'jump') this.pendingPointerJump = true;
    if (control.action === 'interact') this.fireInteract();
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    event.preventDefault();
    this.releasePointer(event.pointerId, event.type === 'pointercancel');
  };

  private releasePointer(id: number, canceled: boolean): void {
    const pointer = this.pointers.get(id);
    if (!pointer) return;
    pointer.element.removeEventListener('lostpointercapture', pointer.onCaptureLost);
    this.pointers.delete(id);
    if (pointer.element.hasPointerCapture?.(id)) pointer.element.releasePointerCapture(id);
    if (canceled && pointer.action === 'jump'
      && ![...this.pointers.values()].some((held) => held.action === 'jump')) this.pendingPointerJump = false;
  }
}
