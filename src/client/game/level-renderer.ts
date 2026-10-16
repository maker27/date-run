import { AnimatedSprite, Container, Graphics, Texture } from 'pixi.js';
import type { LevelDefinition } from '../../shared/level.js';
import type { WorldSnapshot } from '../../shared/model.js';
import type { LoadedTheme } from '../themes/theme-loader.js';
import type { ThemeArtKind } from '../themes/theme-schema.js';
import { createObstacle } from './obstacle-visual.js';

export class LevelRenderer {
  readonly container = new Container();
  private readonly gate: AnimatedSprite | Graphics;
  private readonly gateHint: Graphics | null;
  private readonly finishHint = new Container();
  private readonly gifts = new Map<string, AnimatedSprite | Graphics>();
  private readonly switches = new Map<string, AnimatedSprite | Graphics>();
  private readonly plateHints = new Map<string, Container>();
  private readonly background: AnimatedSprite[] = [];
  private readonly backgroundWidth: number;
  private readonly art: LoadedTheme<Texture>['manifest']['art'];
  private readonly theme: LoadedTheme<Texture> | null;

  constructor(level: LevelDefinition, theme: LoadedTheme<Texture> | null = null) {
    this.theme = theme;
    this.art = theme?.manifest.art;
    const background = this.art ? this.texture('background') : null;
    this.backgroundWidth = background ? 1024 : 0;
    if (background) {
      for (let index = 0; index < 3; index += 1) {
        const tile = this.image(background);
        tile.width = this.backgroundWidth;
        tile.height = this.backgroundWidth * background.height / background.width;
        tile.position.set(index * this.backgroundWidth, level.groundY - tile.height);
        this.background.push(tile);
        this.container.addChild(tile);
      }
    }
    this.drawGround(level);
    for (const solid of level.solids) this.container.addChild(createObstacle(solid, theme?.themeId ?? 'first-date', 'solid'));
    for (const platform of level.oneWays) this.container.addChild(createObstacle(platform, theme?.themeId ?? 'first-date', 'platform'));
    if (this.art) {
      const finishTexture = this.texture('finish');
      const finish = this.image(finishTexture);
      finish.anchor.set(0.5, 1);
      finish.scale.set(Math.min(340 / finishTexture.width, 440 / finishTexture.height));
      finish.position.set(level.finish.x + level.finish.width / 2, level.groundY);
      this.container.addChild(finish);
      this.gateHint = this.rectangle(level.gate.x, level.gate.y, level.gate.width, level.gate.height, 0xc45b63, 0.35);
      const gate = this.image(this.texture('gateClosed'));
      gate.label = 'gate';
      gate.anchor.set(0.5, 1);
      gate.scale.set(Math.min(96 / gate.texture.width, 240 / gate.texture.height));
      gate.position.set(level.gate.x + level.gate.width / 2, level.groundY);
      this.gate = gate;
      this.container.addChild(gate);
      for (const gift of level.gifts) {
        const graphic = this.image(this.texture(gift.ownerRole === 'a' ? 'giftA' : 'giftB'));
        graphic.label = gift.id;
        graphic.anchor.set(0.5, 1);
        graphic.scale.set(36 / graphic.texture.width);
        graphic.position.set(gift.position.x, gift.position.y + 12);
        this.gifts.set(gift.id, graphic);
        this.container.addChild(graphic);
      }
      for (const entry of level.switches) {
        const graphic = this.image(this.texture('plateIdle'));
        graphic.label = entry.id;
        graphic.width = entry.bounds.width;
        graphic.height = entry.bounds.height;
        graphic.position.set(entry.bounds.x, entry.bounds.y);
        this.switches.set(entry.id, graphic);
        this.container.addChild(graphic);
      }
    } else {
      this.gateHint = null;
      this.rectangle(level.finish.x, level.finish.y, level.finish.width, level.finish.height, 0x78aa89, 0.18);
      this.gate = this.rectangle(level.gate.x, level.gate.y, level.gate.width, level.gate.height, 0xc45b63);
      for (const gift of level.gifts) this.gifts.set(gift.id, this.rectangle(gift.position.x - 12, gift.position.y - 12, 24, 24, 0xf2c66d));
      for (const entry of level.switches) this.switches.set(entry.id, this.rectangle(entry.bounds.x, entry.bounds.y, entry.bounds.width, entry.bounds.height, 0xf1a96a));
    }
    this.finishHint.label = 'finish-hint';
    this.finishHint.position.set(level.finish.x + level.finish.width / 2, level.groundY);
    this.finishHint.visible = false;
    const glow = new Graphics()
      .roundRect(-level.finish.width / 2, -level.finish.height, level.finish.width, level.finish.height, 24)
      .fill({ color: 0xf6ce73, alpha: 0.24 })
      .stroke({ color: 0xf6ce73, alpha: 0.9, width: 3 });
    glow.label = 'finish-glow';
    const archGlow = new Graphics().roundRect(-170, -440, 340, 440, 150)
      .stroke({ color: 0xf6ce73, alpha: 0.65, width: 6 });
    archGlow.label = 'finish-arch-glow';
    const halo = new Graphics().ellipse(0, -5, 155, 22).fill({ color: 0xf6ce73, alpha: 0.45 });
    const arrow = new Graphics()
      .poly([-18, 0, -7, 0, -7, -25, 7, -25, 7, 0, 18, 0, 0, 20])
      .fill(0xf6ce73)
      .stroke({ color: 0x352538, width: 3 });
    arrow.label = 'finish-arrow';
    arrow.y = -470;
    this.finishHint.addChild(archGlow, glow, halo, arrow);
    this.container.addChild(this.finishHint);
    for (const entry of level.switches) {
      const hint = new Container();
      hint.label = `plate-hint-${entry.id}`;
      hint.position.set(entry.bounds.x + entry.bounds.width / 2, entry.bounds.y);
      const ring = new Graphics().circle(0, 0, 27).fill(0xf6ce73).circle(0, 0, 20).fill(0x352538);
      ring.scale.y = 0.3;
      const occupied = new Graphics().circle(0, 0, 19).fill(0xf6ce73);
      occupied.label = 'occupied';
      occupied.scale.y = 0.3;
      occupied.visible = false;
      const arrow = new Graphics().rect(-3, -51, 6, 22).fill(0xf6ce73);
      const tip = new Graphics().rect(-6, -6, 12, 12).fill(0xf6ce73);
      tip.rotation = Math.PI / 4;
      tip.y = -30;
      hint.addChild(ring, occupied, arrow, tip);
      this.plateHints.set(entry.id, hint);
      this.container.addChild(hint);
    }
  }

  applyWorld(snapshot: WorldSnapshot): void {
    this.finishHint.visible = snapshot.state.phase === 'playing' && snapshot.state.gateOpen;
    if (this.gateHint) this.gateHint.visible = !snapshot.state.gateOpen;
    if (this.gate instanceof AnimatedSprite && this.art) {
      const texture = this.texture(snapshot.state.gateOpen ? 'gateOpen' : 'gateClosed');
      if (this.gate.texture !== texture) this.gate.textures = [texture];
    }
    else this.gate.visible = !snapshot.state.gateOpen;
    for (const gift of snapshot.state.gifts) {
      const graphic = this.gifts.get(gift.id);
      if (graphic) graphic.visible = gift.collectedBy === null;
    }
    for (const entry of snapshot.state.switches) {
      const hint = this.plateHints.get(entry.id);
      if (hint) {
        hint.visible = snapshot.state.phase === 'playing' && !snapshot.state.gateOpen;
        const occupied = hint.getChildByLabel('occupied');
        if (occupied) occupied.visible = entry.occupant !== null;
      }
      const graphic = this.switches.get(entry.id);
      if (graphic instanceof AnimatedSprite && this.art) {
        const texture = this.texture(entry.occupant === null ? 'plateIdle' : 'plateActive');
        if (graphic.texture !== texture) graphic.textures = [texture];
      }
      else if (graphic) graphic.tint = entry.occupant === null ? 0xffffff : 0x92f09e;
    }
  }

  private drawGround(level: LevelDefinition): void {
    const palette = this.theme?.themeId === 'winter'
      ? { base: 0xc6d3d9, edge: 0xe8ece6, joint: 0x9dabb9 }
      : this.theme?.themeId === 'retro'
        ? { base: 0x6c4c48, edge: 0xa57c65, joint: 0x49373b }
        : { base: 0x795846, edge: 0xad7959, joint: 0x563e37 };
    const height = level.bounds.y + level.bounds.height - level.groundY;
    const ground = new Container();
    ground.label = 'ground';
    ground.position.set(level.bounds.x, level.groundY);
    ground.addChild(new Graphics().rect(0, 0, level.bounds.width, height).fill(palette.base));
    const paving = new Graphics().rect(0, 0, level.bounds.width, 7).fill(palette.edge);
    for (let y = 28; y < height; y += 28) {
      paving.rect(0, y, level.bounds.width, 2).fill({ color: palette.joint, alpha: 0.5 });
      for (let x = (y / 28 % 2) * 48; x < level.bounds.width; x += 96) {
        paving.rect(x, y - 21, 2, 21).fill({ color: palette.joint, alpha: 0.35 });
      }
    }
    ground.addChild(paving);
    this.container.addChild(ground);
  }

  updateView(cameraX: number, hintTopY: number): void {
    const arrow = this.finishHint.getChildByLabel('finish-arrow');
    if (arrow) arrow.y = Math.max(-470, hintTopY - this.finishHint.y + 28);
    if (this.backgroundWidth === 0) return;
    const first = Math.floor(cameraX / this.backgroundWidth) - 1;
    for (let index = 0; index < this.background.length; index += 1) {
      const tile = this.background[index];
      if (!tile) continue;
      const tileIndex = first + index;
      const mirrored = Math.abs(tileIndex % 2) === 1;
      tile.scale.x = Math.abs(tile.scale.x) * (mirrored ? -1 : 1);
      tile.x = (tileIndex + (mirrored ? 1 : 0)) * this.backgroundWidth;
    }
  }

  private texture(kind: ThemeArtKind): Texture {
    const key = this.art?.[kind].imageKey;
    const texture = key ? this.theme?.pages.get(key) : undefined;
    if (!texture) throw new Error('Theme art image is missing');
    return texture;
  }

  private image(texture: Texture): AnimatedSprite {
    return new AnimatedSprite({ textures: [texture], autoUpdate: false, autoPlay: false });
  }

  private rectangle(x: number, y: number, width: number, height: number, color: number, alpha = 1): Graphics {
    const graphic = new Graphics().rect(0, 0, width, height).fill({ color, alpha });
    graphic.position.set(x, y);
    this.container.addChild(graphic);
    return graphic;
  }

  destroy(): void { this.container.destroy({ children: true, texture: false, textureSource: false }); }
}
