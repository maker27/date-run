import { LEVEL, type LevelDefinition } from '../../shared/level.js';
import type { Credential, PlayerBody, RejoinState, Role, RoomPreview, ThemeId, WorldSnapshot } from '../../shared/model.js';
import { normalizeRoomCode } from '../../shared/room-code.js';
import type { ClientRequest, ServerEvent, ServerReply, Unsubscribe } from '../../shared/protocol.js';
import { INTERPOLATION_DELAY_MS, STEP_SECONDS } from '../../shared/timing.js';
import { InputController } from '../game/input.js';
import { findOwnInteractable } from '../game/interactions.js';
import { FinishPresenter } from '../game/finish-sequence.js';
import type { SceneFactory, ScenePort } from '../game/scene-port.js';
import { appUrls } from '../platform/app-urls.js';
import { createRequestId } from '../platform/request-id.js';
import { RoomApi, RoomApiError } from './room-api.js';
import { ClockSync } from '../realtime/clock-sync.js';
import { CredentialStore } from '../realtime/credentials.js';
import { Prediction } from '../realtime/prediction.js';
import { SnapshotBuffer } from '../realtime/snapshot-buffer.js';
import { SocketClient, SocketClientError } from '../realtime/socket-client.js';
import { projectUi, sameUiSummary, type UiContext, type UiErrorCode, type UiSummary } from './ui-summary.js';

export type TransportPort = Pick<SocketClient, 'connect' | 'request' | 'sendInput' | 'onEvent' | 'onStatus' | 'disconnect' | 'destroy' | 'status'>;
export type InputPort = Pick<InputController, 'read' | 'onInteract' | 'reset' | 'destroy'>;
export interface VisibilityPort extends Pick<EventTarget, 'addEventListener' | 'removeEventListener'> { readonly visibilityState: DocumentVisibilityState }
export class GameSessionError extends Error {
  constructor(readonly code: UiErrorCode) { super(code); this.name = 'GameSessionError'; }
}

function safeError(error: unknown): UiErrorCode {
  if (error instanceof GameSessionError || error instanceof RoomApiError) return error.code;
  if (error instanceof SocketClientError) {
    return error.code === 'timeout' ? 'timeout' : error.code === 'aborted' ? 'aborted' : 'network_error';
  }
  return 'unexpected_error';
}

export class GameSession {
  private readonly transport: TransportPort;
  private readonly credentials: CredentialStore;
  private readonly roomApi: RoomApi;
  private readonly input: InputPort;
  private readonly sceneFactory: SceneFactory | null;
  private readonly clock: () => number;
  private readonly visibility: VisibilityPort;
  private readonly requestId: () => string;
  private readonly level: LevelDefinition;
  private readonly buffer = new SnapshotBuffer();
  private readonly sync = new ClockSync();
  private readonly finish: FinishPresenter;
  private readonly listeners = new Set<(summary: UiSummary) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private prediction: Prediction;
  private scene: ScenePort | null = null;
  private mountedScene: ScenePort | null = null;
  private readyScene: ScenePort | null = null;
  private loadedTheme: ThemeId | null = null;
  private sceneGeneration = 0;
  private preparingScene: number | null = null;
  private loadingSceneTheme: Promise<void> | null = null;
  private snapshot: WorldSnapshot | null = null;
  private credential: Credential | null = null;
  private context: UiContext;
  private summary: UiSummary;
  private generation = 0;
  private busy = false;
  private destroyed = false;
  private suspended = false;
  private resyncing = false;
  private contextLost = false;
  private authenticated = false;
  private lastFrame: number | null = null;
  private accumulator = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingInFlight: { roomId: string | undefined; epoch: number | undefined } | null = null;
  private operation: AbortController | null = null;
  private leaving: Promise<void> | null = null;
  private connectedOnce = false;
  private interaction: object | null = null;

  constructor(options: {
    origin?: string; transport?: TransportPort; credentials?: CredentialStore; roomApi?: RoomApi;
    input?: InputPort; sceneFactory?: SceneFactory; clock?: () => number;
    visibility?: VisibilityPort; level?: LevelDefinition; requestId?: () => string;
  } = {}) {
    const urls = appUrls(options.origin ?? location.origin);
    this.transport = options.transport ?? new SocketClient(urls.ws);
    this.credentials = options.credentials ?? new CredentialStore({
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
      removeItem: (key) => sessionStorage.removeItem(key),
    });
    this.roomApi = options.roomApi ?? new RoomApi(urls);
    this.clock = options.clock ?? (() => performance.now());
    this.visibility = options.visibility ?? document;
    this.level = options.level ?? LEVEL;
    this.finish = new FinishPresenter(this.level);
    this.requestId = options.requestId ?? createRequestId;
    this.sceneFactory = options.sceneFactory ?? null;
    this.prediction = this.newPrediction();
    this.input = options.input ?? new InputController({ touchRoot: document.body, enabled: () => this.canInput() });
    this.context = { connection: this.transport.status, loading: false, error: null, storageWarning: false, closing: null, sceneReady: false, resultsVisible: false };
    this.summary = projectUi(null, null, this.context);
    this.unsubs.push(this.transport.onEvent(this.onEvent), this.transport.onStatus(this.onStatus));
    this.unsubs.push(this.credentials.onWarning(() => this.updateContext({ storageWarning: true })));
    this.unsubs.push(this.input.onInteract(() => { void this.interact(); }));
    this.visibility.addEventListener('visibilitychange', this.onVisibility);
    const saved = this.credentials.read();
    const invitation = new URLSearchParams(location.search).get('room');
    if (saved && (invitation === null || normalizeRoomCode(invitation) === saved.roomId)) {
      this.credential = saved;
      void this.rejoin();
    }
  }

  subscribeUi(listener: (summary: UiSummary) => void): Unsubscribe {
    this.listeners.add(listener);
    listener(this.summary);
    return () => this.listeners.delete(listener);
  }

  async preview(code: string, signal?: AbortSignal): Promise<RoomPreview> {
    try { return await this.roomApi.preview(code, signal); }
    catch (error) { throw new GameSessionError(safeError(error)); }
  }

  create(themeId: ThemeId, role: Role): Promise<void> {
    return this.runAction(() => this.joinCommand({ version: 1, type: 'room:create', requestId: this.requestId(), themeId, role }));
  }

  join(code: string): Promise<void> {
    const roomId = normalizeRoomCode(code);
    if (!roomId) { this.updateContext({ error: 'invalid_message' }); return Promise.resolve(); }
    return this.runAction(() => this.joinCommand({ version: 1, type: 'room:join', requestId: this.requestId(), roomId }));
  }

  setReady(ready: boolean): Promise<void> {
    if (ready && (this.summary.screen !== 'lobby' || !this.summary.sceneReady || this.summary.error !== null)) {
      this.updateContext({ error: 'invalid_phase' });
      return Promise.resolve();
    }
    return this.runAction(() => this.command({ version: 1, type: 'player:ready', requestId: this.requestId(), ready }));
  }
  configure(themeId: ThemeId, role: Role): Promise<void> {
    if (this.summary.screen !== 'lobby' || !this.summary.isHost || this.summary.players.some((player) => player.ready)) {
      this.updateContext({ error: 'invalid_phase' });
      return Promise.resolve();
    }
    return this.runAction(() => this.command({ version: 1, type: 'room:configure', requestId: this.requestId(), themeId, hostRole: role }));
  }
  rematch(): Promise<void> { return this.runAction(() => this.command({ version: 1, type: 'room:rematch', requestId: this.requestId() })); }
  backToLobby(): Promise<void> { return this.runAction(() => this.command({ version: 1, type: 'room:reset', requestId: this.requestId() })); }

  leave(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.leaving) return this.leaving;
    const leaving = this.performLeave();
    this.leaving = leaving;
    void leaving.then(() => { if (this.leaving === leaving) this.leaving = null; }, () => { if (this.leaving === leaving) this.leaving = null; });
    return leaving;
  }

  private async performLeave(): Promise<void> {
    const canRequest = this.authenticated && this.credential !== null && this.transport.status === 'connected';
    this.generation += 1;
    this.operation?.abort();
    this.operation = null;
    this.busy = true;
    this.stopPing();
    this.clearSession(null);
    this.credentials.clear();
    this.updateContext({ loading: true, error: null, closing: null });
    try {
      if (canRequest) await this.transport.request({ version: 1, type: 'room:leave', requestId: this.requestId() });
    } catch (error) {
      if (!this.destroyed) this.updateContext({ error: safeError(error) });
    } finally {
      this.transport.disconnect();
      this.busy = false;
      if (!this.destroyed) this.updateContext({ loading: false });
      if (typeof history !== 'undefined' && location.search) history.replaceState(history.state, '', location.pathname);
    }
  }

  async retry(): Promise<void> {
    if (this.authenticated && this.context.error === null && this.summary.sceneReady) return;
    if (this.suspended && this.authenticated) await this.resync();
    else if (this.authenticated && this.context.error === 'graphics_error') {
      if (this.summary.sceneReady) this.updateContext({ error: null });
      return;
    }
    else if (this.credential) {
      if (this.authenticated) this.transport.disconnect();
      await this.rejoin();
    }
    else this.updateContext({ error: null });
  }

  async interact(): Promise<void> {
    const snapshot = this.snapshot;
    if (this.interaction || !this.canInput() || !snapshot || !this.credential) return;
    const objectId = findOwnInteractable(snapshot, this.credential.playerId, this.level);
    if (!objectId) return;
    const active = {};
    this.interaction = active;
    const generation = this.generation;
    try {
      const reply = await this.transport.request({ version: 1, type: 'world:interact', requestId: this.requestId(), epoch: snapshot.epoch, objectId });
      if (this.interaction !== active || generation !== this.generation || this.destroyed) return;
      if (reply.type === 'error') throw new GameSessionError(reply.code);
      if (reply.type !== 'world:interact:result') this.updateContext({ error: 'invalid_response' });
      if (reply.type === 'world:interact:result' && reply.outcome !== 'accepted' && reply.outcome !== 'already_collected') {
        this.updateContext({ error: 'interaction_failed' });
      }
    } catch (error) {
      if (this.interaction !== active || generation !== this.generation || this.destroyed) return;
      if (error instanceof SocketClientError && error.code === 'timeout') void this.resync();
      else this.handleError(error);
    } finally { if (this.interaction === active) this.interaction = null; }
  }

  async attachScene(container: HTMLElement): Promise<void> {
    if (this.destroyed || this.scene || this.preparingScene === this.sceneGeneration) return;
    const generation = this.sceneGeneration;
    this.preparingScene = generation;
    let factory = this.sceneFactory;
    if (!factory) {
      try {
        const { GameScene } = await import('../game/game-scene.js');
        if (this.destroyed || generation !== this.sceneGeneration) return;
        factory = (hooks) => new GameScene(hooks, { level: this.level });
      } catch {
        if (this.preparingScene === generation) this.preparingScene = null;
        if (!this.destroyed && generation === this.sceneGeneration) this.updateContext({ error: 'graphics_error', sceneReady: false });
        return;
      }
    }
    this.preparingScene = null;
    const scene = factory({
      onFrame: (now) => { if (this.scene === scene && this.readyScene === scene) this.onFrame(now); },
      onError: () => { if (this.scene === scene) this.updateContext({ error: 'graphics_error', sceneReady: false }); },
      onContextLost: () => {
        if (this.scene !== scene) return;
        this.contextLost = true;
        this.pauseLocal();
        this.suspend();
        this.updateContext({ error: 'graphics_error', sceneReady: false });
      },
      onContextRestored: () => {
        if (this.scene !== scene) return;
        this.contextLost = false;
        if (this.snapshot?.state.phase === 'playing' || this.snapshot?.state.phase === 'complete') void this.resync();
        else this.updateContext({ error: null, sceneReady: this.loadedTheme === this.snapshot?.state.themeId && this.readyScene === scene });
      },
    });
    this.scene = scene;
    try {
      await scene.mount(container);
      if (this.destroyed || generation !== this.sceneGeneration || this.scene !== scene) { scene.destroy(); return; }
      this.mountedScene = scene;
      if (this.snapshot) await this.prepareSceneTheme(scene, generation);
    } catch {
      if (!this.destroyed && this.scene === scene) this.updateContext({ error: 'graphics_error', sceneReady: false });
      scene.destroy();
      if (this.scene === scene) this.scene = null;
      if (this.mountedScene === scene) this.mountedScene = null;
      if (this.readyScene === scene) this.readyScene = null;
      this.loadedTheme = null;
    }
  }

  detachScene(): void {
    this.sceneGeneration += 1;
    this.preparingScene = null;
    this.loadingSceneTheme = null;
    this.pauseLocal();
    this.scene?.destroy();
    this.scene = null;
    this.mountedScene = null;
    this.readyScene = null;
    this.loadedTheme = null;
    this.contextLost = false;
    this.updateContext({ sceneReady: false });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.sceneGeneration += 1;
    this.preparingScene = null;
    this.loadingSceneTheme = null;
    this.operation?.abort();
    this.stopPing();
    this.finish.destroy();
    this.visibility.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubs.forEach((unsubscribe) => unsubscribe());
    this.input.destroy();
    this.scene?.destroy();
    this.scene = null;
    this.mountedScene = null;
    this.readyScene = null;
    this.loadedTheme = null;
    this.transport.destroy();
    this.listeners.clear();
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!this.destroyed) this.handleError(error);
    }
  }

  private async joinCommand(message: Extract<ClientRequest, { type: 'room:create' | 'room:join' }>): Promise<void> {
    if (this.leaving) await this.leaving;
    if (this.destroyed) return;
    if (this.busy) { this.updateContext({ error: 'busy' }); return; }
    this.busy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.operation = controller;
    this.authenticated = false;
    this.updateContext({ loading: true, error: null });
    try {
      await this.transport.connect(controller.signal);
      if (generation !== this.generation || this.destroyed) return;
      const reply = await this.transport.request(message, controller.signal);
      if (generation !== this.generation || this.destroyed) return;
      if (reply.type === 'error') throw new GameSessionError(reply.code);
      if (reply.type !== 'room:joined') throw new GameSessionError('invalid_response');
      this.installJoined(reply);
    } catch (error) {
      if (generation === this.generation && !this.destroyed) {
        this.transport.disconnect();
        this.handleError(error);
      }
    } finally {
      if (generation === this.generation && !this.destroyed) this.updateContext({ loading: false });
      if (this.operation === controller) { this.busy = false; this.operation = null; }
    }
  }

  private async rejoin(): Promise<void> {
    const credential = this.credential;
    if (!credential || this.destroyed || this.busy) return;
    this.busy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.operation = controller;
    this.authenticated = false;
    this.pauseLocal();
    this.updateContext({ loading: true, error: null });
    try {
      await this.transport.connect(controller.signal);
      if (generation !== this.generation || this.destroyed) return;
      const reply = await this.transport.request({ version: 1, type: 'room:rejoin', requestId: this.requestId(), sessionToken: credential.sessionToken }, controller.signal);
      if (generation !== this.generation || this.destroyed) return;
      if (reply.type === 'error') throw new GameSessionError(reply.code);
      if (reply.type !== 'room:joined') throw new GameSessionError('invalid_response');
      this.installJoined(reply);
    } catch (error) { if (generation === this.generation && !this.destroyed) this.handleError(error); }
    finally {
      if (generation === this.generation && !this.destroyed) this.updateContext({ loading: false });
      if (this.operation === controller) { this.busy = false; this.operation = null; }
    }
  }

  private installJoined(reply: Extract<ServerReply, { type: 'room:joined' }>): void {
    const savedNext = this.credential?.roomId === reply.credential.roomId && this.credential.playerId === reply.credential.playerId
      ? this.credential.nextSeq : 1;
    this.credential = { ...reply.credential, nextSeq: Math.max(savedNext, reply.rejoinState.nextSeq) };
    this.credentials.write(this.credential);
    this.authenticated = true;
    this.interaction = null;
    this.snapshot = null;
    this.finish.reset();
    this.context.resultsVisible = false;
    this.pingInFlight = null;
    this.connectedOnce = true;
    this.sync.reset();
    this.buffer.reset({ roomId: reply.snapshot.roomId, epoch: reply.snapshot.epoch });
    this.prediction = this.newPrediction();
    this.suspended = false;
    if (this.readyScene) this.readyScene.setLocalPlayer(this.credential.playerId);
    this.applySnapshot(reply.snapshot, true);
    if (this.visibility.visibilityState !== 'visible' || this.contextLost) this.suspend();
    this.startPing();
  }

  private async command(message: ClientRequest): Promise<void> {
    if (this.busy) { this.updateContext({ error: 'busy' }); return; }
    if (!this.authenticated) { this.updateContext({ error: 'network_error' }); return; }
    this.busy = true;
    const generation = this.generation;
    try {
      const reply = await this.request(message);
      if (reply?.type === 'command:result') this.updateContext({ error: reply.command === message.type ? null : 'invalid_response' });
      else if (reply) this.updateContext({ error: 'invalid_response' });
    } finally { if (generation === this.generation) this.busy = false; }
  }

  private async request(message: ClientRequest): Promise<ServerReply | null> {
    if (this.destroyed) return null;
    const generation = this.generation;
    try {
      const reply = await this.transport.request(message);
      if (generation !== this.generation || this.destroyed) return null;
      if (reply.type === 'error') throw new GameSessionError(reply.code);
      return reply;
    } catch (error) { if (generation === this.generation && !this.destroyed) this.handleError(error); return null; }
  }

  private applySnapshot(snapshot: WorldSnapshot, control = false): void {
    if (!this.credential || snapshot.roomId !== this.credential.roomId) return;
    if (this.snapshot && snapshot.epoch < this.snapshot.epoch) return;
    if (this.snapshot && snapshot.epoch !== this.snapshot.epoch) {
      if (!control) return;
      this.buffer.reset({ roomId: snapshot.roomId, epoch: snapshot.epoch });
      this.prediction = this.newPrediction();
      this.sync.reset();
      this.interaction = null;
      this.finish.reset();
      this.context.resultsVisible = false;
      this.scene?.applyFinish(this.finish.apply(snapshot, null));
    }
    if (!this.buffer.push(snapshot)) return;
    this.snapshot = snapshot;
    if (snapshot.state.phase !== 'complete') {
      this.finish.reset();
      this.context.resultsVisible = false;
      this.scene?.applyFinish(this.finish.apply(snapshot, null));
    }
    if (this.loadedTheme !== snapshot.state.themeId) {
      this.readyScene = null;
      this.updateContext({ sceneReady: false });
    }
    const own = snapshot.state.players.find(({ id }) => id === this.credential?.playerId);
    if (!own) return;
    if (this.credential.nextSeq <= own.lastAcceptedSeq) this.persistSeq(own.lastAcceptedSeq + 1);
    if (snapshot.state.phase !== 'playing' || snapshot.state.paused) this.prediction.reset(own.body, own.inputGeneration);
    else if (this.prediction.pendingCount === 0 && this.suspended) this.prediction.reset(own.body, own.inputGeneration);
    const body = this.prediction.reconcile(snapshot, own.id);
    if (this.mountedScene && !this.readyScene && !this.loadingSceneTheme) void this.prepareSceneTheme(this.mountedScene, this.sceneGeneration);
    this.applyScene(snapshot, body);
    this.publish();
    this.refreshScenePause();
    if (snapshot.state.phase === 'complete' && this.sync.serverNow(this.clock()) === null) void this.ping();
  }

  private applyScene(snapshot: WorldSnapshot, body?: PlayerBody): void {
    if (!this.scene || this.readyScene !== this.scene || !this.credential) return;
    this.scene.applyWorld(snapshot);
    this.scene.setLocalBody(body ?? this.prediction.body);
  }

  private prepareSceneTheme(scene: ScenePort, generation: number): Promise<void> {
    if (this.loadingSceneTheme) return this.loadingSceneTheme;
    const pending = (async () => {
      try {
        while (this.snapshot && !this.destroyed && generation === this.sceneGeneration && this.scene === scene) {
          const themeId = this.snapshot.state.themeId;
          await scene.setTheme(themeId);
          if (this.destroyed || generation !== this.sceneGeneration || this.scene !== scene) return;
          if (this.snapshot.state.themeId !== themeId) continue;
          this.loadedTheme = themeId;
          this.readyScene = scene;
          if (this.credential) scene.setLocalPlayer(this.credential.playerId);
          this.applyScene(this.snapshot);
          this.updateContext({ sceneReady: !this.contextLost, error: this.context.error === 'graphics_error' ? null : this.context.error });
          this.refreshScenePause();
          if (this.suspended && !this.resyncing && this.visibility.visibilityState === 'visible') void this.resync();
          return;
        }
      } catch {
        if (this.destroyed || generation !== this.sceneGeneration || this.scene !== scene) return;
        this.updateContext({ error: 'graphics_error', sceneReady: false });
        scene.destroy();
        this.scene = null;
        this.mountedScene = null;
        this.readyScene = null;
        this.loadedTheme = null;
      }
    })();
    this.loadingSceneTheme = pending;
    void pending.finally(() => { if (this.loadingSceneTheme === pending) this.loadingSceneTheme = null; });
    return pending;
  }

  private onFrame(now: number): void {
    if (this.snapshot?.state.phase === 'complete' && this.canPresent()) {
      const view = this.finish.apply(this.snapshot, this.sync.serverNow(now));
      this.scene?.applyFinish(view);
      if (this.context.resultsVisible !== view.resultsVisible) this.updateContext({ resultsVisible: view.resultsVisible });
    }
    if (!this.canInput()) { this.lastFrame = null; this.accumulator = 0; return; }
    const previous = this.lastFrame;
    this.lastFrame = now;
    if (previous === null) return;
    this.accumulator = Math.min(this.accumulator + Math.max(0, now - previous) / 1000, 5 * STEP_SECONDS);
    let steps = 0;
    while (this.accumulator >= STEP_SECONDS - 0.000001 && steps < 5 && this.canInput()) {
      this.accumulator -= STEP_SECONDS;
      steps += 1;
      if (!this.credential || !this.snapshot) return;
      if (this.prediction.pendingCount >= 120) { void this.resync(); break; }
      const seq = this.credential.nextSeq;
      this.persistSeq(seq + 1);
      const input = this.input.read();
      const own = this.snapshot.state.players.find(({ id }) => id === this.credential?.playerId);
      if (!own) return;
      try {
        this.transport.sendInput({ version: 1, type: 'input:update', epoch: this.snapshot.epoch, inputGeneration: own.inputGeneration, seq, input });
        this.scene?.setLocalBody(this.prediction.predict(seq, input));
      } catch (error) { this.handleError(error); this.pauseLocal(); break; }
    }
    const serverNow = this.sync.serverNow(now);
    if (serverNow !== null) {
      const rendered = this.buffer.sample(serverNow - INTERPOLATION_DELAY_MS);
      if (rendered) this.scene?.setRemoteBodies(rendered.players);
    }
  }

  private persistSeq(nextSeq: number): void {
    if (!this.credential) return;
    this.credential = { ...this.credential, nextSeq };
    this.credentials.write(this.credential);
  }

  private async resync(): Promise<void> {
    if (this.resyncing || !this.credential || !this.authenticated || this.transport.status !== 'connected' || this.destroyed) return;
    const generation = this.generation;
    this.resyncing = true;
    this.pauseLocal();
    const reply = await this.request({ version: 1, type: 'room:resync', requestId: this.requestId() });
    if (generation !== this.generation || this.destroyed) return;
    if (reply?.type === 'room:resynced') {
      this.installResync(reply);
      this.suspended = false;
      if (this.visibility.visibilityState !== 'visible' || this.contextLost) this.suspend();
      this.updateContext({ error: null, sceneReady: this.scene !== null && this.mountedScene === this.scene && this.readyScene === this.scene && this.loadedTheme === this.snapshot?.state.themeId && !this.contextLost });
    } else {
      this.suspended = true;
      if (reply) this.updateContext({ error: 'invalid_response' });
    }
    this.resyncing = false;
    this.lastFrame = null;
    this.refreshScenePause();
  }

  private installResync(reply: Extract<ServerReply, { type: 'room:resynced' }>): void {
    this.mergeRejoin(reply.rejoinState, reply.snapshot);
    this.buffer.reset({ roomId: reply.snapshot.roomId, epoch: reply.snapshot.epoch });
    this.prediction = this.newPrediction();
    this.applySnapshot(reply.snapshot, true);
  }

  private mergeRejoin(state: RejoinState, snapshot: WorldSnapshot): void {
    if (!this.credential) return;
    const own = snapshot.state.players.find(({ id }) => id === this.credential?.playerId);
    this.persistSeq(Math.max(this.credential.nextSeq, state.nextSeq, (own?.lastAcceptedSeq ?? 0) + 1));
  }

  private suspend(): void {
    if (this.suspended || !this.snapshot || !this.authenticated || this.transport.status !== 'connected' || this.snapshot.state.phase !== 'playing') return;
    this.suspended = true;
    this.pauseLocal();
    const epoch = this.snapshot.epoch;
    void this.request({ version: 1, type: 'player:suspend', requestId: this.requestId(), epoch }).then((reply) => {
      if (reply?.type === 'room:resynced') this.installResync(reply);
      else if (reply) this.updateContext({ error: 'invalid_response' });
    });
  }

  private pauseLocal(): void { this.input.reset(); this.lastFrame = null; this.accumulator = 0; this.scene?.setPaused(true); }
  private refreshScenePause(): void { this.scene?.setPaused(!this.canInput() && !this.canPresent()); }
  private canPresent(): boolean {
    return !this.destroyed && this.scene !== null && this.readyScene === this.scene && this.credential !== null && this.authenticated
      && this.transport.status === 'connected' && this.snapshot?.state.phase === 'complete'
      && this.visibility.visibilityState === 'visible' && !this.suspended && !this.resyncing && !this.contextLost;
  }
  private canInput(): boolean {
    return !this.destroyed && this.scene !== null && this.readyScene === this.scene && this.credential !== null && this.authenticated
      && this.transport.status === 'connected' && this.snapshot?.state.phase === 'playing'
      && !this.snapshot.state.paused && this.visibility.visibilityState === 'visible'
      && !this.suspended && !this.resyncing && !this.contextLost;
  }

  private readonly onVisibility = (): void => {
    if (this.visibility.visibilityState === 'hidden') this.suspend();
    else if (this.suspended) void this.resync();
    this.refreshScenePause();
  };

  private readonly onStatus = (status: TransportPort['status']): void => {
    if (this.destroyed) return;
    this.updateContext({ connection: status });
    if (status !== 'connected') { this.authenticated = false; this.stopPing(); this.pauseLocal(); }
    if (status === 'connected' && this.connectedOnce && this.credential && !this.busy) void this.rejoin();
  };

  private readonly onEvent = (event: ServerEvent): void => {
    if (this.destroyed) return;
    switch (event.type) {
      case 'room:state': case 'round:start': case 'room:complete': this.updateContext({ closing: null }); this.applySnapshot(event.snapshot, true); break;
      case 'world:update': this.applySnapshot(event.snapshot); break;
      case 'room:closing': this.updateContext({ closing: event.reason }); if (event.reason === 'restart') this.sync.reset(); break;
      case 'session:replaced': this.invalidate('session_replaced'); break;
      case 'error':
        if (event.code === 'invalid_phase' && this.snapshot?.state.phase === 'complete') break;
        this.handleError(new GameSessionError(event.code));
        break;
    }
  };

  private startPing(): void {
    this.stopPing();
    void this.ping();
    this.pingTimer = setInterval(() => { void this.ping(); }, 5000);
  }
  private stopPing(): void { if (this.pingTimer !== null) clearInterval(this.pingTimer); this.pingTimer = null; }

  private async ping(): Promise<void> {
    if (!this.credential || this.transport.status !== 'connected') return;
    const generation = this.generation;
    const epoch = this.snapshot?.epoch;
    const roomId = this.snapshot?.roomId;
    const pending = this.pingInFlight;
    if (pending && pending.roomId === roomId && pending.epoch === epoch) return;
    const active = { roomId, epoch };
    this.pingInFlight = active;
    const sentAt = this.clock();
    try {
      const reply = await this.request({ version: 1, type: 'time:ping', requestId: this.requestId(), clientTime: sentAt });
      if (this.pingInFlight !== active || generation !== this.generation || epoch !== this.snapshot?.epoch || roomId !== this.snapshot?.roomId) return;
      if (reply?.type === 'time:pong') this.sync.record(sentAt, this.clock(), reply.serverTime);
      else if (reply) this.updateContext({ error: 'invalid_response' });
    } finally { if (this.pingInFlight === active) this.pingInFlight = null; }
  }

  private handleError(error: unknown): void {
    const code = safeError(error);
    if (code === 'session_expired' || code === 'room_not_found') { this.invalidate(code); return; }
    if (code === 'queue_full' || code === 'stale_input_generation' || code === 'stale_epoch') { void this.resync(); return; }
    if (code !== 'aborted') this.updateContext({ error: code });
  }

  private invalidate(code: UiErrorCode): void {
    this.generation += 1;
    this.operation?.abort();
    this.stopPing();
    this.clearSession(code);
    this.credentials.clear();
    this.transport.disconnect();
  }

  private clearSession(error: UiErrorCode | null): void {
    this.authenticated = false;
    this.credential = null;
    this.snapshot = null;
    this.interaction = null;
    this.pingInFlight = null;
    this.finish.reset();
    this.context.resultsVisible = false;
    this.connectedOnce = false;
    this.suspended = false;
    this.resyncing = false;
    this.sync.reset();
    this.prediction = this.newPrediction();
    this.pauseLocal();
    this.updateContext({ loading: false, error, closing: null, sceneReady: false });
  }

  private newPrediction(): Prediction { return new Prediction(this.level, () => { void this.resync(); }); }
  private updateContext(change: Partial<UiContext>): void { this.context = { ...this.context, ...change }; this.publish(); }
  private publish(): void {
    if (this.destroyed) return;
    const summary = projectUi(this.snapshot, this.credential?.playerId ?? null, this.context);
    if (sameUiSummary(summary, this.summary)) return;
    this.summary = summary;
    for (const listener of this.listeners) listener(summary);
  }
}
