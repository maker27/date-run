import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { makeSnapshot, localPlayerId } from '../../tests/fixtures/world-snapshot.js';
import type { Credential, Phase, PlayerInput } from '../shared/model.js';
import type { ClientRequest, InputUpdate, ServerEvent, ServerReply, Unsubscribe } from '../shared/protocol.js';
import type { SceneHooks, ScenePort } from './game/scene-port.js';
import { SocketClientError } from './realtime/socket-client.js';
import { CredentialStore } from './realtime/credentials.js';
import { App } from './app.js';
import { GameSession, type TransportPort } from './application/game-session.js';

const sessions: GameSession[] = [];

function trackedSession(options: NonNullable<ConstructorParameters<typeof GameSession>[0]>): GameSession {
  const session = new GameSession(options);
  sessions.push(session);
  return session;
}

class AppTransport implements TransportPort {
  status: TransportPort['status'] = 'closed';
  readonly requests: ClientRequest[] = [];
  readonly inputs: InputUpdate[] = [];
  private readonly pending = new Map<string, { resolve: (reply: ServerReply) => void; reject: (error: Error) => void }>();
  private readonly events = new Set<(event: ServerEvent) => void>();
  private readonly statuses = new Set<(status: TransportPort['status']) => void>();

  connect(): Promise<void> { this.setStatus('connected'); return Promise.resolve(); }
  request(message: ClientRequest): Promise<ServerReply> {
    this.requests.push(message);
    return new Promise((resolve, reject) => this.pending.set(message.requestId, { resolve, reject }));
  }
  sendInput(message: InputUpdate): void { this.inputs.push(message); }
  onEvent(listener: (event: ServerEvent) => void): Unsubscribe { this.events.add(listener); return () => this.events.delete(listener); }
  onStatus(listener: (status: TransportPort['status']) => void): Unsubscribe { this.statuses.add(listener); listener(this.status); return () => this.statuses.delete(listener); }
  disconnect(): void { this.setStatus('closed'); }
  destroy(): void { this.disconnect(); this.events.clear(); this.statuses.clear(); }
  setStatus(status: TransportPort['status']): void { this.status = status; this.statuses.forEach((listener) => listener(status)); }
  reply(reply: ServerReply): void {
    if (!('requestId' in reply) || !reply.requestId) throw new Error('Reply needs a request ID');
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
  emit(event: ServerEvent): void { this.events.forEach((listener) => listener(event)); }
  async waitFor(type: ClientRequest['type'], occurrence = 0): Promise<ClientRequest> {
    await expect.poll(() => this.requests.filter((request) => request.type === type).at(occurrence)).toBeDefined();
    const request = this.requests.filter((message) => message.type === type).at(occurrence);
    if (!request) throw new Error(`No ${type} request was sent`);
    return request;
  }
}

class AppStorage {
  private value: string | null = null;
  getItem(): string | null { return this.value; }
  setItem(_key: string, value: string): void { this.value = value; }
  removeItem(): void { this.value = null; }
}

function requestIds(): () => string {
  let next = 80;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
}

function credential(): Credential {
  return {
    schemaVersion: 1,
    roomId: 'ABCD2345',
    playerId: localPlayerId,
    sessionToken: '00000000-0000-4000-8000-000000000099',
    nextSeq: 1,
  };
}

function sceneFactory(): ScenePort {
  return {
    async mount() {},
    applyWorld() {},
    applyFinish() {},
    setLocalPlayer() {},
    setLocalBody() {},
    setRemoteBodies() {},
    setPaused() {},
    async setTheme() {},
    destroy() {},
  };
}

afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.destroy());
});

describe('App connection recovery', () => {
  it.each(['request ID', 'connection'])('shows an unexpected %s failure and lets the user create again', async (failure) => {
    const transport = new AppTransport();
    const nextId = requestIds();
    let fail = true;
    const connect = transport.connect.bind(transport);
    transport.connect = () => failure === 'connection' && fail
      ? Promise.reject(new Error('private failure details')) : connect();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new AppStorage()),
      sceneFactory,
      requestId: () => {
        if (failure === 'request ID' && fail) throw new Error('private failure details');
        return nextId();
      },
    });
    render(<App session={session} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Создать комнату' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Не удалось выполнить действие. Попробуйте ещё раз.');
    expect(document.body.textContent).not.toContain('private failure details');

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Создать комнату' }));
    const request = await transport.waitFor('room:create');
    const snapshot = makeSnapshot();
    snapshot.state.phase = 'lobby';
    transport.reply({
      version: 1, type: 'room:joined', requestId: request.requestId,
      credential: credential(), rejoinState: { inputGeneration: 1, nextSeq: 1 }, snapshot,
    });
    await screen.findByRole('heading', { name: 'Комната ABCD2345' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  const phases: readonly Phase[] = ['lobby', 'playing'];

  it('keeps graphics_error and retry available when a repeated theme retry also fails', async () => {
    const transport = new AppTransport();
    const repeatedFailure = Promise.withResolvers<void>();
    const hooks: SceneHooks[] = [];
    const destroyed: number[] = [];
    let themeAttempts = 0;
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new AppStorage()),
      input: {
        read: (): PlayerInput => ({ axis: 1, jumpPressed: false }),
        onInteract: () => () => undefined,
        reset() {},
        destroy() {},
      },
      sceneFactory: (sceneHooks) => {
        const index = hooks.length;
        hooks.push(sceneHooks);
        return {
          async mount() {},
          applyWorld() {},
          applyFinish() {},
          setLocalPlayer() {},
          setLocalBody() {},
          setRemoteBodies() {},
          setPaused() {},
          async setTheme() {
            themeAttempts += 1;
            if (themeAttempts === 1) throw new Error('theme unavailable');
            if (themeAttempts === 2) {
              await repeatedFailure.promise;
              throw new Error('theme remains unavailable');
            }
          },
          destroy() { destroyed.push(index); },
        };
      },
      requestId: requestIds(),
    });
    try {
      const joining = session.join('ABCD2345');
      const join = await transport.waitFor('room:join');
      const snapshot = makeSnapshot();
      transport.reply({
        version: 1,
        type: 'room:joined',
        requestId: join.requestId,
        credential: credential(),
        rejoinState: { inputGeneration: 1, nextSeq: 1 },
        snapshot,
      });
      await joining;
      render(<App session={session} />);
      await expect.poll(() => themeAttempts).toBe(1);
      const retry = await screen.findByRole('button', { name: 'Повторить' });

      await act(async () => { fireEvent.click(retry); });
      await expect.poll(() => themeAttempts).toBe(2);
      hooks.at(-1)?.onFrame(100);
      hooks.at(-1)?.onFrame(117);
      expect(transport.inputs).toHaveLength(0);

      await act(async () => {
        repeatedFailure.reject(new Error('theme remains unavailable'));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/сцену снова/i);
      expect(alert.textContent).not.toMatch(/theme unavailable|Error/i);
      expect(screen.getByRole('button', { name: 'Повторить' })).toBeDefined();
      expect(destroyed).toEqual([0, 1]);
      expect(transport.inputs).toHaveLength(0);
    } finally {
      session.destroy();
    }
  });

  it.each(phases)('recovers from a %s command timeout using its screen-specific path', async (phase) => {
    const transport = new AppTransport();
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new AppStorage()),
      input: {
        read: (): PlayerInput => ({ axis: 0, jumpPressed: false }),
        onInteract: () => () => undefined,
        reset() {},
        destroy() {},
      },
      sceneFactory,
      requestId: requestIds(),
    });
    try {
    const joining = session.join('ABCD2345');
    const join = await transport.waitFor('room:join');
    const snapshot = makeSnapshot(phase === 'playing' ? {
      localBody: { x: 4500, y: 816, vx: 0, vy: 0, grounded: true, facing: 1 },
    } : {});
    transport.reply({
      version: 1,
      type: 'room:joined',
      requestId: join.requestId,
      credential: credential(),
      rejoinState: { inputGeneration: 1, nextSeq: 1 },
      snapshot: { ...snapshot, state: { ...snapshot.state, phase } },
    });
    await joining;
    let sceneReady = false;
    let recovered = false;
    const unsubscribe = session.subscribeUi((summary) => {
      sceneReady = summary.sceneReady;
      recovered = summary.error === null && summary.sceneReady && summary.phase === 'playing';
    });
    render(<App session={session} />);

    await expect.poll(() => sceneReady).toBe(true);

    await act(async () => {
      const command = phase === 'lobby' ? session.setReady(true) : session.interact();
      const request = await transport.waitFor(phase === 'lobby' ? 'player:ready' : 'world:interact');
      transport.reject(request.requestId, new SocketClientError('timeout'));
      await command;
    });

    if (phase === 'playing') {
      const resync = await transport.waitFor('room:resync');
      expect(transport.requests.filter((request) => request.type === 'world:interact')).toHaveLength(1);
      const recoveredSnapshot = makeSnapshot({ tick: 2, revision: 1, localBody: {
        x: 4500,
        y: 816,
        vx: 0,
        vy: 0,
        grounded: true,
        facing: 1,
      } });
      transport.reply({
        version: 1,
        type: 'room:resynced',
        requestId: resync.requestId,
        rejoinState: { inputGeneration: 1, nextSeq: 1 },
        snapshot: recoveredSnapshot,
      });
      await expect.poll(() => recovered).toBe(true);
      expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull();
      unsubscribe();
      return;
    }

    const retry = screen.queryByRole('button', { name: 'Повторить' });
    expect(retry).not.toBeNull();
    if (!retry) {
      throw new Error('A reconnect retry action should be available on the active room screen');
    }
    await act(async () => { fireEvent.click(retry); });
    await transport.waitFor('room:rejoin');
    unsubscribe();
    } finally {
      session.destroy();
    }
  });
});

describe('App room scene lifecycle', () => {
  it('keeps one scene through 200 snapshots and projects no world coordinates into UI summaries', async () => {
    const transport = new AppTransport();
    let mounts = 0;
    let destroys = 0;
    let worldApplications = 0;
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new AppStorage()),
      input: {
        read: (): PlayerInput => ({ axis: 0, jumpPressed: false }),
        onInteract: () => () => undefined,
        reset() {},
        destroy() {},
      },
      sceneFactory: () => ({
        async mount() { mounts += 1; },
        applyWorld() { worldApplications += 1; },
        applyFinish() {},
        setLocalPlayer() {},
        setLocalBody() {},
        setRemoteBodies() {},
        setPaused() {},
        async setTheme() {},
        destroy() { destroys += 1; },
      }),
      requestId: requestIds(),
    });
    const joining = session.join('ABCD2345');
    const join = await transport.waitFor('room:join');
    transport.reply({
      version: 1,
      type: 'room:joined',
      requestId: join.requestId,
      credential: credential(),
      rejoinState: { inputGeneration: 1, nextSeq: 1 },
      snapshot: makeSnapshot(),
    });
    await joining;

    const summaries: string[] = [];
    const unsubscribe = session.subscribeUi((summary) => summaries.push(JSON.stringify(summary)));
    const app = render(<App session={session} />);
    await expect.poll(() => mounts).toBe(1);
    await expect.poll(() => summaries.at(-1)).toContain('"sceneReady":true');
    const liveRegion = app.container.querySelector('[aria-live]');
    expect(liveRegion).not.toBeNull();
    const announcement = liveRegion?.textContent;
    const summaryCountAfterReady = summaries.length;

    for (let revision = 1; revision <= 200; revision += 1) {
      const snapshot = makeSnapshot({ tick: revision + 1, revision, localBody: {
        x: 100 + revision,
        y: 792,
        vx: 1,
        vy: 0,
        grounded: true,
        facing: 1,
      } });
      transport.emit({ version: 1, type: 'world:update', snapshot });
    }

    expect(mounts).toBe(1);
    expect(destroys).toBe(0);
    expect(worldApplications).toBe(201);
    expect(summaries.every((summary) => !/"(?:x|y|body)"\s*:/.test(summary))).toBe(true);
    expect(summaries).toHaveLength(summaryCountAfterReady);
    expect(liveRegion?.textContent).toBe(announcement);

    unsubscribe();
    app.unmount();
    expect(destroys).toBe(1);
    session.destroy();
  });

  it('keeps the mounted canvas container through lobby, play, result and leave while moving focus', async () => {
    const transport = new AppTransport();
    let mounts = 0;
    let destroys = 0;
    let clientNow = 0;
    let frame: ((clientNow: number) => void) | undefined;
    const mountedScenes: Array<{ container: HTMLElement; canvas: HTMLCanvasElement }> = [];
    let sceneReady = false;
    const session = trackedSession({
      transport,
      credentials: new CredentialStore(new AppStorage()),
      input: {
        read: (): PlayerInput => ({ axis: 0, jumpPressed: false }),
        onInteract: () => () => undefined,
        reset() {},
        destroy() {},
      },
      clock: () => clientNow,
      sceneFactory: (hooks) => {
        frame = hooks.onFrame;
        return {
        async mount(container) {
          mounts += 1;
          const canvas = document.createElement('canvas');
          mountedScenes.push({ container, canvas });
          container.append(canvas);
        },
        applyWorld() {},
        applyFinish() {},
        setLocalPlayer() {},
        setLocalBody() {},
        setRemoteBodies() {},
        setPaused() {},
        async setTheme() {},
        destroy() { destroys += 1; },
        };
      },
      requestId: requestIds(),
    });
    const unsubscribe = session.subscribeUi((summary) => { sceneReady = summary.sceneReady; });
    const app = render(<App session={session} />);
    const landingHeading = await screen.findByRole('heading', { name: 'Date Run' });
    await expect.poll(() => document.activeElement).toBe(landingHeading);

    const joining = session.join('ABCD2345');
    const join = await transport.waitFor('room:join');
    const lobby = makeSnapshot();
    transport.reply({
      version: 1,
      type: 'room:joined',
      requestId: join.requestId,
      credential: credential(),
      rejoinState: { inputGeneration: 1, nextSeq: 1 },
      snapshot: { ...lobby, state: { ...lobby.state, phase: 'lobby' } },
    });
    await joining;
    const ping = await transport.waitFor('time:ping');
    transport.reply({ version: 1, type: 'time:pong', requestId: ping.requestId, clientTime: 0, serverTime: 1000 });
    const roomHeading = await screen.findByRole('heading', { name: 'Комната ABCD2345' });
    await expect.poll(() => sceneReady).toBe(true);
    await expect.poll(() => document.activeElement).toBe(roomHeading);
    const mountedScene = mountedScenes[0];
    if (!mountedScene) throw new Error('The scene should mount before it becomes ready');
    const lobbyCanvasContainer = screen.getByRole('img', { name: 'Игровой мир Date Run' });
    expect(lobbyCanvasContainer).toBe(mountedScene.container);
    expect(mountedScene.canvas.parentElement).toBe(lobbyCanvasContainer);

    const game = {
      ...lobby,
      tick: 2,
      revision: 1,
      state: { ...lobby.state, phase: 'playing' as const, players: lobby.state.players.map((player) => ({ ...player, ready: true })) },
    };
    transport.emit({ version: 1, type: 'round:start', snapshot: game });
    const gameHeading = await screen.findByRole('heading', { name: 'Бегите навстречу!' });
    await expect.poll(() => document.activeElement).toBe(gameHeading);
    const playingCanvasContainer = screen.getByRole('img', { name: 'Игровой мир Date Run' });
    expect(playingCanvasContainer).toBe(mountedScene.container);
    expect(mountedScene.canvas.parentElement).toBe(playingCanvasContainer);

    const result = {
      ...game,
      tick: 3,
      revision: 2,
      state: { ...game.state, phase: 'complete' as const, finishStartedAt: 1000 },
    };
    transport.emit({ version: 1, type: 'room:complete', snapshot: result });
    expect(screen.queryByRole('heading', { name: 'Вы встретились!' })).toBeNull();
    frame?.(0);
    clientNow = 2999;
    frame?.(clientNow);
    expect(screen.queryByRole('heading', { name: 'Вы встретились!' })).toBeNull();
    clientNow = 3000;
    frame?.(clientNow);
    const resultHeading = await screen.findByRole('heading', { name: 'Вы встретились!' });
    await expect.poll(() => document.activeElement).toBe(resultHeading);
    const resultCanvasContainer = screen.getByRole('img', { name: 'Игровой мир Date Run' });
    expect(resultCanvasContainer).toBe(mountedScene.container);
    expect(mountedScene.canvas.parentElement).toBe(resultCanvasContainer);
    expect(mounts).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Выйти' }));
      const leave = await transport.waitFor('room:leave');
      transport.reply({ version: 1, type: 'command:result', command: 'room:leave', outcome: 'ok', requestId: leave.requestId });
    });
    const returnedHeading = await screen.findByRole('heading', { name: 'Date Run' });
    await expect.poll(() => document.activeElement).toBe(returnedHeading);
    expect(mounts).toBe(1);
    expect(destroys).toBe(1);

    unsubscribe();
    app.unmount();
    session.destroy();
  });
});
