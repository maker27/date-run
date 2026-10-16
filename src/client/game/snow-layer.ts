import { Container, Graphics } from 'pixi.js';

type Flake = { graphic: Graphics; speed: number; drift: number };

export class SnowLayer {
  readonly container = new Container();
  private readonly flakes: Flake[] = [];
  private width: number;
  private height: number;
  private destroyed = false;

  constructor(options: { width: number; height: number; reducedMotion: boolean; random?: () => number }) {
    this.container.label = 'snow';
    this.container.eventMode = 'none';
    this.width = Math.max(1, options.width);
    this.height = Math.max(1, options.height);
    if (options.reducedMotion) return;
    const random = options.random ?? Math.random;
    for (let index = 0; index < 64; index += 1) {
      const graphic = new Graphics().circle(0, 0, 1 + random() * 1.5).fill(0xffffff);
      graphic.alpha = 0.28 + random() * 0.35;
      graphic.position.set(random() * this.width, random() * this.height);
      this.container.addChild(graphic);
      this.flakes.push({ graphic, speed: 22 + random() * 42, drift: 4 + random() * 13 });
    }
  }

  advance(deltaMs: number): void {
    if (this.destroyed || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const seconds = deltaMs / 1000;
    for (const { graphic, speed, drift } of this.flakes) {
      graphic.x = (graphic.x + drift * seconds) % this.width;
      graphic.y = (graphic.y + speed * seconds) % this.height;
    }
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    for (const { graphic } of this.flakes) {
      graphic.x %= this.width;
      graphic.y %= this.height;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.container.destroy({ children: true });
    this.flakes.length = 0;
  }
}
