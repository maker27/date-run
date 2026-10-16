import { Container, type Texture } from 'pixi.js';
import type { LevelDefinition } from '../../shared/level.js';
import type { PlayerBody, PlayerId, WorldSnapshot } from '../../shared/model.js';
import { PLAYER_HEIGHT } from '../../shared/simulation-config.js';
import type { LoadedTheme } from '../themes/theme-loader.js';
import type { FinishStage, FinishView } from './finish-sequence.js';
import { LevelRenderer } from './level-renderer.js';
import { PlayerVisual } from './player-visual.js';

export class WorldView {
  readonly container = new Container();
  readonly actors = new Map<PlayerId, PlayerVisual>();
  private renderer: LevelRenderer;
  private theme: LoadedTheme<Texture> | null;
  private finishStage: FinishStage = 'inactive';

  constructor(private readonly level: LevelDefinition, theme: LoadedTheme<Texture> | null, label: string) {
    this.container.label = label;
    this.theme = theme;
    this.renderer = this.createRenderer();
  }

  setTheme(theme: LoadedTheme<Texture> | null): void {
    this.clear();
    this.theme = theme;
    this.renderer = this.createRenderer();
  }

  applyWorld(snapshot: WorldSnapshot, bodies: ReadonlyMap<PlayerId, PlayerBody>): void {
    this.renderer.applyWorld(snapshot);
    if (!this.theme) return;
    const visible = new Set<PlayerId>();
    for (const player of snapshot.state.players) {
      visible.add(player.id);
      let visual = this.actors.get(player.id);
      if (!visual) {
        visual = new PlayerVisual(this.theme, player.role, PLAYER_HEIGHT * 2);
        visual.container.label = player.id;
        this.container.addChild(visual.container);
        this.actors.set(player.id, visual);
      }
      visual.setBody(bodies.get(player.id) ?? player.body);
      visual.setGift(snapshot.state.gifts.some((gift) => gift.ownerRole === player.role && gift.collectedBy === player.id));
      visual.container.visible = player.connected;
    }
    for (const [id, visual] of this.actors) {
      if (visible.has(id)) continue;
      visual.destroy();
      this.actors.delete(id);
    }
  }

  applyFinish(view: FinishView): void {
    const previous = this.finishStage;
    this.finishStage = view.stage;
    for (const [id, visual] of this.actors) {
      const position = view.players.get(id);
      if (position) visual.setPresentation(position.x, position.y, position.facing);
      visual.setExchanged(view.exchange);
      if (view.stage === 'exchange' && previous !== 'exchange') visual.playExchange();
      if ((view.stage === 'happy' || view.stage === 'result') && previous !== 'happy' && previous !== 'result') visual.setHappy();
      visual.setHappyPoseHeld(view.stage === 'happy' || view.stage === 'result');
    }
  }

  updateView(cameraX: number, hintTopY: number): void { this.renderer.updateView(cameraX, hintTopY); }
  advance(deltaMs: number): void { for (const visual of this.actors.values()) visual.advance(deltaMs); }

  destroy(): void {
    this.clear();
    this.container.destroy({ children: true, texture: false, textureSource: false });
  }

  private createRenderer(): LevelRenderer {
    const renderer = new LevelRenderer(this.level, this.theme);
    renderer.container.label = 'level';
    this.container.addChildAt(renderer.container, 0);
    return renderer;
  }

  private clear(): void {
    for (const visual of this.actors.values()) visual.destroy();
    this.actors.clear();
    this.renderer.destroy();
    this.finishStage = 'inactive';
  }
}
