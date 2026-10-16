import { createRequestId } from '../../src/client/platform/request-id.js';
import type { WorldSnapshot } from '../../src/shared/model.js';
import { ServerMessageSchema } from '../../src/shared/protocol.js';
import type { ClientSocket } from '../../src/client/realtime/socket-client.js';


class ControlledSocket extends EventTarget implements ClientSocket {
  constructor(private readonly socket: WebSocket, private readonly owner: TestTransport) {
    super();
    socket.addEventListener('open', () => this.dispatchEvent(new Event('open')));
    socket.addEventListener('error', () => this.dispatchEvent(new Event('error')));
    socket.addEventListener('close', (event) => this.dispatchEvent(new CloseEvent('close', {
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    })));
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const parsed: unknown = JSON.parse(event.data);
          const result = ServerMessageSchema.safeParse(parsed);
          if (result.success) {
            const message = result.data;
            if (message.type === 'room:resynced') this.owner.lastResyncedInputGeneration = message.rejoinState.inputGeneration;
            if (this.owner.dropCompletionSnapshots && 'snapshot' in message && message.snapshot.state.phase === 'complete') return;
            if (this.owner.dropType === message.type) {
              this.owner.dropType = null;
              return;
            }
            if ('snapshot' in message) this.owner.snapshot = message.snapshot;
          }
        } catch { /* Forward malformed payload to the real client validator. */ }
      }
      this.dispatchEvent(new MessageEvent('message', { data: event.data }));
    });
  }

  get readyState(): number { return this.socket.readyState; }
  send(data: string): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
}

export class TestTransport {
  snapshot: WorldSnapshot | null = null;
  lastResyncedInputGeneration: number | null = null;
  dropType: string | null = null;
  dropCompletionSnapshots = false;
  private current: ControlledSocket | null = null;
  private currentId: string | null = null;

  createSocket = (url: string): ClientSocket => {
    const id = createRequestId();
    const socket = new ControlledSocket(new WebSocket(url, `date-run-test-${id}`), this);
    this.current = socket;
    this.currentId = id;
    return socket;
  };

  connectionId(): string {
    if (!this.current || this.current.readyState !== WebSocket.OPEN) throw new Error('No connected socket');
    if (!this.currentId) throw new Error('No socket identifier');
    return this.currentId;
  }

  dropNext(type: string): void { this.dropType = type; }
  dropCompletion(): void { this.dropCompletionSnapshots = true; }
}
