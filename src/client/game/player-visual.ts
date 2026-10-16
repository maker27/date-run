import { AnimatedSprite, Container, Rectangle, Texture } from 'pixi.js';
import type { PlayerBody, Role } from '../../shared/model.js';
import { PlayerAnimation } from './player-animation.js';
import { ANIMATION_STATES, type AnimationState } from '../themes/theme-schema.js';
import type { LoadedTheme } from '../themes/theme-loader.js';

export class PlayerVisual {
  readonly container = new Container();
  readonly sprite: AnimatedSprite;
  private readonly frames = new Map<AnimationState, Texture[]>();
  private readonly animation = new PlayerAnimation();
  private giftVisible = false;
  private readonly gift: AnimatedSprite | null;
  private readonly ownGiftTexture: Texture | null;
  private readonly partnerGiftTexture: Texture | null;
  private readonly giftWidth: number;
  private readonly giftOffset: number;
  private grounded = true;
  private holdHappyPose = false;
  private destroyed = false;

  constructor(theme: LoadedTheme<Texture>, role: Role, displayHeight = 56) {
    this.giftWidth = 26 * displayHeight / 56;
    this.giftOffset = 20 * displayHeight / 56;
    for (const state of ANIMATION_STATES) {
      const ids = theme.manifest.animations[role][state];
      if (!ids) continue;
      const textures = ids.map((id) => {
        const frame = theme.manifest.frames[id];
        if (!frame) throw new Error('Theme frame is missing');
        const page = theme.pages.get(frame.imageKey);
        if (!page) throw new Error('Theme page is missing');
        return new Texture({ source: page.source, frame: new Rectangle(frame.x, frame.y, frame.width, frame.height) });
      });
      this.frames.set(state, textures);
    }
    const idle = this.frames.get('idle');
    if (!idle) throw new Error('Theme idle animation is missing');
    this.sprite = new AnimatedSprite({ textures: idle, autoUpdate: false, autoPlay: false });
    this.sprite.anchor.set(theme.manifest.anchor.x, theme.manifest.anchor.y);
    this.sprite.scale.set(displayHeight / 190);
    this.container.addChild(this.sprite);
    const giftImage = theme.manifest.art?.[role === 'a' ? 'giftA' : 'giftB'];
    const giftTexture = giftImage ? theme.pages.get(giftImage.imageKey) : undefined;
    const partnerImage = theme.manifest.art?.[role === 'a' ? 'giftB' : 'giftA'];
    this.ownGiftTexture = giftTexture ?? null;
    this.partnerGiftTexture = partnerImage ? theme.pages.get(partnerImage.imageKey) ?? null : null;
    this.gift = giftTexture ? new AnimatedSprite({ textures: [giftTexture], autoUpdate: false, autoPlay: false }) : null;
    if (this.gift) {
      this.gift.label = 'carried-gift';
      this.gift.anchor.set(0.5, 0.7);
      this.gift.scale.set(this.giftWidth / this.gift.texture.width);
      this.gift.position.set(this.giftOffset, -displayHeight / 2);
      this.gift.visible = false;
      this.container.addChild(this.gift);
    }
  }
  setState(state: AnimationState): void { this.animation.setState(state); this.syncFrame(); }
  setFacing(dir: -1 | 1): void {
    this.sprite.scale.x = Math.abs(this.sprite.scale.x) * dir;
    if (this.gift) this.gift.position.x = this.giftOffset * dir;
  }
  setBody(body: PlayerBody): void {
    this.container.position.set(body.x + 16, body.y + 56);
    this.setFacing(body.facing);
    if (body.grounded && !this.grounded) this.setState('land');
    else if (!body.grounded) this.setState(body.vy < 0 ? 'jump' : 'fall');
    else this.setState(Math.abs(body.vx) > 5 ? 'run' : 'idle');
    this.grounded = body.grounded;
  }
  setGift(visible: boolean): void {
    if (visible && !this.giftVisible) this.setState('interact');
    this.giftVisible = visible;
    if (this.gift) this.gift.visible = visible && !this.holdHappyPose;
  }
  setExchanged(exchanged: boolean): void {
    if (this.gift) {
      const texture = exchanged ? this.partnerGiftTexture : this.ownGiftTexture;
      if (texture && this.gift.texture !== texture) {
        this.gift.textures = [texture];
        this.gift.scale.set(this.giftWidth / texture.width);
      }
    }
  }
  setPresentation(x: number, y: number, facing: -1 | 1): void {
    this.container.position.set(x + 16, y + 56);
    this.setFacing(facing);
  }
  playExchange(): void { this.setState('interact'); }
  setHappy(): void { this.setState('happy'); }
  setHappyPoseHeld(held: boolean): void {
    if (this.holdHappyPose === held) return;
    this.holdHappyPose = held;
    if (this.gift) this.gift.visible = this.giftVisible && !held;
    this.syncFrame();
  }
  get hasGift(): boolean { return this.giftVisible; }
  advance(deltaMs: number): void { this.animation.advance(deltaMs); this.syncFrame(); }
  private syncFrame(): void {
    if (this.holdHappyPose && this.animation.state !== 'happy') {
      const happy = this.frames.get('happy');
      if (happy) {
        if (this.sprite.textures !== happy) this.sprite.textures = happy;
        this.sprite.gotoAndStop(happy.length - 1);
        return;
      }
    }
    const textures = this.frames.get(this.animation.state);
    if (!textures) throw new Error('Theme animation is missing');
    if (this.sprite.textures !== textures) this.sprite.textures = textures;
    this.sprite.gotoAndStop(this.animation.frameIndex);
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.container.destroy({ children: true, texture: false, textureSource: false });
    for (const textures of this.frames.values()) for (const texture of textures) texture.destroy(false);
    this.frames.clear();
  }
}
