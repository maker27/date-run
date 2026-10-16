import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSnapshot, localPlayerId, peerPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import type { Credential, PlayerBody, PlayerInput, WorldSnapshot } from '../../shared/model.js';
import { ClientMessageSchema, type ClientRequest, type InputUpdate, type ServerEvent, type ServerReply, type Unsubscribe } from '../../shared/protocol.js';
import { CredentialStore } from '../realtime/credentials.js';
import { SocketClientError } from '../realtime/socket-client.js';
import type { SceneFactory, SceneHooks, ScenePort } from '../game/scene-port.js';
import { GameSession, type TransportPort, type VisibilityPort } from './game-session.js';
import type { UiSummary } from './ui-summary.js';

const sessions: GameSession[] = [];

function trackedSession(options: NonNullable<ConstructorParameters<typeof GameSession>[0]>): GameSession {
  const session = new GameSession(options);
  sessions.push(session);
  return session;
}

class TestTransport implements TransportPort {
  status: TransportPort['status'] = 'closed';
  readonly requests: ClientRequest[] = [];
  readonly inputs: InputUpdate[] = [];
  private readonly pending = new Map<string, { resolve: (reply: ServerReply) => void; reject: (error: Error) => void }>();
  private readonly events = new Set<(event: ServerEvent) => void>();
  private readonly statuses = new Set<(status: TransportPort['status']) => void>();
  destroyed = false;
  connectCalls = 0;
  disconnectCalls = 0;

  constructor(private readonly trace: string[] = []) {}

  connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = 'connected';
    this.statuses.forEach((listener) => listener(this.status));
    return Promise.resolve();
  }

  request(message: ClientRequest): Promise<ServerReply> {
    this.requests.push(message);
    return new Promise((resolve, reject) => this.pending.set(message.requestId, { resolve, reject }));
  }

  sendInput(message: InputUpdate): void { this.trace.push('send'); this.inputs.push(message); }
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe { this.events.add(listener); return () => this.events.delete(listener); }
  onStatus(listener: (status: TransportPort['status']) => void): Unsubscribe {
    this.statuses.add(listener);
    listener(this.status);
    return () => this.statuses.delete(listener);
  }
  disconnect(): void { this.disconnectCalls += 1; this.setStatus('closed'); }
  destroy(): void { this.destroyed = true; this.disconnect(); this.events.clear(); this.statuses.clear(); }

  reply(reply: ServerReply): void {
    if (!('requestId' in reply) || !reply.requestId) throw new Error('Test reply needs a request ID');
    const pending = this.pending.get(reply.requestId);
    if (!pending) throw new Error('No matching request is pending');
    this.pending.delete(reply.requestId);
    pending.resolve(reply);
  }

  reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('No matching request is pending');
    this.pending.delete(requestId);
    pending.reject(error);
  }

  setStatus(status: TransportPort['status']): void {
    this.status = status;
    this.statuses.forEach((listener) => listener(status));
  }

  emit(event: ServerEvent): void { this.events.forEach((listener) => listener(event)); }

  async waitForRequest(type: ClientRequest['type'], occurrence = 0): Promise<ClientRequest> {
    await expect.poll(() => this.requests.filter((message) => message.type === type).at(occurrence)).toBeDefined();
    const message = this.requests.filter((request) => request.type === type).at(occurrence);
    if (!message) throw new Error(`No ${type} request was sent`);
    return message;
  }
}

class TestVisibility extends EventTarget implements VisibilityPort {
  visibilityState: DocumentVisibilityState = 'visible';

  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class TestStorage {
  readonly trace: string[] = [];
  private value: string | null = null;
  failWrites = false;

  getItem(): string | null { return this.value; }
  seed(value: Credential): void { this.value = JSON.stringify(value); }
  storedValue(): string | null { return this.value; }
  setItem(_key: string, value: string): void {
    if (this.failWrites) throw new Error('storage unavailable');
    this.trace.push('persist');
    this.value = value;
  }
  removeItem(): void { this.trace.push('clear'); this.value = null; }
}

function credential(playerId: Credential['playerId'], nextSeq = 1, roomId: Credential['roomId'] = 'ABCD2345'): Credential {
  return {
    schemaVersion: 1,
    roomId,
    playerId,
    sessionToken: '00000000-0000-4000-8000-000000000099',
    nextSeq,
  };
}

function requestIds(): () => string {
  let next = 10;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
}

function snapshotForB(): WorldSnapshot {
  const snapshot = makeSnapshot();
  return {
    ...snapshot,
    state: {
      ...snapshot.state,
      hostId: localPlayerId,
      players: snapshot.state.players.map((player) => player.id === localPlayerId
        ? { ...player, id: peerPlayerId, role: 'b' }
        : { ...player, id: localPlayerId, role: 'a' }),
    },
  };
}

function snapshotForTheme(themeId: WorldSnapshot['state']['themeId']): WorldSnapshot {
  const snapshot = makeSnapshot();
  return { ...snapshot, state: { ...snapshot.state, themeId } };
}

function lobbySnapshot(): WorldSnapshot {
  const snapshot = makeSnapshot();
  return { ...snapshot, state: { ...snapshot.state, phase: 'lobby' } };
}

function joinedReply(requestId: string, playerId: Credential['playerId'], snapshot = makeSnapshot()): Extract<ServerReply, { type: 'room:joined' }> {
  return {
    version: 1,
    type: 'room:joined',
    requestId,
    credential: credential(playerId, 1, snapshot.roomId),
    rejoinState: { inputGeneration: 1, nextSeq: 1 },
    snapshot,
  };
}

function makeSceneHarness() {
  const calls: string[] = [];
  let hooks: SceneHooks | undefined;
  let worldCount = 0;
  const finishViews: Array<{ stage: string; exchange: boolean; resultsVisible: boolean }> = [];
  const localBodies: WorldSnapshot['state']['players'][number]['body'][] = [];
  const pausedStates: boolean[] = [];
  const scene: ScenePort = {
    async mount() { calls.push('mount'); },
    applyWorld() { calls.push('world'); worldCount += 1; },
    applyFinish(view: { stage: string; exchange: boolean; resultsVisible: boolean }) { finishViews.push(view); },
    setLocalPlayer() { calls.push('local-player'); },
    setLocalBody(body) { localBodies.push({ ...body }); },
    setRemoteBodies() {},
    setPaused(paused) { pausedStates.push(paused); },
    async setTheme() {},
    destroy() { calls.push('destroy'); },
  };
  return {
    calls,
    localBodies,
    pausedStates,
    finishViews,
    scene,
    factory: (sceneHooks: SceneHooks) => { hooks = sceneHooks; return scene; },
    bind(sceneHooks: SceneHooks) { hooks = sceneHooks; },
    frame(clientNow: number) {
      if (!hooks) throw new Error('Scene hooks are not mounted');
      hooks.onFrame(clientNow);
    },
    error(error: Error) {
      if (!hooks) throw new Error('Scene hooks are not mounted');
      hooks.onError(error);
    },
    contextLost() {
      if (!hooks) throw new Error('Scene hooks are not mounted');
      hooks.onContextLost();
    },
    contextRestored() {
      if (!hooks) throw new Error('Scene hooks are not mounted');
      hooks.onContextRestored();
    },
    get worldCount() { return worldCount; },
  };
}

function deferredMount() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: () => release?.() };
}

function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

async function waitForSceneReady(session: GameSession): Promise<void> {
  let sceneReady = false;
  const unsubscribe = session.subscribeUi((summary) => { sceneReady = summary.sceneReady; });
  try { await expect.poll(() => sceneReady).toBe(true); }
  finally { unsubscribe(); }
}

function makeInput(axis: PlayerInput['axis'] = 1) {
  return {
    read: () => ({ axis, jumpPressed: false }),
    onInteract: () => () => undefined,
    reset() {},
    destroy() {},
  };
}

afterEach(() => {
  sessions.splice(0).forEach((session) => session.destroy());
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('GameSession', () => {
  it('creates a room without crypto.randomUUID on an insecure origin', async () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues });
    const transport = new TestTransport();
    const session = trackedSession({ transport, credentials: new CredentialStore(new TestStorage()), input: makeInput() });
    const summaries: UiSummary[] = [];
    session.subscribeUi((summary) => summaries.push(summary));

    const creating = session.create('first-date', 'a');
    const request = await transport.waitForRequest('room:create');
    expect(ClientMessageSchema.safeParse(request).success).toBe(true);
    transport.reply(joinedReply(request.requestId, localPlayerId, lobbySnapshot()));
    await creating;

    expect(summaries.at(-1)?.screen).toBe('lobby');
    expect(summaries.at(-1)?.error).toBeNull();
  });

  it.each(['R2DSKQNL', 'invalid', ''])('keeps invitation %s visible instead of restoring another room', async (invitation) => {
    history.replaceState(null, '', `/?room=${encodeURIComponent(invitation)}`);
    const transport = new TestTransport();
    const storage = new TestStorage();
    storage.seed(credential(localPlayerId));
    const credentials = new CredentialStore(storage);
    const session = trackedSession({ transport, credentials, input: makeInput(), requestId: requestIds() });
    const summaries: UiSummary[] = [];
    session.subscribeUi((summary) => summaries.push(summary));
    expect(transport.connectCalls).toBe(0);
    expect(summaries.at(-1)?.screen).toBe('landing');
    expect(credentials.read()?.roomId).toBe('ABCD2345');
    const joining = session.join('R2DSKQNL');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, makeSnapshot({ roomId: 'R2DSKQNL' })));
    await joining;
    expect(summaries.at(-1)?.roomId).toBe('R2DSKQNL');
    expect(credentials.read()?.roomId).toBe('R2DSKQNL');
    expect(transport.requests.some(({ type }) => type === 'room:rejoin')).toBe(false);
  });

  it.each(['', '?room=ABCD2345', '?room=abcd2345'])('restores the saved player for a matching or absent invitation: %s', async (query) => {
    history.replaceState(null, '', `/${query}`);
    const transport = new TestTransport();
    const storage = new TestStorage();
    storage.seed(credential(localPlayerId));
    const session = trackedSession({ transport, credentials: new CredentialStore(storage), input: makeInput(), requestId: requestIds() });
    const summaries: UiSummary[] = [];
    session.subscribeUi((summary) => summaries.push(summary));
    const rejoin = await transport.waitForRequest('room:rejoin');
    transport.reply(joinedReply(rejoin.requestId, localPlayerId, lobbySnapshot()));
    await expect.poll(() => summaries.at(-1)?.roomId).toBe('ABCD2345');
    expect(transport.requests.some(({ type }) => type === 'room:join')).toBe(false);
  });

  it('keeps scene readiness false until mount and the current snapshot theme have both settled', async () => {
    const transport = new TestTransport();
    const mount = deferred<void>();
    const theme = deferred<void>();
    const calls: string[] = [];
    const scene: ScenePort = {
      async mount() { calls.push('mount'); await mount.promise; },
      async setTheme(themeId) { calls.push(`theme:${themeId}`); await theme.promise; },
      applyWorld() { calls.push('world'); },
      applyFinish() {},
      setLocalPlayer() {},
      setLocalBody() {},
      setRemoteBodies() {},
      setPaused() {},
      destroy() { calls.push('destroy'); },
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: () => scene,
      requestId: requestIds(),
    });
    const summaries: boolean[] = [];
    const unsubscribe = session.subscribeUi(({ sceneReady }) => summaries.push(sceneReady));
    const mounting = session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    expect(summaries.at(-1)).toBe(false);
    expect(calls).toEqual(['mount']);
    mount.resolve();
    await expect.poll(() => calls.at(-1)).toBe('theme:first-date');
    expect(summaries.at(-1)).toBe(false);
    theme.resolve();
    await mounting;

    expect(summaries.at(-1)).toBe(true);
    unsubscribe();
    session.destroy();
  });

  it('reloads and invalidates scene readiness when a mounted room changes theme', async () => {
    const transport = new TestTransport();
    const secondTheme = deferred<void>();
    const calls: string[] = [];
    const scene: ScenePort = {
      async mount() { calls.push('mount'); },
      async setTheme(themeId) {
        calls.push(`theme:${themeId}`);
        if (themeId === 'retro') await secondTheme.promise;
      },
      applyWorld() { calls.push('world'); },
      applyFinish() {},
      setLocalPlayer() {},
      setLocalBody() {},
      setRemoteBodies() {},
      setPaused() {},
      destroy() { calls.push('destroy'); },
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: () => scene,
      requestId: requestIds(),
    });
    const summaries: boolean[] = [];
    const unsubscribe = session.subscribeUi(({ sceneReady }) => summaries.push(sceneReady));
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;
    await expect.poll(() => calls.at(-1)).toBe('world');

    const changed = makeSnapshot({ tick: 2, revision: 1 });
    transport.emit({
      version: 1,
      type: 'world:update',
      snapshot: { ...changed, state: { ...changed.state, themeId: 'retro' } },
    });

    await expect.poll(() => calls.at(-1)).toBe('theme:retro');
    expect(summaries.at(-1)).toBe(false);
    secondTheme.resolve();
    await expect.poll(() => summaries.at(-1)).toBe(true);
    expect(calls.filter((call) => call.startsWith('theme:'))).toEqual(['theme:first-date', 'theme:retro']);
    unsubscribe();
    session.destroy();
  });

  it('does not publish ready when an old theme resolves while the selected theme is still loading', async () => {
    const transport = new TestTransport();
    const oldTheme = deferred<void>();
    const currentTheme = deferred<void>();
    const calls: string[] = [];
    const scene: ScenePort = {
      async mount() {},
      async setTheme(themeId) {
        calls.push(themeId);
        if (themeId === 'first-date') await oldTheme.promise;
        if (themeId === 'winter') await currentTheme.promise;
      },
      applyWorld() {},
      applyFinish() {},
      setLocalPlayer() {},
      setLocalBody() {},
      setRemoteBodies() {},
      setPaused() {},
      destroy() {},
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: () => scene,
      requestId: requestIds(),
    });
    const summaries: boolean[] = [];
    const unsubscribe = session.subscribeUi(({ sceneReady }) => summaries.push(sceneReady));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;
    const mounting = session.attachScene(document.createElement('div'));
    await expect.poll(() => calls.at(-1)).toBe('first-date');

    const changed = makeSnapshot({ tick: 2, revision: 1 });
    transport.emit({
      version: 1,
      type: 'world:update',
      snapshot: { ...changed, state: { ...changed.state, themeId: 'winter' } },
    });
    oldTheme.resolve();
    await expect.poll(() => calls.at(-1)).toBe('winter');
    expect(summaries.at(-1)).toBe(false);
    currentTheme.resolve();
    await mounting;
    expect(summaries.at(-1)).toBe(true);
    expect(calls).toEqual(['first-date', 'winter']);
    unsubscribe();
    session.destroy();
  });

  it.each(['local player', 'partner'] as const)('blocks host configuration while the %s is ready', async (readyPlayer) => {
    const transport = new TestTransport();
    const snapshot = makeSnapshot();
    const readySnapshot = {
      ...lobbySnapshot(),
      state: {
        ...snapshot.state,
        phase: 'ready' as const,
        players: snapshot.state.players.map((player) => ({
          ...player,
          ready: player.id === (readyPlayer === 'local player' ? localPlayerId : peerPlayerId),
        })),
      },
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      requestId: requestIds(),
    });
    const errors: Array<string | null> = [];
    const unsubscribe = session.subscribeUi(({ error }) => errors.push(error));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, readySnapshot));
    await joining;

    const configuring = session.configure('retro', 'b');
    await Promise.resolve();
    const configureRequest = transport.requests.find((request) => request.type === 'room:configure');
    if (configureRequest) {
      transport.reply({ version: 1, type: 'error', requestId: configureRequest.requestId, code: 'invalid_phase' });
    }
    await configuring;

    expect(transport.requests.some((request) => request.type === 'room:configure')).toBe(false);
    expect(errors.at(-1)).toBe('invalid_phase');
    unsubscribe();
    session.destroy();
  });

  it('does not send ready before a scene for the current theme has loaded', async () => {
    const transport = new TestTransport();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      requestId: requestIds(),
    });
    let error: string | null = null;
    const unsubscribe = session.subscribeUi((summary) => { error = summary.error; });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, lobbySnapshot()));
    await joining;

    const settingReady = session.setReady(true);
    await Promise.resolve();
    const readyRequest = transport.requests.find((request) => request.type === 'player:ready');
    if (readyRequest) transport.reply({ version: 1, type: 'error', requestId: readyRequest.requestId, code: 'invalid_phase' });
    await settingReady;

    expect(readyRequest).toBeUndefined();
    expect(error).toBe('invalid_phase');
    unsubscribe();
    session.destroy();
  });

  it('keeps real local prediction identical across first-date and winter themes', async () => {
    async function predictedBodies(themeId: WorldSnapshot['state']['themeId']): Promise<PlayerBody[]> {
      const transport = new TestTransport();
      const scene = makeSceneHarness();
      const inputs: PlayerInput[] = Array.from({ length: 80 }, (_unused, index) => ({
        axis: index < 18 ? 1 : 0,
        jumpPressed: index === 0,
      }));
      let inputIndex = 0;
      const input = makeInput();
      input.read = () => inputs[inputIndex++] ?? { axis: 0, jumpPressed: false };
      const session = trackedSession({
        transport,
        credentials: new CredentialStore(new TestStorage()),
        input,
        sceneFactory: scene.factory,
        requestId: requestIds(),
      });
      await session.attachScene(document.createElement('div'));
      const joining = session.join('ABCD2345');
      const join = await transport.waitForRequest('room:join');
      transport.reply(joinedReply(join.requestId, localPlayerId, snapshotForTheme(themeId)));
      await joining;

      scene.frame(0);
      for (let frame = 1; frame <= 65; frame += 1) scene.frame(frame * 17);

      return scene.localBodies;
    }

    const firstDateBodies = await predictedBodies('first-date');
    const winterBodies = await predictedBodies('winter');

    expect(winterBodies).toEqual(firstDateBodies);
    expect(winterBodies.some(({ y }) => y < 792)).toBe(true);
    expect(winterBodies.at(-1)?.grounded).toBe(true);
  });

  it('keeps input available after the winter theme is ready', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, snapshotForTheme('winter')));
    await joining;

    scene.frame(100);
    scene.frame(117);

    expect(transport.inputs).toHaveLength(1);
    expect(scene.localBodies.at(-1)?.x).toBeGreaterThan(100);
  });

  it('waits for a pending renderer mount before preparing the snapshot theme or accepting frames', async () => {
    const transport = new TestTransport();
    const mountBarrier = deferredMount();
    const themeBarrier = deferred<void>();
    const calls: string[] = [];
    let hooks: SceneHooks | undefined;
    const scene: ScenePort = {
      async mount() { calls.push('mount'); await mountBarrier.promise; },
      async setTheme(themeId) { calls.push(`theme:${themeId}`); await themeBarrier.promise; },
      applyWorld() { calls.push('world'); },
      applyFinish() {},
      setLocalPlayer() { calls.push('local-player'); },
      setLocalBody() {},
      setRemoteBodies() {},
      setPaused() {},
      destroy() { calls.push('destroy'); },
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: (sceneHooks) => { hooks = sceneHooks; return scene; },
      requestId: requestIds(),
    });
    const mounting = session.attachScene(document.createElement('div'));
    await expect.poll(() => calls.at(-1)).toBe('mount');
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    expect(calls).toEqual(['mount']);
    hooks?.onFrame(100);
    hooks?.onFrame(117);
    expect(transport.inputs).toHaveLength(0);

    mountBarrier.resolve();
    await expect.poll(() => calls.at(-1)).toBe('theme:first-date');
    hooks?.onFrame(200);
    hooks?.onFrame(217);
    expect(transport.inputs).toHaveLength(0);
    themeBarrier.resolve();
    await mounting;
    hooks?.onFrame(300);
    hooks?.onFrame(317);
    expect(transport.inputs).toHaveLength(1);
  });

  it('waits for the snapshot theme before applying the world or accepting scene input', async () => {
    const transport = new TestTransport();
    const themeLoad = deferred<void>();
    let hooks: SceneHooks | undefined;
    const calls: string[] = [];
    const scene: ScenePort = {
      async mount() { calls.push('mount'); },
      async setTheme(themeId) { calls.push(`theme:${themeId}`); await themeLoad.promise; },
      applyWorld() { calls.push('world'); },
      applyFinish() {},
      setLocalPlayer() { calls.push('local-player'); },
      setLocalBody() {},
      setRemoteBodies() {},
      setPaused() {},
      destroy() { calls.push('destroy'); },
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: (sceneHooks) => { hooks = sceneHooks; return scene; },
      requestId: requestIds(),
    });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    const mounting = session.attachScene(document.createElement('div'));
    await expect.poll(() => calls.at(-1)).toBe('theme:first-date');
    hooks?.onFrame(100);
    hooks?.onFrame(117);
    expect(calls).toEqual(['mount', 'theme:first-date']);
    expect(transport.inputs).toHaveLength(0);

    themeLoad.resolve();
    await mounting;
    expect(calls).toContain('world');
    hooks?.onFrame(200);
    hooks?.onFrame(217);
    expect(transport.inputs).toHaveLength(1);
  });

  it('reports a rejected theme load as graphics_error and permits a fresh scene retry', async () => {
    const transport = new TestTransport();
    const sceneRecords: Array<{ hooks: SceneHooks; calls: string[] }> = [];
    let shouldFail = true;
    const sceneFactory: SceneFactory = (hooks) => {
      const calls: string[] = [];
      const scene: ScenePort = {
        async mount() { calls.push('mount'); },
        async setTheme() {
          calls.push('theme');
          if (shouldFail) throw new Error('decode failure');
        },
        applyWorld() { calls.push('world'); },
        applyFinish() {},
        setLocalPlayer() {},
        setLocalBody() {},
        setRemoteBodies() {},
        setPaused() {},
        destroy() { calls.push('destroy'); },
      };
      sceneRecords.push({ hooks, calls });
      return scene;
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory,
      requestId: requestIds(),
    });
    const summaries: string[] = [];
    const unsubscribe = session.subscribeUi(({ error }) => { if (error) summaries.push(error); });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    await session.attachScene(document.createElement('div'));
    expect(summaries.at(-1)).toBe('graphics_error');
    expect(sceneRecords[0]?.calls).toEqual(['mount', 'theme', 'destroy']);
    expect(transport.inputs).toHaveLength(0);

    shouldFail = false;
    await session.attachScene(document.createElement('div'));
    await session.retry();
    expect(sceneRecords[1]?.calls).toEqual(['mount', 'theme', 'world']);
    expect(transport.requests.filter(({ type }) => type === 'room:rejoin')).toHaveLength(0);
    unsubscribe();
  });

  it('ignores a late theme completion after detach without disturbing the new scene owner', async () => {
    const transport = new TestTransport();
    const oldTheme = deferred<void>();
    const records: Array<{ hooks: SceneHooks; calls: string[] }> = [];
    const sceneFactory: SceneFactory = (hooks) => {
      const index = records.length;
      const calls: string[] = [];
      const scene: ScenePort = {
        async mount() { calls.push('mount'); },
        async setTheme() { calls.push('theme'); if (index === 0) await oldTheme.promise; },
        applyWorld() { calls.push('world'); },
        applyFinish() {},
        setLocalPlayer() {},
        setLocalBody() {},
        setRemoteBodies() {},
        setPaused() {},
        destroy() { calls.push('destroy'); },
      };
      records.push({ hooks, calls });
      return scene;
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory,
      requestId: requestIds(),
    });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    const staleMount = session.attachScene(document.createElement('div'));
    await expect.poll(() => records[0]?.calls.at(-1)).toBe('theme');
    session.detachScene();
    await session.attachScene(document.createElement('div'));
    expect(records[1]?.calls).toContain('world');
    oldTheme.resolve();
    await staleMount;

    expect(records[0]?.calls).toEqual(['mount', 'theme', 'destroy']);
    expect(records[1]?.calls).toContain('world');
    records[1]?.hooks.onFrame(100);
    records[1]?.hooks.onFrame(117);
    expect(transport.inputs).toHaveLength(1);
  });

  it.each(['session_expired', 'room_not_found'] as const)(
    'clears an expired startup credential and allows a fresh create after %s',
    async (code) => {
      const transport = new TestTransport();
      const storage = new TestStorage();
      storage.seed(credential(localPlayerId));
      const credentials = new CredentialStore(storage);
      const session = trackedSession({ transport, credentials, input: makeInput(), requestId: requestIds() });
      try {
        const summaries: Array<{ screen: string; loading: boolean; error: string | null }> = [];
        const unsubscribe = session.subscribeUi(({ screen, loading, error }) => summaries.push({ screen, loading, error }));
        const rejoin = await transport.waitForRequest('room:rejoin');
        transport.reply({ version: 1, type: 'error', requestId: rejoin.requestId, code });

        await expect.poll(() => summaries.at(-1)?.loading).toBe(false);
        expect(credentials.read()).toBeNull();
        expect(summaries.at(-1)).toEqual({ screen: 'landing', loading: false, error: code });

        const creating = session.create('first-date', 'a');
        const create = await transport.waitForRequest('room:create');
        const snapshot = makeSnapshot();
        const lobby = { ...snapshot, state: { ...snapshot.state, phase: 'lobby' as const } };
        transport.reply(joinedReply(create.requestId, localPlayerId, lobby));
        await creating;
        expect(summaries.at(-1)?.screen).toBe('lobby');
        unsubscribe();
      } finally {
        session.destroy();
      }
    },
  );

  it('resumes after visibility suspend and disconnected rejoin complete in order', async () => {
    const transport = new TestTransport();
    const visibility = new TestVisibility();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      visibility,
      requestId: requestIds(),
    });
    try {
      await session.attachScene(document.createElement('div'));
      const joining = session.join('ABCD2345');
      const join = await transport.waitForRequest('room:join');
      transport.reply(joinedReply(join.requestId, localPlayerId));
      await joining;

      visibility.set('hidden');
      const suspend = await transport.waitForRequest('player:suspend');
      transport.reply({
        version: 1,
        type: 'room:resynced',
        requestId: suspend.requestId,
        rejoinState: { inputGeneration: 2, nextSeq: 1 },
        snapshot: makeSnapshot({ localGeneration: 2 }),
      });
      await expect.poll(() => scene.worldCount).toBe(2);

      transport.setStatus('closed');
      transport.setStatus('reconnecting');
      visibility.set('visible');
      const unpauseCount = scene.pausedStates.filter((paused) => !paused).length;
      scene.frame(10_000);
      expect(transport.requests.filter((request) => request.type === 'room:resync')).toHaveLength(0);
      expect(transport.inputs).toHaveLength(0);

      transport.setStatus('connected');
      const rejoin = await transport.waitForRequest('room:rejoin');
      scene.frame(20_000);
      expect(transport.inputs).toHaveLength(0);
      transport.reply({
        ...joinedReply(rejoin.requestId, localPlayerId, makeSnapshot({ tick: 3, revision: 2, serverTime: 150, localGeneration: 3 })),
        rejoinState: { inputGeneration: 3, nextSeq: 1 },
      });
      await expect.poll(() => scene.pausedStates.filter((paused) => !paused).length).toBe(unpauseCount + 1);
      scene.frame(30_000);
      scene.frame(30_017);

      expect(transport.inputs).toHaveLength(1);
      expect(transport.inputs[0]?.inputGeneration).toBe(3);
    } finally {
      session.destroy();
    }
  });

  it('applies a joined snapshot to the scene after setting role B as the local player and suppresses body-only UI updates', async () => {
    const transport = new TestTransport();
    const storage = new TestStorage();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(storage),
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => 100,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    let uiUpdates = 0;
    const unsubscribe = session.subscribeUi(() => { uiUpdates += 1; });
    const joining = session.join('ABCD2345');
    const request = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(request.requestId, peerPlayerId, snapshotForB()));
    await joining;

    expect(scene.calls.indexOf('local-player')).toBeLessThan(scene.calls.indexOf('world'));
    expect(scene.calls).toContain('local-player');
    expect(scene.worldCount).toBe(1);
    uiUpdates = 0;

    for (let index = 1; index <= 200; index += 1) {
      const previous = snapshotForB();
      const moved = {
        ...previous,
        tick: index,
        revision: index,
        serverTime: index * 50,
        state: {
          ...previous.state,
          players: previous.state.players.map((player) => ({
            ...player,
            body: { ...player.body, x: player.body.x + index },
            inputGeneration: index,
            lastAcceptedSeq: index,
          })),
        },
      };
      transport.emit({ version: 1, type: 'world:update', snapshot: moved });
    }
    expect(scene.worldCount).toBe(201);
    expect(uiUpdates).toBe(0);

    const priorGoal = snapshotForB();
    const changedGoal: WorldSnapshot = {
      ...priorGoal,
      tick: 201,
      revision: 201,
      serverTime: 10_050,
      state: { ...priorGoal.state, gateOpen: true },
    };
    transport.emit({ version: 1, type: 'world:update', snapshot: changedGoal });
    expect(uiUpdates).toBe(1);

    unsubscribe();
    session.destroy();
  });

  it('limits a long frame gap to five inputs and persists each sequence before sending it', async () => {
    const storage = new TestStorage();
    const transport = new TestTransport(storage.trace);
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(storage),
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => 100,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const request = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(request.requestId, localPlayerId));
    await joining;

    storage.trace.length = 0;
    scene.frame(1_000);
    scene.frame(2_000);

    expect(transport.inputs).toHaveLength(5);
    expect(storage.trace).toEqual(['persist', 'send', 'persist', 'send', 'persist', 'send', 'persist', 'send', 'persist', 'send']);
    expect(transport.inputs.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);

    const correctedBody: PlayerBody = { x: 400, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 };
    transport.emit({
      version: 1,
      type: 'world:update',
      snapshot: makeSnapshot({ tick: 2, revision: 1, serverTime: 100, localBody: correctedBody, localGeneration: 2, lastAcceptedSeq: 3, lastProcessedSeq: 2 }),
    });
    expect(scene.localBodies.at(-1)).toEqual(correctedBody);
    scene.frame(2_017);
    expect(transport.inputs.at(-1)?.inputGeneration).toBe(2);
    expect(transport.inputs.at(-1)?.seq).toBe(6);
    session.destroy();
  });

  it('suspends while hidden and waits for resync before sending input after becoming visible', async () => {
    const transport = new TestTransport();
    const storage = new TestStorage();
    const visibility = new TestVisibility();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(storage),
      input: makeInput(),
      sceneFactory: scene.factory,
      visibility,
      clock: () => 100,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const joinRequest = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(joinRequest.requestId, localPlayerId));
    await joining;

    visibility.set('hidden');
    const suspend = await transport.waitForRequest('player:suspend');
    scene.frame(10_000);
    expect(transport.inputs).toHaveLength(0);
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: suspend.requestId,
      rejoinState: { inputGeneration: 2, nextSeq: 1 },
      snapshot: makeSnapshot({ localGeneration: 2 }),
    });

    visibility.set('visible');
    const resync = await transport.waitForRequest('room:resync');
    scene.frame(20_000);
    expect(transport.inputs).toHaveLength(0);
    const unpauseCount = scene.pausedStates.filter((paused) => !paused).length;
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 3, nextSeq: 1 },
      snapshot: makeSnapshot({ localGeneration: 3 }),
    });
    await expect.poll(() => scene.pausedStates.filter((paused) => !paused).length).toBe(unpauseCount + 1);
    scene.frame(30_000);
    scene.frame(30_017);

    expect(transport.inputs).toHaveLength(1);
    expect(transport.inputs[0]?.inputGeneration).toBe(3);
    session.destroy();
  });

  it('resumes the ticker and input after WebGL context loss, suspend, and resync', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    scene.contextLost();
    const suspend = await transport.waitForRequest('player:suspend');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: suspend.requestId,
      rejoinState: { inputGeneration: 2, nextSeq: 1 },
      snapshot: makeSnapshot({ tick: 2, revision: 1, serverTime: 100, localGeneration: 2 }),
    });
    await expect.poll(() => scene.worldCount).toBe(2);

    scene.contextRestored();
    const resync = await transport.waitForRequest('room:resync');
    scene.frame(100);
    scene.frame(117);
    expect(transport.inputs).toHaveLength(0);
    const unpauseCount = scene.pausedStates.filter((paused) => !paused).length;
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 3, nextSeq: 1 },
      snapshot: makeSnapshot({ tick: 3, revision: 2, serverTime: 150, localGeneration: 3 }),
    });
    await expect.poll(() => scene.pausedStates.filter((paused) => !paused).length).toBe(unpauseCount + 1);
    scene.frame(200);
    scene.frame(217);

    expect(transport.inputs).toHaveLength(1);
    expect(transport.inputs[0]?.inputGeneration).toBe(3);
    session.destroy();
  });

  it('sends one gift request, then resyncs a lost acknowledgement without losing server-held state', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    let summary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((next) => { summary = next; });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    const nearby = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    transport.reply(joinedReply(join.requestId, localPlayerId, nearby));
    await joining;
    await waitForSceneReady(session);

    const firstActivation = session.interact();
    const interact = await transport.waitForRequest('world:interact');
    void session.interact();
    await Promise.resolve();
    expect(transport.requests.filter((request) => request.type === 'world:interact')).toHaveLength(1);

    const held = makeSnapshot({ tick: 2, revision: 1, localBody: nearby.state.players[0]!.body });
    held.state.gifts[0]!.collectedBy = localPlayerId;
    transport.emit({ version: 1, type: 'world:update', snapshot: held });
    await expect.poll(() => summary?.ownGift).toBe(true);

    transport.reject(interact.requestId, new SocketClientError('timeout'));
    await firstActivation;
    expect(summary?.ownGift).toBe(true);
    const resync = await transport.waitForRequest('room:resync');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 1, nextSeq: 1 },
      snapshot: held,
    });

    await expect.poll(() => summary?.ownGift).toBe(true);
    expect(transport.requests.filter((request) => request.type === 'world:interact')).toHaveLength(1);
    expect(scene.worldCount).toBeGreaterThan(1);
    unsubscribe();
    session.destroy();
  });

  it('surfaces a server interaction rejection after the local proximity hint', async () => {
    const transport = new TestTransport();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: makeSceneHarness().factory,
      requestId: requestIds(),
    });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    const nearby = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    transport.reply(joinedReply(join.requestId, localPlayerId, nearby));
    await joining;
    await session.attachScene(document.createElement('div'));
    await waitForSceneReady(session);
    let error: UiSummary['error'] = null;
    const unsubscribe = session.subscribeUi((summary) => { error = summary.error; });

    const interaction = session.interact();
    const request = await transport.waitForRequest('world:interact');
    expect(request).toMatchObject({ type: 'world:interact', objectId: 'gift-a' });
    transport.reply({
      version: 1,
      type: 'world:interact:result',
      requestId: request.requestId,
      epoch: nearby.epoch,
      objectId: 'gift-a',
      outcome: 'out_of_range',
    });
    await interaction;
    expect(error).toBe('interaction_failed');
    unsubscribe();
    session.destroy();
  });

  it('resets an in-flight interaction on a new epoch and ignores its late timeout', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    let summary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((next) => { summary = next; });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    const nearby = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    transport.reply(joinedReply(join.requestId, localPlayerId, nearby));
    await joining;
    await waitForSceneReady(session);

    const oldActivation = session.interact();
    const oldRequest = await transport.waitForRequest('world:interact');
    const nextEpoch = makeSnapshot({ epoch: nearby.epoch + 1, localBody: nearby.state.players[0]!.body });
    transport.emit({ version: 1, type: 'round:start', snapshot: nextEpoch });
    const currentActivation = session.interact();
    await Promise.resolve();

    const interactions = transport.requests.filter((request) => request.type === 'world:interact');
    expect(interactions).toHaveLength(2);
    const currentRequest = interactions[1];
    if (!currentRequest || currentRequest.type !== 'world:interact') throw new Error('The current epoch interaction should be sent');
    expect(currentRequest.epoch).toBe(nextEpoch.epoch);

    transport.reject(oldRequest.requestId, new SocketClientError('timeout'));
    await oldActivation;
    expect(transport.requests.filter((request) => request.type === 'room:resync')).toHaveLength(0);
    expect(summary?.error).toBeNull();

    void session.interact();
    await Promise.resolve();
    expect(transport.requests.filter((request) => request.type === 'world:interact')).toHaveLength(2);
    transport.reply({
      version: 1,
      type: 'world:interact:result',
      requestId: currentRequest.requestId,
      epoch: nextEpoch.epoch,
      objectId: 'gift-a',
      outcome: 'accepted',
    });
    await currentActivation;
    unsubscribe();
    session.destroy();
  });

  it('ignores a stale interaction acknowledgement after leaving and joining another room', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    let summary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((next) => { summary = next; });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    const firstRoom = makeSnapshot({ localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    transport.reply(joinedReply(join.requestId, localPlayerId, firstRoom));
    await joining;
    await waitForSceneReady(session);

    const oldActivation = session.interact();
    const oldRequest = await transport.waitForRequest('world:interact');
    const leaving = session.leave();
    const leaveRequest = await transport.waitForRequest('room:leave');
    transport.reply({ version: 1, type: 'command:result', requestId: leaveRequest.requestId, command: 'room:leave', outcome: 'ok' });
    await leaving;
    session.detachScene();

    const secondRoom = makeSnapshot({ roomId: 'WXYZ5678', localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 } });
    const joiningSecondRoom = session.join(secondRoom.roomId);
    const secondJoin = await transport.waitForRequest('room:join', 1);
    transport.reply(joinedReply(secondJoin.requestId, localPlayerId, secondRoom));
    await joiningSecondRoom;
    await session.attachScene(document.createElement('div'));
    await waitForSceneReady(session);

    const currentActivation = session.interact();
    const currentRequest = await transport.waitForRequest('world:interact', 1);
    transport.reply({
      version: 1,
      type: 'world:interact:result',
      requestId: oldRequest.requestId,
      epoch: firstRoom.epoch,
      objectId: 'gift-a',
      outcome: 'out_of_range',
    });
    await oldActivation;
    expect(summary).toMatchObject({ roomId: 'WXYZ5678', phase: 'playing', ownGift: false, error: null });
    expect(transport.requests.filter((request) => request.type === 'room:resync')).toHaveLength(0);

    void session.interact();
    await Promise.resolve();
    expect(transport.requests.filter((request) => request.type === 'world:interact')).toHaveLength(2);
    transport.reply({
      version: 1,
      type: 'world:interact:result',
      requestId: currentRequest.requestId,
      epoch: secondRoom.epoch,
      objectId: 'gift-a',
      outcome: 'accepted',
    });
    await currentActivation;
    unsubscribe();
    session.destroy();
  });

  it('advances non-interactive finish presentation on scene frames using synchronized server time', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    let clientNow = 0;
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => clientNow,
      requestId: requestIds(),
    });
    let summary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((next) => { summary = next; });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;
    const ping = await transport.waitForRequest('time:ping');
    transport.reply({ version: 1, type: 'time:pong', requestId: ping.requestId, clientTime: 0, serverTime: 1000 });

    const complete = makeSnapshot({ tick: 2, revision: 1 });
    complete.state.phase = 'complete';
    complete.state.finishStartedAt = 1000;
    transport.emit({ version: 1, type: 'room:complete', snapshot: complete });
    expect(summary).toMatchObject({ screen: 'game', phase: 'complete', resultsVisible: false });
    expect(scene.pausedStates.at(-1)).toBe(false);

    await expect.poll(() => {
      scene.frame(clientNow);
      return scene.finishViews.at(-1)?.stage;
    }).toBe('approach');
    clientNow = 500;
    scene.frame(clientNow);
    expect(scene.finishViews.at(-1)).toMatchObject({ stage: 'approach', resultsVisible: false });
    expect(transport.inputs).toHaveLength(0);
    expect(summary?.resultsVisible).toBe(false);

    const duplicate = { ...complete, tick: complete.tick + 1, revision: complete.revision + 1 };
    transport.emit({ version: 1, type: 'room:complete', snapshot: duplicate });
    scene.frame(clientNow);
    expect(scene.finishViews.at(-1)).toMatchObject({ stage: 'approach', resultsVisible: false });
    clientNow = 1500;
    scene.frame(clientNow);
    expect(scene.finishViews.at(-1)).toMatchObject({ stage: 'exchange', exchange: true });

    scene.contextLost();
    clientNow = 4000;
    scene.frame(clientNow);
    expect(summary?.resultsVisible).toBe(false);
    scene.contextRestored();
    const resync = await transport.waitForRequest('room:resync');
    const restored = makeSnapshot({ tick: 3, revision: 2 });
    restored.state.phase = 'complete';
    restored.state.finishStartedAt = 1000;
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 1, nextSeq: 1 },
      snapshot: restored,
    });
    await expect.poll(() => summary?.sceneReady).toBe(true);
    await expect.poll(() => {
      scene.frame(clientNow);
      return summary?.resultsVisible;
    }).toBe(true);
    expect(scene.finishViews.at(-1)).toMatchObject({ stage: 'result', resultsVisible: true });
    expect(summary).toMatchObject({ screen: 'result', phase: 'complete', resultsVisible: true });
    expect(transport.inputs).toHaveLength(0);
    unsubscribe();
    session.destroy();
  });

  it('ignores an uncorrelated trailing input error after completion but keeps correlated command errors', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    let clientNow = 0;
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => clientNow,
      requestId: requestIds(),
    });
    let summary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((next) => { summary = next; });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    const playing = makeSnapshot();
    transport.reply(joinedReply(join.requestId, localPlayerId, playing));
    await joining;
    await waitForSceneReady(session);
    const ping = await transport.waitForRequest('time:ping');
    transport.reply({ version: 1, type: 'time:pong', requestId: ping.requestId, clientTime: 0, serverTime: 1000 });

    scene.frame(0);
    scene.frame(17);
    expect(transport.inputs.length).toBeGreaterThan(0);

    const complete = makeSnapshot({ tick: playing.tick + 1, revision: playing.revision + 1 });
    complete.state.phase = 'complete';
    complete.state.finishStartedAt = 1000;
    transport.emit({ version: 1, type: 'room:complete', snapshot: complete });
    transport.emit({ version: 1, type: 'error', code: 'invalid_phase' });

    await expect.poll(() => {
      scene.frame(clientNow);
      return scene.finishViews.at(-1)?.stage;
    }).toBe('approach');

    expect(summary).toMatchObject({ screen: 'game', phase: 'complete', error: null, resultsVisible: false });
    clientNow = 4000;
    await expect.poll(() => {
      scene.frame(clientNow);
      return summary?.resultsVisible;
    }).toBe(true);
    expect(summary).toMatchObject({ screen: 'result', phase: 'complete', error: null, resultsVisible: true });

    const rematch = session.rematch();
    const rematchRequest = await transport.waitForRequest('room:rematch');
    transport.reply({
      version: 1,
      type: 'error',
      requestId: rematchRequest.requestId,
      code: 'invalid_phase',
    });
    await rematch;

    expect(summary).toMatchObject({ screen: 'result', phase: 'complete', error: 'invalid_phase', resultsVisible: true });
    unsubscribe();
    session.destroy();
  });

  it('disconnects after an uncertain create timeout before allowing a fresh create', async () => {
    const transport = new TestTransport();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      requestId: requestIds(),
    });
    const firstCreate = session.create('first-date', 'a');
    const firstRequest = await transport.waitForRequest('room:create');
    transport.reject(firstRequest.requestId, new SocketClientError('timeout'));
    await firstCreate;
    expect(transport.disconnectCalls).toBe(1);

    const nextCreate = session.create('retro', 'b');
    const secondRequest = await transport.waitForRequest('room:create', 1);
    expect(transport.connectCalls).toBe(2);
    transport.reply(joinedReply(secondRequest.requestId, peerPlayerId, snapshotForB()));
    await nextCreate;
    session.destroy();
  });

  it('blocks frames and gift interaction until a reconnect has rejoined the room', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    transport.setStatus('closed');
    transport.setStatus('reconnecting');
    transport.setStatus('connected');
    const rejoin = await transport.waitForRequest('room:rejoin');
    scene.frame(100);
    scene.frame(117);
    const interaction = session.interact();
    const prematureInteraction = transport.requests.findLast((request) => request.type === 'world:interact');
    if (prematureInteraction?.type === 'world:interact') {
      transport.reply({
        version: 1,
        type: 'world:interact:result',
        requestId: prematureInteraction.requestId,
        epoch: 1,
        objectId: 'gift-a',
        outcome: 'out_of_range',
      });
    }
    await interaction;
    expect.soft(transport.inputs).toHaveLength(0);
    expect.soft(prematureInteraction).toBeUndefined();

    transport.reply(joinedReply(rejoin.requestId, localPlayerId));
    session.destroy();
  });

  it('keeps a pending room resync alive across scene detach and reattach', async () => {
    const transport = new TestTransport();
    const visibility = new TestVisibility();
    const scenes: ReturnType<typeof makeSceneHarness>[] = [];
    const sceneFactory: SceneFactory = (hooks) => {
      const harness = makeSceneHarness();
      harness.bind(hooks);
      scenes.push(harness);
      return harness.scene;
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory,
      visibility,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    visibility.set('hidden');
    const suspend = await transport.waitForRequest('player:suspend');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: suspend.requestId,
      rejoinState: { inputGeneration: 2, nextSeq: 1 },
      snapshot: makeSnapshot({ localGeneration: 2 }),
    });
    await expect.poll(() => scenes[0]?.worldCount).toBe(2);
    visibility.set('visible');
    const resync = await transport.waitForRequest('room:resync');
    session.detachScene();
    await session.attachScene(document.createElement('div'));
    const replacementScene = scenes[1];
    expect(replacementScene).toBeDefined();
    if (!replacementScene) throw new Error('Reattached scene should be created');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 3, nextSeq: 1 },
      snapshot: makeSnapshot({ tick: 3, revision: 2, serverTime: 150, localGeneration: 3 }),
    });
    await expect.poll(() => replacementScene.pausedStates.filter((paused) => !paused).length).toBeGreaterThan(0);
    replacementScene.frame(200);
    replacementScene.frame(217);

    expect(transport.inputs).toHaveLength(1);
    session.destroy();
  });

  it('does not mark a resynced room ready when no scene is mounted', async () => {
    const transport = new TestTransport();
    const visibility = new TestVisibility();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      visibility,
      requestId: requestIds(),
    });
    const sceneReady: boolean[] = [];
    const unsubscribe = session.subscribeUi(({ sceneReady: ready }) => sceneReady.push(ready));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    visibility.set('hidden');
    await transport.waitForRequest('player:suspend');
    visibility.set('visible');
    const resync = await transport.waitForRequest('room:resync');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: resync.requestId,
      rejoinState: { inputGeneration: 2, nextSeq: 1 },
      snapshot: makeSnapshot({ tick: 2, revision: 1, localGeneration: 2 }),
    });
    await expect.poll(() => sceneReady.at(-1)).toBe(false);

    expect(sceneReady).not.toContain(true);
    unsubscribe();
    session.destroy();
  });

  it('mounts a replacement scene while the detached scene is still mounting', async () => {
    const transport = new TestTransport();
    type SceneState = {
      container: HTMLElement | null;
      mount: ReturnType<typeof deferredMount>;
      worldCount: number;
      destroyed: boolean;
      hooks: SceneHooks;
    };
    const records: Array<{ state: SceneState; scene: ScenePort }> = [];
    const sceneFactory: SceneFactory = (hooks) => {
      const state: SceneState = {
        container: null,
        mount: deferredMount(),
        worldCount: 0,
        destroyed: false,
        hooks,
      };
      const scene: ScenePort = {
        mount: async (container) => { state.container = container; await state.mount.promise; },
        applyWorld: () => { state.worldCount += 1; },
        applyFinish() {},
        setLocalPlayer() {},
        setLocalBody() {},
        setRemoteBodies() {},
        setPaused() {},
        async setTheme() {},
        destroy: () => { state.destroyed = true; },
      };
      records.push({ state, scene });
      return scene;
    };
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory,
      requestId: requestIds(),
    });
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    const firstContainer = document.createElement('div');
    const secondContainer = document.createElement('div');
    const firstMount = session.attachScene(firstContainer);
    session.detachScene();
    const secondMount = session.attachScene(secondContainer);

    try {
      expect(records).toHaveLength(2);
      const oldScene = records[0];
      const replacementScene = records[1];
      if (!oldScene || !replacementScene) throw new Error('Both mount attempts should create a scene');
      expect(oldScene.state.container).toBe(firstContainer);
      expect(replacementScene.state.container).toBe(secondContainer);
      oldScene.state.mount.resolve();
      await firstMount;
      replacementScene.state.hooks.onFrame(100);
      replacementScene.state.hooks.onFrame(117);
      expect(transport.inputs).toHaveLength(0);
      replacementScene.state.mount.resolve();
      await secondMount;
      replacementScene.state.hooks.onFrame(200);
      replacementScene.state.hooks.onFrame(217);
      expect(transport.inputs).toHaveLength(1);
    } finally {
      records.forEach(({ state }) => state.mount.resolve());
      await Promise.all([firstMount, secondMount]);
      session.destroy();
    }

    expect(records[0]?.state.destroyed).toBe(true);
    expect(records[0]?.state.worldCount).toBe(0);
    expect(records[1]?.state.worldCount).toBe(1);
  });

  it('reports invalid_response for an unexpected command reply', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const errors: Array<string | null> = [];
    const unsubscribe = session.subscribeUi(({ error }) => errors.push(error));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, lobbySnapshot()));
    await joining;
    await waitForSceneReady(session);

    const ready = session.setReady(true);
    const readyRequest = await transport.waitForRequest('player:ready');
    transport.reply({ version: 1, type: 'time:pong', requestId: readyRequest.requestId, clientTime: 100, serverTime: 110 });
    await ready;
    expect(errors.at(-1)).toBe('invalid_response');

    unsubscribe();
    session.destroy();
  });

  it('reports invalid_response for an unexpected resync reply', async () => {
    const transport = new TestTransport();
    const visibility = new TestVisibility();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      visibility,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const errors: Array<string | null> = [];
    const unsubscribe = session.subscribeUi(({ error }) => errors.push(error));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId));
    await joining;

    visibility.set('hidden');
    const suspend = await transport.waitForRequest('player:suspend');
    transport.reply({
      version: 1,
      type: 'room:resynced',
      requestId: suspend.requestId,
      rejoinState: { inputGeneration: 2, nextSeq: 1 },
      snapshot: makeSnapshot({ localGeneration: 2 }),
    });
    await expect.poll(() => scene.worldCount).toBe(2);
    visibility.set('visible');
    const resync = await transport.waitForRequest('room:resync');
    transport.reply({ version: 1, type: 'time:pong', requestId: resync.requestId, clientTime: 100, serverTime: 110 });
    await expect.poll(() => errors.at(-1)).toBe('invalid_response');
    unsubscribe();
    session.destroy();
  });

  it('keeps a room command pending across scene detach and reattach', async () => {
    const transport = new TestTransport();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: scene.factory,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const join = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(join.requestId, localPlayerId, lobbySnapshot()));
    await joining;
    await waitForSceneReady(session);
    const errors: Array<string | null> = [];
    const unsubscribe = session.subscribeUi(({ error }) => errors.push(error));

    const ready = session.setReady(true);
    const readyRequest = await transport.waitForRequest('player:ready');
    session.detachScene();
    await session.attachScene(document.createElement('div'));
    transport.reply({ version: 1, type: 'error', requestId: readyRequest.requestId, code: 'rate_limited' });
    await ready;

    expect(errors.at(-1)).toBe('rate_limited');
    unsubscribe();
    session.destroy();
  });

  it('reports unavailable storage, and clears a credential when the server says the session expired', async () => {
    const transport = new TestTransport();
    const storage = new TestStorage();
    storage.failWrites = true;
    const credentials = new CredentialStore(storage);
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials,
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => 100,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const summaries: Array<{ storageWarning: boolean; error: unknown }> = [];
    const unsubscribe = session.subscribeUi(({ storageWarning, error }) => summaries.push({ storageWarning, error }));
    const joining = session.join('ABCD2345');
    const joinRequest = await transport.waitForRequest('room:join');
    transport.reply(joinedReply(joinRequest.requestId, localPlayerId, lobbySnapshot()));
    await joining;
    await waitForSceneReady(session);
    expect(summaries.at(-1)?.storageWarning).toBe(true);

    const ready = session.setReady(true);
    const readyRequest = await transport.waitForRequest('player:ready');
    transport.reply({ version: 1, type: 'error', requestId: readyRequest.requestId, code: 'session_expired' });
    await ready;
    expect(credentials.read()).toBeNull();
    expect(summaries.at(-1)?.error).toBe('session_expired');

    unsubscribe();
    session.destroy();
  });

  it('ignores a join reply received after destroy and does not write its credential', async () => {
    const transport = new TestTransport();
    const storage = new TestStorage();
    const scene = makeSceneHarness();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(storage),
      input: makeInput(),
      sceneFactory: scene.factory,
      clock: () => 100,
      requestId: requestIds(),
    });
    await session.attachScene(document.createElement('div'));
    const joining = session.join('ABCD2345');
    const joinRequest = await transport.waitForRequest('room:join');
    session.destroy();
    transport.reply(joinedReply(joinRequest.requestId, localPlayerId));
    await joining;

    expect(storage.trace).toEqual([]);
    expect(scene.worldCount).toBe(0);
    expect(transport.destroyed).toBe(true);
  });

  it('preserves an existing reload credential when destroyed', async () => {
    const transport = new TestTransport();
    const storage = new TestStorage();
    storage.seed(credential(localPlayerId));
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(storage),
      input: makeInput(),
      sceneFactory: makeSceneHarness().factory,
      clock: () => 100,
      requestId: requestIds(),
    });
    await transport.waitForRequest('room:rejoin');
    const saved = storage.storedValue();

    session.destroy();
    expect(storage.storedValue()).toBe(saved);
  });

  it.each(['success', 'rejection'] as const)('does not let a delayed leave %s interrupt a newer create', async (leaveOutcome) => {
    const transport = new TestTransport();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new TestStorage()),
      input: makeInput(),
      sceneFactory: makeSceneHarness().factory,
      requestId: requestIds(),
    });
    let latestSummary: UiSummary | undefined;
    const unsubscribe = session.subscribeUi((summary) => { latestSummary = summary; });

    const firstCreate = session.create('first-date', 'a');
    const firstRequest = await transport.waitForRequest('room:create');
    transport.reply(joinedReply(firstRequest.requestId, localPlayerId));
    await firstCreate;

    const leaving = session.leave();
    const leaveRequest = await transport.waitForRequest('room:leave');
    const secondCreate = session.create('retro', 'b');

    if (leaveOutcome === 'success') {
      transport.reply({ version: 1, type: 'command:result', requestId: leaveRequest.requestId, command: 'room:leave', outcome: 'ok' });
    } else {
      transport.reject(leaveRequest.requestId, new Error('The stale leave request failed'));
    }
    await leaving;

    const secondRequest = await transport.waitForRequest('room:create', 1);
    const secondSnapshot = makeSnapshot({ roomId: 'WXYZ5678' });
    secondSnapshot.state.themeId = 'retro';
    transport.reply(joinedReply(secondRequest.requestId, peerPlayerId, secondSnapshot));
    await secondCreate;

    expect(latestSummary).toMatchObject({ roomId: 'WXYZ5678', connection: 'connected', error: null });
    unsubscribe();
  });
});
