import type { ApplicationOptions } from 'pixi.js';
import { AnimatedSprite, Application as ApplicationConstructor, Graphics, Texture, TextureSource } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import type { ThemeId } from '../../shared/model.js';
import type { PlayerBody } from '../../shared/model.js';
import { makeSnapshot, localPlayerId, peerPlayerId } from '../../../tests/fixtures/world-snapshot.js';
import { ANIMATION_SPECS, ANIMATION_STATES, themeManifestSchema, type RuntimeThemeManifest } from '../themes/theme-schema.js';
import type { LoadedTheme } from '../themes/theme-loader.js';
import type { FinishView } from './finish-sequence.js';
import type { SceneHooks } from './scene-port.js';
import { GameScene } from './game-scene.js';

const pixiMock = vi.hoisted(() => ({
  createCanvas: vi.fn<() => HTMLCanvasElement>(),
  useProvidedCanvas: vi.fn<(canvas: HTMLCanvasElement) => void>(),
  init: vi.fn<(options?: Partial<ApplicationOptions>) => Promise<void>>(),
  destroy: vi.fn<() => void>(),
  render: vi.fn<() => void>(),
}));

vi.mock('pixi.js', async () => {
  const [containerModule, tickerModule] = await Promise.all([
    import('../../../node_modules/pixi.js/lib/scene/container/Container.js'),
    import('../../../node_modules/pixi.js/lib/ticker/Ticker.js'),
  ]);
  const [spriteModule, textureModule, textureSourceModule, rectangleModule] = await Promise.all([
    import('../../../node_modules/pixi.js/lib/scene/sprite-animated/AnimatedSprite.js'),
    import('../../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/Texture.js'),
    import('../../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.js'),
    import('../../../node_modules/pixi.js/lib/maths/shapes/Rectangle.js'),
  ]);
  const { Container } = containerModule;
  const { Ticker } = tickerModule;

  class TestTicker extends Ticker {
    override start(): void {}
    override stop(): void {}
  }
  class TestGraphics extends Container {
    clear(): this { return this; }
    rect(x: number, y: number, width: number, height: number): this {
      void x;
      void y;
      void width;
      void height;
      return this;
    }

    fill(style: number | { color: number; alpha?: number }): this {
      void style;
      return this;
    }

    stroke(style: { color: number; alpha?: number; width: number }): this {
      void style;
      return this;
    }

    circle(x: number, y: number, radius: number): this {
      void x;
      void y;
      void radius;
      return this;
    }

    roundRect(x: number, y: number, width: number, height: number, radius = 0): this {
      void x;
      void y;
      void width;
      void height;
      void radius;
      return this;
    }

    ellipse(x: number, y: number, halfWidth: number, halfHeight: number): this {
      void x;
      void y;
      void halfWidth;
      void halfHeight;
      return this;
    }

    poly(points: readonly number[]): this {
      void points;
      return this;
    }
  }

  return {
    Container,
    Ticker,
    AnimatedSprite: spriteModule.AnimatedSprite,
    Texture: textureModule.Texture,
    TextureSource: textureSourceModule.TextureSource,
    Rectangle: rectangleModule.Rectangle,
    Graphics: TestGraphics,
    Application: class {
      readonly stage = new Container();
      ticker: TestTicker | undefined;
      renderer: { resize: ReturnType<typeof vi.fn>; resolution: number } | undefined;
      canvas = pixiMock.createCanvas();

      init(options?: Partial<ApplicationOptions>): Promise<void> {
        if (options?.canvas instanceof HTMLCanvasElement) {
          this.canvas = options.canvas;
          pixiMock.useProvidedCanvas(this.canvas);
        }
        return pixiMock.init(options).then(() => {
          this.ticker = new TestTicker();
          this.renderer = { resize: vi.fn(), resolution: options?.resolution ?? 1 };
        });
      }

      destroy(): void {
        pixiMock.destroy();
      }

      render(): void {
        pixiMock.render();
      }

      start(): void {
        this.ticker?.start();
      }

      stop(): void {
        this.ticker?.stop();
      }
    },
  };
});

function body(x: number): PlayerBody {
  return { x, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 };
}

function pilotManifest(themeId: ThemeId): RuntimeThemeManifest {
  const frames: RuntimeThemeManifest['frames'] = {};
  const animations: RuntimeThemeManifest['animations'] = { a: {}, b: {} };
  let slot = 0;
  for (const role of ['a', 'b'] as const) {
    for (const state of ANIMATION_STATES.slice(0, 2)) {
      const ids: string[] = [];
      for (let index = 0; index < ANIMATION_SPECS[state].frameCount; index += 1) {
        const id = `${role}-${state}-${index}`;
        frames[id] = {
          imageKey: 'atlas',
          x: 2 + (slot % 6) * 260,
          y: 2 + Math.floor(slot / 6) * 260,
          width: 256,
          height: 256,
        };
        ids.push(id);
        slot += 1;
      }
      animations[role][state] = ids;
    }
  }
  return themeManifestSchema.parse({
    schemaVersion: 1,
    themeId,
    mode: 'pilot',
    anchor: { x: 0.5, y: 0.88 },
    pages: [{ imageKey: 'atlas', width: 1600, height: 1300 }],
    frames,
    animations,
  });
}

type PendingThemeLoad = ReturnType<typeof Promise.withResolvers<LoadedTheme<Texture>>>;

function loadedTheme(themeId: ThemeId, release: () => void): LoadedTheme<Texture> {
  return { themeId, manifest: pilotManifest(themeId), pages: new Map<string, Texture>(), release };
}

function releaseManifest(themeId: ThemeId = 'first-date'): RuntimeThemeManifest {
  const states = ANIMATION_STATES;
  const pages: RuntimeThemeManifest['pages'] = [
    { imageKey: 'atlas-0', width: 1808, height: 1808 },
    { imageKey: 'atlas-1', width: 1808, height: 1808 },
  ];
  const frames: RuntimeThemeManifest['frames'] = {};
  const animations: RuntimeThemeManifest['animations'] = { a: {}, b: {} };
  const retro = themeId === 'retro';
  let frameNumber = 0;
  for (const role of ['a', 'b'] as const) {
    for (const state of states) {
      const ids: string[] = [];
      for (let index = 0; index < ANIMATION_SPECS[state].frameCount; index += 1) {
        const id = `${role}-${state}-${index}`;
        const pageIndex = Math.floor(frameNumber / 49);
        const slot = frameNumber % 49;
        const page = pages[pageIndex];
        if (!page) throw new Error('Release fixture ran out of atlas pages');
        frames[id] = {
          imageKey: page.imageKey,
          x: 2 + (slot % 7) * 258,
          y: 2 + Math.floor(slot / 7) * 258,
          width: 256,
          height: 256,
        };
        ids.push(id);
        frameNumber += 1;
      }
      animations[role][state] = ids;
    }
  }
  return themeManifestSchema.parse({
    schemaVersion: 1,
    themeId,
    mode: 'release',
    anchor: { x: 0.5, y: 0.88 },
    pages,
    frames,
    animations,
    art: {
      background: { imageKey: 'art-background', width: 1800, height: 900 },
      finish: { imageKey: 'art-finish', width: 800, height: 600 },
      gateClosed: { imageKey: 'art-gate-closed', width: 140, height: 220 },
      gateOpen: { imageKey: 'art-gate-open', width: 140, height: 220 },
      plateIdle: { imageKey: 'art-plate-idle', width: 100, height: 40 },
      plateActive: { imageKey: 'art-plate-active', width: 100, height: 40 },
      giftA: { imageKey: 'art-gift-a', width: retro ? 91 : 80, height: retro ? 67 : 80 },
      giftB: { imageKey: 'art-gift-b', width: retro ? 67 : 80, height: retro ? 94 : 80 },
    },
  });
}

function cpuTexture(width: number, height: number): Texture {
  return new Texture({ source: new TextureSource({ width, height }) });
}

function fullReleaseTheme(release: () => void, themeId: ThemeId = 'first-date'): LoadedTheme<Texture> {
  const manifest = releaseManifest(themeId);
  const pages = new Map(manifest.pages.map(({ imageKey, width, height }) => [imageKey, cpuTexture(width, height)]));
  for (const art of Object.values(manifest.art ?? {})) pages.set(art.imageKey, cpuTexture(art.width, art.height));
  return { themeId, manifest, pages, release };
}

function readThemedGiftState(application: ApplicationConstructor, scene: GameScene, theme: LoadedTheme<Texture>) {
  scene.setLocalPlayer(localPlayerId);
  const before = makeSnapshot();
  scene.applyWorld(before);
  const world = application.stage.getChildByLabel('world');
  const levelCount = world?.children.filter((child) => child.label === 'level').length ?? 0;
  const worldGift = application.stage.getChildByLabel('gift-a', true);
  const usesThemeGift = worldGift instanceof AnimatedSprite
    && worldGift.texture.source === theme.pages.get('art-gift-a')?.source;
  const collected = {
    ...before,
    state: {
      ...before.state,
      gifts: before.state.gifts.map((gift) => gift.id === 'gift-a' ? { ...gift, collectedBy: localPlayerId } : gift),
    },
  };
  scene.applyWorld(collected);
  const actorA = application.stage.getChildByLabel(localPlayerId, true);
  const actorB = application.stage.getChildByLabel(peerPlayerId, true);
  return {
    levelCount,
    usesThemeGift,
    worldGiftHidden: worldGift?.visible === false,
    carriedGiftVisible: actorA?.getChildByLabel('carried-gift', true)?.visible === true,
    partnerGiftHidden: actorB?.getChildByLabel('carried-gift', true)?.visible === false,
    partnerWorldGiftVisible: application.stage.getChildByLabel('gift-b', true)?.visible === true,
  };
}

function requiredRequest<T>(requests: readonly T[], index: number): T {
  const request = requests[index];
  if (request === undefined) throw new Error(`Theme request ${index} was not recorded`);
  return request;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve = (): void => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = (error) => rejectPromise(error);
  });
  return { promise, resolve, reject };
}

const scenes: GameScene[] = [];

function createScene(hooks: SceneHooks, pixelRatio = (): number => 3): GameScene {
  const scene = new GameScene(hooks, { createApplication: () => new ApplicationConstructor(), pixelRatio });
  scenes.push(scene);
  return scene;
}

function setReducedMotionPreference(matches: boolean): void {
  vi.stubGlobal('matchMedia', (media: string): MediaQueryList => ({
    matches,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  }));
}

afterEach(() => {
  scenes.splice(0).forEach((scene) => scene.destroy());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  setReducedMotionPreference(false);
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  pixiMock.createCanvas.mockImplementation(() => document.createElement('canvas'));
  pixiMock.useProvidedCanvas.mockClear();
  pixiMock.init.mockClear();
  pixiMock.init.mockResolvedValue();
  pixiMock.destroy.mockClear();
  pixiMock.render.mockClear();
});

describe('GameScene lifecycle', () => {
  it('waits for renderer initialization before drawing a paused finish update received during mount', async () => {
    const initialization = deferred();
    pixiMock.init.mockReturnValue(initialization.promise);
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    const mounting = scene.mount(document.createElement('div'));
    try {
      scene.applyWorld(makeSnapshot());
      scene.setPaused(true);
      scene.applyFinish({ stage: 'syncing', players: new Map(), exchange: false, resultsVisible: false });
      expect(pixiMock.render).not.toHaveBeenCalled();
    } finally {
      initialization.resolve();
      await mounting;
    }

    expect(pixiMock.render).toHaveBeenCalledOnce();
  });

  it('renders the paused lobby after configuring the player and updating its body', async () => {
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { themeLoader: async () => fullReleaseTheme(vi.fn()), pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('first-date');
    scene.setPaused(true);
    const snapshot = makeSnapshot();
    snapshot.state.phase = 'lobby';
    scene.applyWorld(snapshot);
    pixiMock.render.mockClear();
    scene.setLocalPlayer(localPlayerId);
    expect(pixiMock.render).toHaveBeenCalled();
    pixiMock.render.mockClear();
    scene.setLocalBody(body(240));
    expect(pixiMock.render).toHaveBeenCalled();
  });

  it.each([localPlayerId, peerPlayerId])('shows both roles in fixed panes when local player is %s', async (id) => {
    const application = new ApplicationConstructor();
    const container = document.createElement('div');
    Object.defineProperties(container, { clientWidth: { value: 1000 }, clientHeight: { value: 500 } });
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => fullReleaseTheme(vi.fn()), pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(container);
    await scene.setTheme('first-date');
    scene.setLocalPlayer(id);
    scene.applyWorld(makeSnapshot());
    const left = application.stage.getChildByLabel('world');
    const right = application.stage.getChildByLabel('world-b');
    expect(right?.visible).toBe(true);
    const a = left?.getChildByLabel(localPlayerId);
    const b = right?.getChildByLabel(peerPlayerId);
    if (!left || !right || !a || !b) throw new Error('Both players must be rendered');
    expect(left.x + a.x * left.scale.x).toBeGreaterThan(0);
    expect(left.x + a.x * left.scale.x).toBeLessThan(500);
    expect(right.x + b.x * right.scale.x).toBeGreaterThan(500);
    expect(right.x + b.x * right.scale.x).toBeLessThan(1000);
    expect(container.querySelectorAll('.scene-player-label')).toHaveLength(2);
    const ownLabel = container.querySelector(`[data-role="${id === localPlayerId ? 'a' : 'b'}"]`);
    expect(ownLabel?.textContent).toContain('Вы');
    const remoteId = id === localPlayerId ? peerPlayerId : localPlayerId;
    scene.setRemoteBodies(new Map([[remoteId, body(8000)]]));
    for (const world of [left, right]) expect(world.getChildByLabel(remoteId)?.x).toBe(8016);
    scene.setLocalBody(body(8200));
    for (const world of [left, right]) expect(world.getChildByLabel(id)?.x).toBe(8216);
    scene.destroy();
    expect(container.children).toHaveLength(0);
    expect(right.destroyed).toBe(true);
  });

  it('stacks views on phones, merges only when both arrive, and restores split view for a rematch', async () => {
    const application = new ApplicationConstructor();
    const container = document.createElement('div');
    Object.defineProperties(container, { clientWidth: { value: 390 }, clientHeight: { value: 520 } });
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => fullReleaseTheme(vi.fn()), pixelRatio: () => 1, reducedMotion: true },
    );
    scenes.push(scene);
    await scene.mount(container);
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const snapshot = makeSnapshot({ localBody: body(8900), gateOpen: true });
    scene.applyWorld(snapshot);
    const top = application.stage.getChildByLabel('world');
    const bottom = application.stage.getChildByLabel('world-b');
    const a = top?.getChildByLabel(localPlayerId);
    const b = bottom?.getChildByLabel(peerPlayerId);
    if (!top || !bottom || !a || !b) throw new Error('Both players must be rendered');
    expect(top.y + a.y * top.scale.y).toBeLessThan(260);
    expect(bottom.y + b.y * bottom.scale.y).toBeGreaterThan(260);
    expect(bottom.visible).toBe(true);
    for (const player of snapshot.state.players) if (player.role === 'b') player.body = body(9030);
    scene.applyWorld(snapshot);
    expect(bottom.visible).toBe(false);
    expect(application.stage.getChildByLabel('view-divider')?.visible).toBe(false);
    for (const actor of [a, top.getChildByLabel(peerPlayerId)]) {
      if (!actor) throw new Error('Player missing from shared view');
      expect(top.x + actor.x * top.scale.x).toBeGreaterThan(0);
      expect(top.x + actor.x * top.scale.x).toBeLessThan(390);
    }
    scene.applyWorld(makeSnapshot({ epoch: 2 }));
    expect(bottom.visible).toBe(true);
    expect(application.stage.getChildByLabel('view-divider')?.visible).toBe(true);
  });

  it('animates the join and hides unused masks after both cameras reach the shared frame', async () => {
    const application = new ApplicationConstructor();
    const container = document.createElement('div');
    Object.defineProperties(container, { clientWidth: { value: 390 }, clientHeight: { value: 520 } });
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => fullReleaseTheme(vi.fn()), reducedMotion: false },
    );
    scenes.push(scene);
    await scene.mount(container);
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const snapshot = makeSnapshot({ localBody: body(8900) });
    for (const player of snapshot.state.players) if (player.role === 'b') player.body = body(9030);
    scene.applyWorld(snapshot);
    application.ticker?.update(100);
    const first = application.stage.getChildByLabel('world');
    const second = application.stage.getChildByLabel('world-b');
    const divider = application.stage.getChildByLabel('view-divider');
    expect(second?.visible).toBe(true);
    const initialY = first?.y;
    snapshot.state.gateOpen = true;
    scene.applyWorld(snapshot);
    application.ticker?.update(116);
    expect(first?.y).not.toBe(initialY);
    expect(divider?.alpha).toBeGreaterThan(0);
    expect(divider?.alpha).toBeLessThan(1);
    for (let time = 132; time < 1000; time += 16) application.ticker?.update(time);
    expect(second?.visible).toBe(false);
    expect(first?.x).toBeCloseTo(second?.x ?? 0);
    expect(first?.y).toBeCloseTo(second?.y ?? 0);
    expect(application.stage.children.filter((child) => child instanceof Graphics && child.visible)).toHaveLength(0);
  });

  it('resizes the renderer and camera when the mounted container changes size', async () => {
    const notifications: Array<() => void> = [];
    const observers: Array<{ disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
      readonly disconnect = vi.fn<() => void>();
      readonly observe = vi.fn<(target: Element, options?: ResizeObserverOptions) => void>();
      readonly unobserve = vi.fn<(target: Element) => void>();

      constructor(callback: ResizeObserverCallback) {
        notifications.push(() => callback([], this));
        observers.push(this);
      }
    });
    const container = document.createElement('div');
    let width = 810;
    let height = 187;
    Object.defineProperties(container, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => height },
    });
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, pixelRatio: () => 2 },
    );
    scenes.push(scene);
    await scene.mount(container);
    scene.setLocalPlayer(localPlayerId);
    scene.applyWorld(makeSnapshot());

    const world = application.stage.getChildByLabel('world');
    expect(world).toBeDefined();
    const initialY = world?.y;
    const renderer = application.renderer;
    if (!renderer) throw new Error('The renderer should be initialized after mount');
    const resize = vi.spyOn(renderer, 'resize');
    width = 500;
    height = 500;
    resize.mockClear();
    notifications[0]?.();

    expect(resize).toHaveBeenCalledWith(500, 500);
    expect(world?.y).not.toBe(initialY);

    scene.destroy();
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    const resizeCallsAfterDestroy = resize.mock.calls.length;
    notifications[0]?.();
    expect(resize.mock.calls).toHaveLength(resizeCallsAfterDestroy);
  });

  it.each(['theme completes before renderer initialization', 'renderer initializes before theme completes'])(
    'uses one winter scene and snow layer when %s', async (ordering) => {
      const initialization = deferred();
      pixiMock.init.mockReturnValue(initialization.promise);
      const application = new ApplicationConstructor();
      const leaseRelease = vi.fn();
      const theme = fullReleaseTheme(leaseRelease, 'winter');
      const themeRequest = Promise.withResolvers<LoadedTheme<Texture>>();
      const scene = new GameScene(
        { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
        { createApplication: () => application, themeLoader: async () => themeRequest.promise, pixelRatio: () => 1 },
      );
      scenes.push(scene);
      const mounting = scene.mount(document.createElement('div'));
      const loading = scene.setTheme('winter');
      if (ordering === 'theme completes before renderer initialization') {
        themeRequest.resolve(theme);
        await loading;
        expect(pixiMock.render).not.toHaveBeenCalled();
        initialization.resolve();
        await mounting;
      } else {
        initialization.resolve();
        await mounting;
        themeRequest.resolve(theme);
        await loading;
      }

      const state = readThemedGiftState(application, scene, theme);
      const snow = application.stage.getChildByLabel('snow');
      expect(snow).not.toBeNull();
      expect(snow?.children).toHaveLength(64);
      const secondWorld = application.stage.getChildByLabel('world-b');
      if (!snow || !secondWorld) throw new Error('Winter views must exist');
      expect(application.stage.getChildIndex(snow)).toBeGreaterThan(application.stage.getChildIndex(secondWorld));
      expect(application.stage.children.filter((child) => child.label === 'snow')).toHaveLength(1);
      scene.destroy();

      expect(state.levelCount).toBe(1);
      expect(state.usesThemeGift).toBe(true);
      expect(state.worldGiftHidden).toBe(true);
      expect(state.carriedGiftVisible).toBe(true);
      expect(state.partnerGiftHidden).toBe(true);
      expect(state.partnerWorldGiftVisible).toBe(true);
      expect(snow?.destroyed).toBe(true);
      expect(leaseRelease).toHaveBeenCalledTimes(1);
    },
  );

  it('shows an owned carried gift only after authoritative collection and leaves partner and world gift states intact', async () => {
    const application = new ApplicationConstructor();
    const theme = fullReleaseTheme(vi.fn());
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => theme, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const before = makeSnapshot();
    const expectedBodies = before.state.players.map(({ id, body }) => [id, { ...body }]);
    scene.applyWorld(before);

    const actorA = application.stage.getChildByLabel(localPlayerId, true);
    const actorB = application.stage.getChildByLabel(peerPlayerId, true);
    const giftA = application.stage.getChildByLabel('gift-a', true);
    expect(actorA).toBeDefined();
    expect(actorB).toBeDefined();
    expect(giftA?.visible).toBe(true);
    expect(actorA?.getChildByLabel('carried-gift', true)?.visible).toBe(false);
    expect(actorB?.getChildByLabel('carried-gift', true)?.visible).toBe(false);

    const collected = {
      ...before,
      state: {
        ...before.state,
        gifts: before.state.gifts.map((gift) => gift.id === 'gift-a' ? { ...gift, collectedBy: localPlayerId } : gift),
      },
    };
    scene.applyWorld(collected);

    expect(application.stage.getChildByLabel('gift-a', true)?.visible).toBe(false);
    expect(application.stage.getChildByLabel(localPlayerId, true)?.getChildByLabel('carried-gift', true)?.visible).toBe(true);
    expect(application.stage.getChildByLabel(peerPlayerId, true)?.getChildByLabel('carried-gift', true)?.visible).toBe(false);
    expect(before.state.players.map(({ id, body }) => [id, { ...body }])).toEqual(expectedBodies);
    expect(LEVEL.gifts.map(({ id, ownerRole, position }) => [id, ownerRole, position])).toEqual([
      ['gift-a', 'a', { x: 4500, y: 816 }],
      ['gift-b', 'b', { x: 13500, y: 816 }],
    ]);
  });

  it('hands distinct native gifts to the partner and does not restart the exchange animation on later frames', async () => {
    const application = new ApplicationConstructor();
    const theme = fullReleaseTheme(vi.fn());
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => theme, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const complete = makeSnapshot();
    complete.state.phase = 'complete';
    complete.state.gifts = complete.state.gifts.map((gift) => ({
      ...gift,
      collectedBy: gift.ownerRole === 'a' ? localPlayerId : peerPlayerId,
    }));
    scene.applyWorld(complete);
    scene.setPaused(false);

    const exchange: FinishView = {
      stage: 'exchange',
      players: new Map([
        [localPlayerId, { x: 8800, y: 792, facing: 1 }],
        [peerPlayerId, { x: 9200, y: 792, facing: -1 }],
      ]),
      exchange: true,
      resultsVisible: false,
    };
    scene.applyFinish(exchange);

    const actorA = application.stage.getChildByLabel(localPlayerId, true);
    const actorB = application.stage.getChildByLabel(peerPlayerId, true);
    const giftOnA = actorA?.getChildByLabel('carried-gift', true);
    const giftOnB = actorB?.getChildByLabel('carried-gift', true);
    const spriteA = actorA?.children[0];
    const spriteB = actorB?.children[0];
    expect(giftOnA?.visible).toBe(true);
    expect(giftOnB?.visible).toBe(true);
    expect(giftOnA).toBeInstanceOf(AnimatedSprite);
    expect(giftOnB).toBeInstanceOf(AnimatedSprite);
    expect(spriteA).toBeInstanceOf(AnimatedSprite);
    expect(spriteB).toBeInstanceOf(AnimatedSprite);
    if (!(giftOnA instanceof AnimatedSprite) || !(giftOnB instanceof AnimatedSprite)
      || !(spriteA instanceof AnimatedSprite) || !(spriteB instanceof AnimatedSprite)) {
      throw new Error('Exchanged gifts and players should be animated sprites');
    }
    expect(giftOnA.texture.source).toBe(theme.pages.get('art-gift-b')?.source);
    expect(giftOnB.texture.source).toBe(theme.pages.get('art-gift-a')?.source);

    for (const now of [0, 125, 250, 375, 500, 625, 750]) {
      scene.applyFinish(exchange);
      application.ticker?.update(now);
    }
    expect(actorA?.getChildByLabel('carried-gift', true)).toBe(giftOnA);
    expect(actorB?.getChildByLabel('carried-gift', true)).toBe(giftOnB);
    const frameA = spriteA.textures[0];
    const frameB = spriteB.textures[0];
    expect(frameA instanceof Texture ? frameA.frame.x : undefined).toBe(theme.manifest.frames['a-idle-0']?.x);
    expect(frameB instanceof Texture ? frameB.frame.x : undefined).toBe(theme.manifest.frames['b-idle-0']?.x);

    const happy: FinishView = { ...exchange, stage: 'happy' };
    scene.applyFinish(happy);
    application.ticker?.update(875);
    expect(giftOnA.visible).toBe(false);
    expect(giftOnB.visible).toBe(false);
    const happyFrame = spriteA.textures[0];
    expect(happyFrame instanceof Texture ? happyFrame.frame.x : undefined).toBe(theme.manifest.frames['a-happy-0']?.x);
    const repeatedComplete = { ...complete, tick: complete.tick + 1, revision: complete.revision + 1 };
    scene.applyWorld(repeatedComplete);
    scene.applyFinish(happy);
    application.ticker?.update(1000);
    expect(giftOnA.visible).toBe(false);
    expect(giftOnB.visible).toBe(false);
    scene.applyFinish({ ...happy, stage: 'result', resultsVisible: true });
    expect(giftOnA.visible).toBe(false);
    expect(giftOnB.visible).toBe(false);
    scene.applyFinish({ stage: 'inactive', players: new Map(), exchange: false, resultsVisible: false });
    expect(giftOnA.visible).toBe(true);
    expect(giftOnB.visible).toBe(true);
    const advancedHappyFrame = spriteA.textures[0];
    expect(advancedHappyFrame instanceof Texture ? advancedHappyFrame.frame.x : undefined).toBe(theme.manifest.frames['a-happy-0']?.x);
  });

  it('keeps the happy pose visible through the end of its presentation stage', async () => {
    const application = new ApplicationConstructor();
    const theme = fullReleaseTheme(vi.fn());
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => theme, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const complete = makeSnapshot();
    complete.state.phase = 'complete';
    complete.state.gifts = complete.state.gifts.map((gift) => ({ ...gift, collectedBy: gift.ownerRole === 'a' ? localPlayerId : peerPlayerId }));
    scene.applyWorld(complete);
    scene.setPaused(false);
    application.ticker?.update(1800);

    scene.applyFinish({
      stage: 'happy',
      players: new Map([
        [localPlayerId, { x: 9000, y: 792, facing: 1 }],
        [peerPlayerId, { x: 9100, y: 792, facing: -1 }],
      ]),
      exchange: true,
      resultsVisible: false,
    });
    for (let now = 1900; now <= 2600; now += 100) application.ticker?.update(now);

    const actor = application.stage.getChildByLabel(localPlayerId, true);
    const sprite = actor?.children[0];
    expect(sprite).toBeInstanceOf(AnimatedSprite);
    if (!(sprite instanceof AnimatedSprite)) throw new Error('The presented player should be an animated sprite');
    const frame = sprite.textures[0];
    const happyFrames = Array.from({ length: ANIMATION_SPECS.happy.frameCount }, (_, index) => {
      const happyFrame = theme.manifest.frames[`a-happy-${index}`];
      return happyFrame ? { x: happyFrame.x, y: happyFrame.y } : undefined;
    });
    expect(happyFrames).toContainEqual(frame instanceof Texture ? { x: frame.frame.x, y: frame.frame.y } : undefined);
  });

  it('keeps swapped retro gifts at the same displayed width as before the exchange', async () => {
    const application = new ApplicationConstructor();
    const theme = fullReleaseTheme(vi.fn(), 'retro');
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => theme, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('retro');
    scene.setLocalPlayer(localPlayerId);
    const complete = makeSnapshot();
    complete.state.phase = 'complete';
    complete.state.gifts = complete.state.gifts.map((gift) => ({ ...gift, collectedBy: gift.ownerRole === 'a' ? localPlayerId : peerPlayerId }));
    scene.applyWorld(complete);
    scene.applyFinish({
      stage: 'exchange',
      players: new Map([
        [localPlayerId, { x: 8800, y: 792, facing: 1 }],
        [peerPlayerId, { x: 9200, y: 792, facing: -1 }],
      ]),
      exchange: true,
      resultsVisible: false,
    });

    const displayedWidth = (role: 'a' | 'b') => {
      const gift = application.stage.getChildByLabel(role === 'a' ? localPlayerId : peerPlayerId, true)?.getChildByLabel('carried-gift', true);
      return gift instanceof AnimatedSprite ? Math.abs(gift.scale.x) * gift.texture.width : null;
    };
    const actor = application.stage.getChildByLabel(localPlayerId, true);
    const sprite = actor?.children[0];
    if (!(sprite instanceof AnimatedSprite)) throw new Error('Player sprite must be present');
    expect(sprite.scale.y * 190).toBeCloseTo(112);
    expect(actor?.y).toBe(848);
    expect(theme.manifest.art?.giftA.width).not.toBe(theme.manifest.art?.giftB.width);
    expect(displayedWidth('a')).toBeCloseTo(52);
    expect(displayedWidth('b')).toBeCloseTo(52);
  });

  it('tracks the presented finish position with the camera while keeping server bodies unchanged', async () => {
    const application = new ApplicationConstructor();
    const theme = fullReleaseTheme(vi.fn());
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => theme, pixelRatio: () => 1 },
    );
    scenes.push(scene);
    const container = document.createElement('div');
    Object.defineProperties(container, {
      clientWidth: { get: () => 360 },
      clientHeight: { get: () => 800 },
    });
    await scene.mount(container);
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    const snapshot = makeSnapshot({ localBody: body(8600) });
    snapshot.state.phase = 'complete';
    snapshot.state.finishStartedAt = 1000;
    const serverBodies = snapshot.state.players.map(({ id, body: playerBody }) => [id, { ...playerBody }]);
    scene.applyWorld(snapshot);
    const world = application.stage.getChildByLabel('world');
    if (!world) throw new Error('The game world should be present');
    const cameraBeforePresentation = world.position.x;

    scene.applyFinish({
      stage: 'approach',
      players: new Map([
        [localPlayerId, { x: 9000, y: 792, facing: 1 }],
        [peerPlayerId, { x: 9100, y: 792, facing: -1 }],
      ]),
      exchange: false,
      resultsVisible: false,
    });
    application.ticker?.update(100);

    expect(world.position.x).not.toBe(cameraBeforePresentation);
    expect(snapshot.state.players.map(({ id, body: playerBody }) => [id, playerBody])).toEqual(serverBodies);
  });

  it('adds one 64-particle stage-space layer for winter and removes it when winter is replaced', async () => {
    setReducedMotionPreference(true);
    const application = new ApplicationConstructor();
    const themes: LoadedTheme<Texture>[] = [];
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      {
        createApplication: () => application,
        themeLoader: async (themeId) => {
          const theme = fullReleaseTheme(vi.fn(), themeId);
          themes.push(theme);
          return theme;
        },
        pixelRatio: () => 1,
        reducedMotion: false,
      },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));

    await scene.setTheme('winter');
    const snow = application.stage.getChildByLabel('snow');
    expect(snow).not.toBeNull();
    expect(snow?.children).toHaveLength(64);
    expect(snow?.parent).toBe(application.stage);
    expect(application.stage.children.filter((child) => child.label === 'snow')).toHaveLength(1);

    await scene.setTheme('retro');

    expect(snow?.destroyed).toBe(true);
    expect(application.stage.getChildByLabel('snow')).toBeNull();
    expect(themes).toHaveLength(2);
  });

  it('does not add a snow layer for first-date or retro themes', async () => {
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async (themeId) => fullReleaseTheme(vi.fn(), themeId), pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));

    await scene.setTheme('first-date');
    expect(application.stage.getChildByLabel('snow')).toBeNull();
    await scene.setTheme('retro');
    expect(application.stage.getChildByLabel('snow')).toBeNull();
  });

  it('uses the explicit reduced-motion setting to create no winter particles', async () => {
    setReducedMotionPreference(false);
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => fullReleaseTheme(vi.fn(), 'winter'), pixelRatio: () => 1, reducedMotion: true },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('winter');

    const snow = application.stage.getChildByLabel('snow');
    expect(snow).not.toBeNull();
    expect(snow?.children).toHaveLength(0);
  });

  it('uses the browser reduced-motion preference when no scene override is supplied', async () => {
    setReducedMotionPreference(true);
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async () => fullReleaseTheme(vi.fn(), 'winter'), pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('winter');

    const snow = application.stage.getChildByLabel('snow');
    expect(snow).not.toBeNull();
    expect(snow?.children).toHaveLength(0);
  });

  it('preserves the authoritative local body when replacing the visual theme', async () => {
    const application = new ApplicationConstructor();
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { createApplication: () => application, themeLoader: async (themeId) => fullReleaseTheme(vi.fn(), themeId), pixelRatio: () => 1 },
    );
    scenes.push(scene);
    await scene.mount(document.createElement('div'));
    await scene.setTheme('first-date');
    scene.setLocalPlayer(localPlayerId);
    scene.applyWorld(makeSnapshot());
    scene.setLocalBody(body(256));

    await scene.setTheme('winter');

    const actor = application.stage.getChildByLabel(localPlayerId, true);
    expect(actor?.position.x).toBe(272);
    expect(actor?.position.y).toBe(848);
  });

  it('destroys an app whose initialization resolves after disposal without appending its canvas', async () => {
    const initialization = deferred();
    pixiMock.init.mockReturnValue(initialization.promise);
    const scene = createScene({ onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() });
    const container = document.createElement('div');
    const mounting = scene.mount(container);

    scene.destroy();
    initialization.resolve();
    await mounting;
    scene.destroy();

    expect(container.childElementCount).toBe(0);
    expect(pixiMock.destroy).toHaveBeenCalledTimes(1);
  });

  it('reports an initialization failure and applies the capped pixel ratio', async () => {
    const error = new Error('renderer initialization failed');
    const hooks = { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() } satisfies SceneHooks;
    pixiMock.init.mockRejectedValue(error);
    const scene = createScene(hooks);

    await expect(scene.mount(document.createElement('div'))).rejects.toBe(error);
    expect(hooks.onError).toHaveBeenCalledWith(error);
    expect(pixiMock.init.mock.calls[0]?.[0]?.resolution).toBe(2);
    expect(pixiMock.init.mock.calls[0]?.[0]?.autoDensity).toBe(true);
    expect(pixiMock.destroy).not.toHaveBeenCalled();
  });

  it('cleans up an application whose renderer initialization rejects before ticker and renderer exist', async () => {
    const error = new Error('automatic renderer detection failed');
    const application = new ApplicationConstructor();
    expect(Reflect.deleteProperty(application, 'ticker')).toBe(true);
    expect(Reflect.deleteProperty(application, 'renderer')).toBe(true);
    pixiMock.init.mockRejectedValue(error);
    const hooks = { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() } satisfies SceneHooks;
    const scene = new GameScene(hooks, { createApplication: () => application });
    scenes.push(scene);
    const container = document.createElement('div');

    await expect(scene.mount(container)).rejects.toBe(error);
    scene.destroy();
    scene.destroy();

    expect(hooks.onError).toHaveBeenCalledTimes(1);
    expect(hooks.onError).toHaveBeenCalledWith(error);
    expect(container.childElementCount).toBe(0);
  });

  it('notifies once for context loss and restoration, and allows either player to own the local scene', async () => {
    const hooks = { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() } satisfies SceneHooks;
    const scene = createScene(hooks, () => 1);
    const container = document.createElement('div');
    await scene.mount(container);
    const canvas = pixiMock.useProvidedCanvas.mock.calls.at(-1)?.[0] ?? pixiMock.createCanvas.mock.results.at(-1)?.value;
    expect(canvas).toBeDefined();

    const lost = new Event('webglcontextlost', { cancelable: true });
    canvas?.dispatchEvent(lost);
    canvas?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(lost.defaultPrevented).toBe(true);
    expect(hooks.onContextLost).toHaveBeenCalledTimes(1);

    canvas?.dispatchEvent(new Event('webglcontextrestored'));
    expect(hooks.onContextRestored).toHaveBeenCalledTimes(1);

    scene.setLocalPlayer(peerPlayerId);
    scene.applyWorld(makeSnapshot({ localBody: body(64) }));
    scene.setLocalBody(body(17872));
    scene.setLocalPlayer(localPlayerId);
    scene.setLocalBody(body(96));
    expect(hooks.onError).not.toHaveBeenCalled();

    scene.destroy();
    canvas?.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas?.dispatchEvent(new Event('webglcontextrestored'));
    expect(hooks.onContextLost).toHaveBeenCalledTimes(1);
    expect(hooks.onContextRestored).toHaveBeenCalledTimes(1);
  });

  it('aborts a replaced theme request and releases late and current leases exactly once', async () => {
    const requests: Array<{ themeId: ThemeId; signal: AbortSignal; pending: PendingThemeLoad }> = [];
    const themeLoader = (themeId: ThemeId, signal: AbortSignal): Promise<LoadedTheme<Texture>> => {
      const pending = Promise.withResolvers<LoadedTheme<Texture>>();
      requests.push({ themeId, signal, pending });
      return pending.promise;
    };
    const scene = new GameScene(
      { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() },
      { themeLoader },
    );
    scenes.push(scene);
    const firstLoad = scene.setTheme('first-date');
    const secondLoad = scene.setTheme('retro');
    const firstRequest = requiredRequest(requests, 0);
    const secondRequest = requiredRequest(requests, 1);
    expect(firstRequest.signal.aborted).toBe(true);
    expect(secondRequest.signal.aborted).toBe(false);

    const lateRelease = vi.fn();
    const currentRelease = vi.fn();
    firstRequest.pending.resolve(loadedTheme(firstRequest.themeId, lateRelease));
    secondRequest.pending.resolve(loadedTheme(secondRequest.themeId, currentRelease));
    await Promise.all([firstLoad, secondLoad]);

    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(currentRelease).not.toHaveBeenCalled();
    scene.destroy();
    scene.destroy();
    expect(lateRelease).toHaveBeenCalledTimes(1);
    expect(currentRelease).toHaveBeenCalledTimes(1);
  });

  it('releases a theme lease that resolves after destroy', async () => {
    const pending = Promise.withResolvers<LoadedTheme<Texture>>();
    let requestSignal: AbortSignal | undefined;
    const themeLoader = (_themeId: ThemeId, signal: AbortSignal): Promise<LoadedTheme<Texture>> => {
      requestSignal = signal;
      return pending.promise;
    };
    const hooks = { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() } satisfies SceneHooks;
    const scene = new GameScene(hooks, { themeLoader });
    scenes.push(scene);
    const loading = scene.setTheme('first-date');
    scene.destroy();
    expect(requestSignal?.aborted).toBe(true);
    const release = vi.fn();
    pending.resolve(loadedTheme('first-date', release));
    await loading;

    expect(release).toHaveBeenCalledTimes(1);
    expect(hooks.onError).not.toHaveBeenCalled();
  });

  it('ignores a theme load rejection that arrives after destroy', async () => {
    const pending = Promise.withResolvers<LoadedTheme<Texture>>();
    const hooks = { onFrame: vi.fn(), onError: vi.fn(), onContextLost: vi.fn(), onContextRestored: vi.fn() } satisfies SceneHooks;
    const scene = new GameScene(hooks, { themeLoader: () => pending.promise });
    scenes.push(scene);
    const loading = scene.setTheme('first-date');
    scene.destroy();
    pending.reject(new Error('late theme failure'));

    await expect(loading).resolves.toBeUndefined();
    expect(hooks.onError).not.toHaveBeenCalled();
  });
});
