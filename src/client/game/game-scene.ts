import { Application, Graphics } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import type { LevelDefinition } from '../../shared/level.js';
import { LEVEL } from '../../shared/level.js';
import type { PlayerBody, PlayerId, WorldSnapshot, ThemeId, Role } from '../../shared/model.js';
import { PLAYER_WIDTH } from '../../shared/simulation-config.js';
import { computeCamera, computeFinishCamera } from './camera.js';
import { WorldView } from './world-view.js';
import { SnowLayer } from './snow-layer.js';
import { loadTheme, type LoadedTheme } from '../themes/theme-loader.js';
import type { Texture } from 'pixi.js';
import type { SceneHooks, ScenePort } from './scene-port.js';
import type { FinishView } from './finish-sequence.js';

export class GameScene implements ScenePort {
  private readonly hooks: SceneHooks;
  private readonly level: LevelDefinition;
  private readonly createApplication: () => Application;
  private readonly pixelRatio: () => number;
  private readonly reducedMotion: boolean;
  private app: Application | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly panes: { world: WorldView; mask: Graphics; label: HTMLSpanElement; role: Role }[] = [];
  private divider: Graphics | null = null;
  private mergeProgress = 0;
  private layoutKey = '';
  private readonly bodies = new Map<PlayerId, PlayerBody>();
  private snowLayer: SnowLayer | null = null;
  private readonly themeLoader: (id: ThemeId, signal: AbortSignal) => Promise<LoadedTheme<Texture>>;
  private themeLease: LoadedTheme<Texture> | null = null;
  private themeController: AbortController | null = null;
  private localPlayerId: PlayerId | null = null;
  private localBody: PlayerBody | null = null;
  private snapshot: WorldSnapshot | null = null;
  private paused = false;
  private contextLost = false;
  private destroyed = false;
  private mounted = false;
  private mounting = false;
  private finishView: FinishView | null = null;

  constructor(hooks: SceneHooks, options: { level?: LevelDefinition; createApplication?: () => Application; pixelRatio?: () => number; reducedMotion?: boolean; themeLoader?: (id: ThemeId, signal: AbortSignal) => Promise<LoadedTheme<Texture>> } = {}) {
    this.hooks = hooks;
    this.level = options.level ?? LEVEL;
    this.createApplication = options.createApplication ?? (() => new Application());
    this.pixelRatio = options.pixelRatio ?? (() => window.devicePixelRatio);
    this.reducedMotion = options.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.themeLoader = options.themeLoader ?? loadTheme;
  }

  async mount(container: HTMLElement): Promise<void> {
    if (this.destroyed) throw new Error('Scene was destroyed');
    if (this.mounting || this.mounted) throw new Error('Scene is already mounted');
    this.mounting = true;
    try {
      const app = this.createApplication();
      this.app = app;
      const canvas = container.ownerDocument.createElement('canvas');
      this.canvas = canvas;
      this.container = container;
      const ratio = this.pixelRatio();
      await app.init({
        canvas,
        width: Math.max(1, container.clientWidth),
        height: Math.max(1, container.clientHeight),
        resolution: Number.isFinite(ratio) ? Math.max(1, Math.min(ratio, 2)) : 1,
        autoDensity: true,
        autoStart: false,
        sharedTicker: false,
        preference: 'webgl',
        backgroundColor: 0x182539,
      });
      if (this.destroyed) {
        this.disposeApplication();
        return;
      }
      for (const role of ['a', 'b'] as const) {
        const view = new WorldView(this.level, this.themeLease, role === 'a' ? 'world' : 'world-b');
        const mask = new Graphics();
        app.stage.addChild(view.container, mask);
        const label = container.ownerDocument.createElement('span');
        label.className = 'scene-player-label';
        label.hidden = true;
        label.dataset.role = role;
        label.setAttribute('aria-hidden', 'true');
        container.appendChild(label);
        this.panes.push({ world: view, mask, label, role });
      }
      this.divider = new Graphics();
      this.divider.label = 'view-divider';
      app.stage.addChild(this.divider);
      if (this.snapshot) this.applyWorld(this.snapshot);
      this.resize();
      this.createSnowLayer();
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
      window.addEventListener('resize', this.resize);
      this.resizeObserver = new ResizeObserver(this.resize);
      this.resizeObserver.observe(container);
      app.ticker.add(this.onTick);
      container.appendChild(canvas);
      this.mounted = true;
      if (!this.paused) app.start();
      else if (this.finishView && !this.contextLost) app.render();
    } catch (error) {
      this.disposeApplication();
      if (!this.destroyed) this.hooks.onError(error instanceof Error ? error : new Error('Renderer initialization failed'));
      throw error;
    } finally {
      this.mounting = false;
    }
  }

  async setTheme(themeId: ThemeId): Promise<void> {
    if (this.destroyed) throw new Error('Scene was destroyed');
    this.themeController?.abort();
    this.clearThemeVisuals();
    this.themeLease?.release();
    this.themeLease = null;
    const controller = new AbortController();
    this.themeController = controller;
    try {
      const lease = await this.themeLoader(themeId, controller.signal);
      if (controller.signal.aborted || this.destroyed) { lease.release(); return; }
      this.themeLease = lease;
      for (const { world: view } of this.panes) view.setTheme(lease);
      if (this.snapshot) this.applyWorld(this.snapshot);
      if (this.mounted) {
        this.createSnowLayer();
        this.app?.render();
      }
    } catch (error) {
      if (controller.signal.aborted || this.destroyed) return;
      const publicError = error instanceof Error ? error : new Error('Theme could not be loaded');
      this.hooks.onError(publicError);
      throw publicError;
    } finally {
      if (this.themeController === controller) this.themeController = null;
    }
  }

  applyWorld(snapshot: WorldSnapshot): void {
    if (this.snapshot?.roomId !== snapshot.roomId || this.snapshot.epoch !== snapshot.epoch || snapshot.state.phase === 'lobby') {
      this.bodies.clear();
      this.mergeProgress = 0;
      this.finishView = null;
    }
    for (const id of this.bodies.keys()) if (id !== this.localPlayerId) this.bodies.delete(id);
    this.snapshot = snapshot;
    if (this.localPlayerId && this.localBody) this.bodies.set(this.localPlayerId, this.localBody);
    for (const { world: view } of this.panes) view.applyWorld(snapshot, this.bodies);
    this.updateCamera();
    if (this.finishView) this.applyFinish(this.finishView);
    else this.renderPaused();
  }

  applyFinish(view: FinishView): void {
    this.finishView = view.stage === 'inactive' ? null : view;
    for (const { world } of this.panes) world.applyFinish(view);
    this.updateCamera();
    this.renderPaused();
  }

  setLocalPlayer(id: PlayerId): void {
    this.localPlayerId = id;
    this.localBody = null;
    this.bodies.clear();
    if (this.snapshot) this.applyWorld(this.snapshot);
  }

  setLocalBody(body: PlayerBody): void {
    if (this.localPlayerId === null) throw new Error('Local player must be configured before its body');
    this.localBody = body;
    this.bodies.set(this.localPlayerId, body);
    for (const { world: view } of this.panes) view.actors.get(this.localPlayerId)?.setBody(body);
    if (this.finishView) this.applyFinish(this.finishView);
    this.updateCamera();
    if (!this.finishView) this.renderPaused();
  }

  setRemoteBodies(bodies: ReadonlyMap<PlayerId, PlayerBody>): void {
    for (const [id, body] of bodies) {
      if (id === this.localPlayerId) continue;
      this.bodies.set(id, body);
      for (const { world: view } of this.panes) view.actors.get(id)?.setBody(body);
    }
    if (this.finishView) this.applyFinish(this.finishView);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!this.app || !this.mounted || this.contextLost) return;
    if (paused) this.app.stop();
    else this.app.start();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.themeController?.abort();
    this.themeController = null;
    if (!this.mounting) this.disposeApplication();
    this.themeLease?.release();
    this.themeLease = null;
  }

  private readonly onTick = (): void => {
    if (this.paused || this.contextLost || this.destroyed) return;
    this.hooks.onFrame(performance.now());
    const deltaMs = this.app?.ticker.deltaMS ?? 0;
    for (const { world: view } of this.panes) view.advance(deltaMs);
    this.snowLayer?.advance(deltaMs);
    this.updateCamera(deltaMs);
  };

  private renderPaused(): void {
    if (this.paused && this.mounted && !this.contextLost && !this.destroyed) this.app?.render();
  }

  private readonly resize = (): void => {
    if (!this.app || !this.container || this.destroyed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.app.renderer.resize(width, height);
    this.snowLayer?.resize(width, height);
    this.updateCamera();
    if (this.paused && this.mounted && !this.contextLost) this.app.render();
  };

  private updateCamera(deltaMs = 0): void {
    if (!this.container || !this.snapshot || this.localPlayerId === null) return;
    const player = this.snapshot.state.players.find((entry) => entry.id === this.localPlayerId);
    if (!player) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const stacked = width < 600;
    const players = this.snapshot.state.players;
    const split = this.snapshot.state.phase !== 'lobby' && players.length === 2;
    const shared = computeFinishCamera(this.level, { width, height });
    const canMerge = split && this.snapshot.state.gateOpen && players.every((entry) => {
      const body = this.bodies.get(entry.id) ?? entry.body;
      return body.x >= this.level.finish.x - 48 && body.x + PLAYER_WIDTH <= this.level.finish.x + this.level.finish.width + 48
        && body.x >= shared.x + 24 / shared.scale
        && body.x + PLAYER_WIDTH <= shared.x + shared.width - 24 / shared.scale
        && body.grounded;
    });
    const target = this.finishView || canMerge ? 1 : 0;
    if (!split) this.mergeProgress = 0;
    else if (this.reducedMotion) this.mergeProgress = target;
    else this.mergeProgress += Math.sign(target - this.mergeProgress) * Math.min(Math.abs(target - this.mergeProgress), Math.max(0, deltaMs) / 650);
    const progress = this.mergeProgress * this.mergeProgress * (3 - 2 * this.mergeProgress);
    const boundary = (stacked ? height : width) * (1 + progress) / 2;
    const layoutKey = `${width}:${height}:${progress}:${split}`;
    for (const { world: view, mask, label, role } of this.panes) {
      const world = view.container;
      const index = role === 'a' ? 0 : 1;
      const followed = split ? players.find((entry) => entry.role === role) : player;
      if (!followed) continue;
      const body = this.bodies.get(followed.id) ?? followed.body;
      const paneWidth = split && !stacked ? width / 2 : width;
      const paneHeight = split && stacked ? height / 2 : height;
      const paneX = split && !stacked ? index * paneWidth : 0;
      const paneY = split && stacked ? index * paneHeight : 0;
      const camera = computeCamera(body, this.level, { width: paneWidth, height: paneHeight,
        insets: split ? { top: 36, bottom: 24 } : stacked ? { top: 80, bottom: 160 } : { top: 64, bottom: 0 },
      });
      if (split) camera.y = Math.max(this.level.bounds.y, Math.min(
        this.level.groundY - camera.height + 24 / camera.scale,
        body.y - 100 / camera.scale,
      ));
      const blend = split ? progress : this.finishView ? 1 : 0;
      const scale = camera.scale + (shared.scale - camera.scale) * blend;
      world.scale.set(scale);
      world.position.set(
        (paneX - camera.x * camera.scale) * (1 - blend) - shared.x * shared.scale * blend,
        (paneY - camera.y * camera.scale) * (1 - blend) - shared.y * shared.scale * blend,
      );
      world.visible = index === 0 || split && this.mergeProgress < 1;
      const maskX = !stacked && index === 1 ? boundary : 0;
      const maskY = stacked && index === 1 ? boundary : 0;
      const maskWidth = stacked ? width : index === 0 ? boundary : width - boundary;
      const maskHeight = !stacked ? height : index === 0 ? boundary : height - boundary;
      if (layoutKey !== this.layoutKey) mask.clear().rect(maskX, maskY, maskWidth, maskHeight).fill(0xffffff);
      const masked = split && this.mergeProgress < 1;
      world.mask = masked ? mask : null;
      mask.visible = masked;
      view.updateView((paneX - world.x) / scale, (-world.y + paneY + (split ? 44 : stacked ? 104 : 88)) / scale);
      label.hidden = !split || this.mergeProgress === 1;
      const text = `${role.toUpperCase()} · ${followed.id === this.localPlayerId ? 'Вы' : 'Партнёр'}`;
      if (label.textContent !== text) label.textContent = text;
      label.style.left = `${paneX + 12}px`;
      label.style.top = `${paneY + 10}px`;
      label.style.opacity = String(1 - progress);
    }
    if (this.divider) {
      if (layoutKey !== this.layoutKey) {
        this.divider.clear();
        if (stacked) this.divider.rect(0, boundary - 1, width, 2).fill(0xeac17b);
        else this.divider.rect(boundary - 1, 0, 2, height).fill(0xeac17b);
        this.layoutKey = layoutKey;
      }
      this.divider.visible = split && this.mergeProgress < 1;
      this.divider.alpha = 1 - progress;
    }
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.contextLost || this.destroyed) return;
    this.contextLost = true;
    this.app?.stop();
    this.hooks.onContextLost();
  };

  private readonly onContextRestored = (): void => {
    if (!this.contextLost || this.destroyed) return;
    try {
      this.app?.render();
      this.contextLost = false;
      if (!this.paused) this.app?.start();
      this.hooks.onContextRestored();
    } catch (error) {
      this.hooks.onError(error instanceof Error ? error : new Error('Renderer restoration failed'));
    }
  };

  private disposeApplication(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const app = this.app;
    if (!app) return;
    this.app = null;
    if (app.ticker) {
      app.stop();
      app.ticker.remove(this.onTick);
    }
    window.removeEventListener('resize', this.resize);
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas?.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.canvas?.remove();
    this.canvas = null;
    this.snowLayer?.destroy();
    this.snowLayer = null;
    for (const { world, mask, label } of this.panes) {
      world.destroy();
      mask.destroy();
      label.remove();
    }
    this.panes.length = 0;
    this.divider?.destroy();
    this.divider = null;
    if (app.renderer) app.destroy(true, { children: false });
    else app.stage.destroy({ children: false });
    this.mounted = false;
  }

  private clearThemeVisuals(): void {
    this.snowLayer?.destroy();
    this.snowLayer = null;
    for (const { world: view } of this.panes) view.setTheme(null);
    this.finishView = null;
  }

  private createSnowLayer(): void {
    if (!this.app || !this.container || this.themeLease?.themeId !== 'winter' || this.snowLayer) return;
    this.snowLayer = new SnowLayer({
      width: Math.max(1, this.container.clientWidth),
      height: Math.max(1, this.container.clientHeight),
      reducedMotion: this.reducedMotion,
    });
    this.app.stage.addChild(this.snowLayer.container);
  }
}
