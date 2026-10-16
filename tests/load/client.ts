import { randomUUID } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import WebSocket, { type RawData } from 'ws';
import { ClockSync } from '../../src/client/realtime/clock-sync.js';
import type { Credential, PlayerInput, Role, WorldSnapshot } from '../../src/shared/model.js';
import { ServerMessageSchema, type ClientMessage, type ServerMessage, type ServerReply } from '../../src/shared/protocol.js';
import { ReportCollector } from './report.js';

type Reply = ServerReply;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class LoadClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly clock = new ClockSync();
  private expectedClose = false;
  private lastSnapshot: WorldSnapshot | null = null;
  private credential: Credential | null = null;
  private seq = 1;
  private generation = 1;
  private lastPing = 0;
  private pingPending = false;
  private lastWorldUpdateAt = 0;
  private giftRequested = false;
  readonly role: Role;

  constructor(private readonly url: string, private readonly origin: string, role: Role, private readonly report: ReportCollector, private readonly targetHost?: string, private readonly tlsServername?: string) {
    this.role = role;
  }

  get snapshot(): WorldSnapshot | null { return this.lastSnapshot; }
  get playerId(): string | null { return this.credential?.playerId ?? null; }
  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }
  get hasFreshSnapshot(): boolean { return this.lastWorldUpdateAt > 0 && performance.now() - this.lastWorldUpdateAt < 500; }

  async connect(): Promise<void> {
    this.expectedClose = false;
    const socket = new WebSocket(this.url, { origin: this.origin, perMessageDeflate: false, handshakeTimeout: 5000,
      headers: this.targetHost ? { Host: this.targetHost } : undefined,
      agent: this.tlsServername ? new HttpsAgent({ servername: this.tlsServername }) : undefined });
    this.socket = socket;
    socket.on('message', (data, isBinary) => this.receive(data, isBinary));
    socket.on('close', () => {
      if (!this.expectedClose) this.report.unexpectedDisconnects += 1;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('WebSocket closed')); }
      this.pending.clear();
    });
    socket.on('error', (error) => { if (!this.expectedClose) this.report.error(`WebSocket error: ${error.message}`); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('WebSocket open timeout')), 5000);
      const opened = () => finish();
      const failed = (error: Error) => finish(error);
      function finish(error?: Error): void {
        clearTimeout(timer);
        socket.off('open', opened);
        socket.off('error', failed);
        if (error) { socket.terminate(); reject(error); }
        else resolve();
      }
      socket.once('open', opened);
      socket.once('error', failed);
    });
    await this.ping();
  }

  private receive(data: RawData, isBinary: boolean): void {
    if (isBinary) { this.report.error('Binary server message'); return; }
    this.report.bytesReceived += Buffer.byteLength(data.toString());
    let raw: unknown;
    try { raw = JSON.parse(data.toString()); }
    catch { this.report.error('Invalid server JSON'); return; }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) { this.report.error('Invalid server message'); return; }
    const message = parsed.data;
    if ('snapshot' in message) {
      this.lastSnapshot = message.snapshot;
      if (message.type === 'world:update') {
        this.lastWorldUpdateAt = performance.now();
        this.report.snapshots += 1;
        const now = this.clock.serverNow(performance.now());
        if (now !== null) this.report.snapshotAges.record(Math.max(0, now - message.snapshot.serverTime));
      }
      const self = message.snapshot.state.players.find((player) => player.id === this.credential?.playerId);
      if (self) this.generation = self.inputGeneration;
    }
    if (message.type === 'error') {
      if (!message.requestId && message.code === 'invalid_phase' && this.lastSnapshot?.state.phase === 'complete') {
        this.report.expectedLateInputs += 1;
        return;
      }
      if (message.code === 'queue_full') this.report.queueOverflows += 1;
      this.report.error(`Server error: ${message.code}${message.requestId ? ' (request)' : ' (input)'}`);
    }
    if ('requestId' in message && typeof message.requestId === 'string') {
      const pending = this.pending.get(message.requestId);
      if (pending) {
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message.type === 'error' ? { ...message, requestId: message.requestId } : message);
      }
    }
  }

  private async send(message: ClientMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is closed');
    const payload = JSON.stringify(message);
    if (socket.bufferedAmount > 262_144) throw new Error('Client outbound queue exceeded 256 KiB');
    await new Promise<void>((resolve, reject) => socket.send(payload, (error) => error ? reject(error) : resolve()));
    this.report.bytesSent += Buffer.byteLength(payload);
  }

  private async request(message: Extract<ClientMessage, { requestId: string }>): Promise<Reply> {
    const reply = new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(message.requestId); reject(new Error(`${message.type} timeout`)); }, 5000);
      this.pending.set(message.requestId, { resolve, reject, timer });
    });
    try { await this.send(message); return await reply; }
    catch (error) {
      const pending = this.pending.get(message.requestId);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.requestId); }
      throw error;
    }
  }

  private async ping(): Promise<void> {
    const clientTime = performance.now();
    const reply = await this.request({ version: 1, type: 'time:ping', requestId: randomUUID(), clientTime });
    if (reply.type !== 'time:pong' || !this.clock.record(clientTime, performance.now(), reply.serverTime)) throw new Error('Clock synchronization failed');
    this.lastPing = performance.now();
  }

  async create(): Promise<string> {
    const reply = await this.request({ version: 1, type: 'room:create', requestId: randomUUID(), themeId: 'first-date', role: this.role });
    if (reply.type !== 'room:joined') throw new Error(`room:create failed: ${reply.type}`);
    this.setJoined(reply);
    return reply.credential.roomId;
  }

  async join(roomId: string): Promise<void> {
    const reply = await this.request({ version: 1, type: 'room:join', requestId: randomUUID(), roomId });
    if (reply.type !== 'room:joined') throw new Error(`room:join failed: ${reply.type}`);
    this.setJoined(reply);
  }

  async rejoin(): Promise<void> {
    const token = this.credential?.sessionToken;
    if (!token) throw new Error('Missing rejoin credential');
    await this.close();
    this.clock.reset();
    this.lastWorldUpdateAt = 0;
    await this.connect();
    const reply = await this.request({ version: 1, type: 'room:rejoin', requestId: randomUUID(), sessionToken: token });
    if (reply.type !== 'room:joined') throw new Error(`room:rejoin failed: ${reply.type}`);
    this.setJoined(reply);
  }

  private setJoined(reply: Extract<ServerMessage, { type: 'room:joined' }>): void {
    this.credential = reply.credential;
    this.lastSnapshot = reply.snapshot;
    this.seq = reply.rejoinState.nextSeq;
    this.generation = reply.rejoinState.inputGeneration;
    this.giftRequested = reply.snapshot.state.gifts.some((gift) => gift.ownerRole === this.role && gift.collectedBy !== null);
  }

  async ready(): Promise<void> {
    const reply = await this.request({ version: 1, type: 'player:ready', requestId: randomUUID(), ready: true });
    if (reply.type !== 'command:result') throw new Error(`player:ready failed: ${reply.type}`);
  }

  async leave(): Promise<void> {
    if (!this.connected || !this.credential) return;
    this.expectedClose = true;
    const reply = await this.request({ version: 1, type: 'room:leave', requestId: randomUUID() });
    if (reply.type !== 'command:result') throw new Error(`room:leave failed: ${reply.type}`);
    this.credential = null;
  }

  async input(input: PlayerInput): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (!snapshot || snapshot.state.phase !== 'playing' || snapshot.state.paused) return;
    await this.send({ version: 1, type: 'input:update', epoch: snapshot.epoch, inputGeneration: this.generation, seq: this.seq++, input });
    this.report.inputsSent += 1;
    if (!this.pingPending && performance.now() - this.lastPing > 5000) {
      this.pingPending = true;
      this.lastPing = performance.now();
      void this.ping().catch((error: unknown) => this.report.error(error instanceof Error ? error.message : 'Clock ping failed'))
        .finally(() => { this.pingPending = false; });
    }
  }

  async flush(): Promise<void> { await this.ping(); }

  async collectGift(objectId: string): Promise<void> {
    if (this.giftRequested || !this.lastSnapshot) return;
    this.giftRequested = true;
    const reply = await this.request({ version: 1, type: 'world:interact', requestId: randomUUID(), epoch: this.lastSnapshot.epoch, objectId });
    if (reply.type !== 'world:interact:result') throw new Error(`Gift interaction failed: ${reply.type}`);
    if (reply.outcome === 'accepted') this.report.acceptedGifts += 1;
    else if (reply.outcome === 'already_collected') this.report.duplicateGifts += 1;
    else { this.giftRequested = false; if (reply.outcome !== 'out_of_range') throw new Error(`Gift interaction: ${reply.outcome}`); }
  }

  tryCollectGift(objectId: string): void {
    void this.collectGift(objectId).catch((error: unknown) => {
      this.report.error(error instanceof Error ? error.message : 'Gift request failed');
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    this.expectedClose = true;
    socket.close();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1200);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
}
