import { ServerMessageSchema, type ClientRequest, type InputUpdate, type ServerEvent, type ServerReply, type Unsubscribe } from '../../shared/protocol.js';

export interface ClientSocket extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type SocketClientErrorCode = 'timeout' | 'aborted' | 'disconnected' | 'protocol_error' | 'not_connected' | 'destroyed' | 'retry_exhausted';

export class SocketClientError extends Error {
  constructor(readonly code: SocketClientErrorCode) {
    super(code);
    this.name = 'SocketClientError';
  }
}

type Pending = {
  resolve: (reply: ServerReply) => void;
  reject: (error: SocketClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

type Attempt = {
  reject: (error: SocketClientError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

type SocketListeners = {
  socket: ClientSocket;
  onOpen: (event: Event) => void;
  onClose: (event: Event) => void;
  onMessage: (event: Event) => void;
};

export class SocketClient {
  private readonly socketFactory: (url: string) => ClientSocket;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly eventListeners = new Set<(event: ServerEvent) => void>();
  private readonly statusListeners = new Set<(status: SocketStatus) => void>();
  private readonly pending = new Map<string, Pending>();
  private socket: ClientSocket | null = null;
  private socketListeners: SocketListeners | null = null;
  private attempt: Attempt | null = null;
  private connectingPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private retryRun = 0;
  private destroyed = false;
  private currentStatus: SocketStatus = 'closed';

  constructor(private readonly url: string, options: {
    socketFactory?: (url: string) => ClientSocket;
    random?: () => number;
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
  } = {}) {
    this.socketFactory = options.socketFactory ?? ((address) => new WebSocket(address));
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  }

  get status(): SocketStatus {
    return this.currentStatus;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.destroyed) return Promise.reject(new SocketClientError('destroyed'));
    if (signal?.aborted) return Promise.reject(new SocketClientError('aborted'));
    if (this.currentStatus === 'connected') return Promise.resolve();
    if (this.connectingPromise) return this.connectingPromise;
    this.retryRun += 1;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retries = 0;
    this.setStatus('connecting');
    return this.openAttempt(signal, false);
  }

  request(message: ClientRequest, signal?: AbortSignal): Promise<ServerReply> {
    if (this.destroyed) return Promise.reject(new SocketClientError('destroyed'));
    if (this.currentStatus !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new SocketClientError('not_connected'));
    }
    if (signal?.aborted) return Promise.reject(new SocketClientError('aborted'));
    if (this.pending.has(message.requestId)) return Promise.reject(new SocketClientError('protocol_error'));
    return new Promise<ServerReply>((resolve, reject) => {
      const onAbort = () => this.finishPending(message.requestId, new SocketClientError('aborted'));
      const timer = setTimeout(() => this.finishPending(message.requestId, new SocketClientError('timeout')), this.requestTimeoutMs);
      this.pending.set(message.requestId, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.socket?.send(JSON.stringify(message));
      } catch {
        this.finishPending(message.requestId, new SocketClientError('disconnected'));
      }
    });
  }

  sendInput(message: InputUpdate): void {
    if (this.destroyed) throw new SocketClientError('destroyed');
    if (this.currentStatus !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) {
      throw new SocketClientError('not_connected');
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      throw new SocketClientError('disconnected');
    }
  }

  onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  onStatus(listener: (status: SocketStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => { this.statusListeners.delete(listener); };
  }

  disconnect(): void {
    this.stop(new SocketClientError('disconnected'));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop(new SocketClientError('destroyed'));
    this.eventListeners.clear();
    this.statusListeners.clear();
  }

  private openAttempt(signal: AbortSignal | undefined, retry: boolean): Promise<void> {
    let resolvePromise: () => void = () => undefined;
    let rejectPromise: (error: SocketClientError) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.connectingPromise = promise;
    let socket: ClientSocket;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.connectingPromise = null;
      this.setStatus('closed');
      rejectPromise(new SocketClientError('disconnected'));
      return promise;
    }
    this.socket = socket;
    const clearAttempt = () => {
      const attempt = this.attempt;
      if (attempt === null) return;
      clearTimeout(attempt.timer);
      attempt.signal?.removeEventListener('abort', attempt.onAbort);
      this.attempt = null;
      this.connectingPromise = null;
    };
    const onOpen = () => {
      if (this.socket !== socket) return;
      clearAttempt();
      this.retries = 0;
      this.setStatus('connected');
      resolvePromise();
    };
    const onClose = (event: Event) => {
      if (this.socket !== socket) return;
      const code = 'code' in event && typeof event.code === 'number' ? event.code : 1006;
      const wasConnecting = this.attempt !== null;
      if (wasConnecting) {
        clearAttempt();
        rejectPromise(new SocketClientError('disconnected'));
      }
      this.detachSocket(socket);
      this.socket = null;
      this.rejectPending(new SocketClientError('disconnected'));
      if (this.isRetryable(code) && (retry || !wasConnecting)) {
        this.scheduleRetry();
      } else {
        if (!this.isRetryable(code)) this.retries = 8;
        this.setStatus('closed');
      }
    };
    const onMessage = (event: Event) => {
      if (this.socket !== socket) return;
      this.receive(event);
    };
    const onAbort = () => this.closeAttempt(socket, new SocketClientError('aborted'));
    const timer = setTimeout(() => this.closeAttempt(socket, new SocketClientError('timeout')), this.connectTimeoutMs);
    this.attempt = { reject: rejectPromise, timer, signal, onAbort };
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('message', onMessage);
    this.socketListeners = { socket, onOpen, onClose, onMessage };
    return promise;
  }

  private closeAttempt(socket: ClientSocket, error: SocketClientError): void {
    if (this.socket !== socket || this.attempt === null) return;
    const attempt = this.attempt;
    clearTimeout(attempt.timer);
    attempt.signal?.removeEventListener('abort', attempt.onAbort);
    this.attempt = null;
    this.connectingPromise = null;
    this.detachSocket(socket);
    this.socket = null;
    socket.close();
    attempt.reject(error);
    this.setStatus('closed');
  }

  private receive(event: Event): void {
    if (!('data' in event) || typeof event.data !== 'string') {
      this.protocolFailure();
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      this.protocolFailure();
      return;
    }
    const parsed = ServerMessageSchema.safeParse(data);
    if (!parsed.success) {
      this.protocolFailure();
      return;
    }
    const message = parsed.data;
    if (message.type === 'error') {
      if (message.requestId !== undefined) {
        this.finishPending(message.requestId, { version: 1, type: 'error', requestId: message.requestId, code: message.code });
      } else {
        this.publish({ version: 1, type: 'error', code: message.code });
      }
      return;
    }
    switch (message.type) {
      case 'room:joined':
      case 'command:result':
      case 'room:resynced':
      case 'world:interact:result':
      case 'time:pong':
        this.finishPending(message.requestId, message);
        return;
      default:
        this.publish(message);
    }
  }

  private protocolFailure(): void {
    this.retryRun += 1;
    const socket = this.socket;
    this.rejectPending(new SocketClientError('protocol_error'));
    if (socket === null) return;
    this.detachSocket(socket);
    if (this.attempt !== null) {
      clearTimeout(this.attempt.timer);
      this.attempt.signal?.removeEventListener('abort', this.attempt.onAbort);
      this.attempt.reject(new SocketClientError('protocol_error'));
      this.attempt = null;
      this.connectingPromise = null;
    }
    this.socket = null;
    socket.close(4003);
    this.setStatus('closed');
  }

  private publish(event: ServerEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private finishPending(id: string, result: ServerReply | SocketClientError): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.onAbort);
    if (result instanceof SocketClientError) pending.reject(result);
    else pending.resolve(result);
  }

  private rejectPending(error: SocketClientError): void {
    for (const id of this.pending.keys()) this.finishPending(id, error);
  }

  private scheduleRetry(): void {
    if (this.destroyed) return;
    if (this.retries >= 8) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('reconnecting');
    const attempt = this.retries;
    const run = this.retryRun;
    this.retries += 1;
    const delay = Math.min(500 * 2 ** attempt, 5000) * (0.8 + 0.4 * this.random());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.openAttempt(undefined, true).catch(() => {
        if (run === this.retryRun && this.currentStatus === 'closed' && this.retries < 8 && !this.destroyed) this.scheduleRetry();
      });
    }, delay);
  }

  private isRetryable(code: number): boolean {
    return code === 1006 || code === 1011 || code === 1012 || code === 1013;
  }

  private stop(error: SocketClientError): void {
    this.retryRun += 1;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    if (socket !== null) this.detachSocket(socket);
    this.socket = null;
    if (this.attempt !== null) {
      clearTimeout(this.attempt.timer);
      this.attempt.signal?.removeEventListener('abort', this.attempt.onAbort);
      this.attempt.reject(error);
      this.attempt = null;
      this.connectingPromise = null;
    }
    this.rejectPending(error);
    socket?.close(1000);
    this.retries = 0;
    this.setStatus('closed');
  }

  private detachSocket(socket: ClientSocket): void {
    const listeners = this.socketListeners;
    if (listeners?.socket !== socket) return;
    this.socketListeners = null;
    socket.removeEventListener('open', listeners.onOpen);
    socket.removeEventListener('close', listeners.onClose);
    socket.removeEventListener('message', listeners.onMessage);
  }

  private setStatus(status: SocketStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
