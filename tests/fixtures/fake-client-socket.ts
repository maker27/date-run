import type { ClientSocket } from '../../src/client/realtime/socket-client.js';

export class FakeClientSocket extends EventTarget implements ClientSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly activeListeners: Array<{ type: string; callback: EventListenerOrEventListenerObject }> = [];

  get activeListenerCount(): number {
    return this.activeListeners.length;
  }

  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, callback, options);
    if (callback !== null) this.activeListeners.push({ type, callback });
  }

  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, callback, options);
    const index = this.activeListeners.findIndex((entry) => entry.type === type && entry.callback === callback);
    if (index !== -1) this.activeListeners.splice(index, 1);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.emitClose(code ?? 1000, reason ?? '');
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  emitError(): void {
    this.dispatchEvent(new Event('error'));
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = 3;
    const event = new Event('close');
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
      wasClean: { value: true },
    });
    this.dispatchEvent(event);
  }
}
