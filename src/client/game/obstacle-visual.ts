import { Container, Graphics } from 'pixi.js';
import type { Rect, ThemeId } from '../../shared/model.js';

export function createObstacle(bounds: Rect, theme: ThemeId, kind: 'solid' | 'platform'): Container {
  const obstacle = new Container();
  obstacle.position.set(bounds.x, bounds.y);
  const { width: w, height: h } = bounds;
  if (kind === 'solid') {
    const shape = new Graphics();
    if (theme === 'retro') {
      obstacle.label = 'luggage';
      shape.roundRect(w * 0.3, 0, w * 0.4, h * 0.19, 5).fill(0xdbc291)
        .roundRect(w * 0.37, h * 0.05, w * 0.26, h * 0.1, 2).fill(0x4b343b)
        .roundRect(0, h * 0.13, w, h * 0.87, 7).fill(0x6d3946)
        .roundRect(3, h * 0.18, w - 6, h * 0.76, 5).fill(0xa85b58);
      for (const x of [w * 0.2, w * 0.72]) {
        shape.rect(x, h * 0.13, w * 0.08, h * 0.87).fill(0xd3aa72)
          .roundRect(x - 2, h * 0.4, w * 0.08 + 4, 9, 2).fill(0xefd7a1);
      }
      shape.roundRect(w * 0.42, h * 0.48, w * 0.19, h * 0.24, 2).fill(0xf0d9ad)
        .circle(w * 0.51, h * 0.58, 3).fill(0x9a544f);
    } else if (theme === 'winter') {
      obstacle.label = 'snowbank';
      shape.roundRect(0, 0, w, h, 9).fill(0x8daebf)
        .roundRect(3, 3, w - 6, h - 6, 8).fill(0xb9d5df)
        .roundRect(0, 0, w, h * 0.27, 9).fill(0xf5f2e7)
        .ellipse(w * 0.3, h * 0.24, w * 0.2, h * 0.13).fill(0xf5f2e7)
        .roundRect(w * 0.69, h * 0.18, w * 0.09, h * 0.33, 3).fill(0xe6f0ed)
        .poly([w * 0.14, h * 0.47, w * 0.39, h * 0.37, w * 0.28, h * 0.74]).fill(0xdce8e7)
        .rect(w * 0.08, h * 0.83, w * 0.84, h * 0.05).fill(0x7896ac);
    } else {
      obstacle.label = 'planter';
      shape.roundRect(0, h * 0.28, w, h * 0.72, 5).fill(0x92523e)
        .rect(5, h * 0.38, w - 10, h * 0.54).fill(0xb77c56);
      for (let x = 14; x < w - 7; x += 17) shape.rect(x, h * 0.4, 3, h * 0.49).fill(0x92523e);
      shape.roundRect(0, h * 0.27, w, h * 0.16, 3).fill(0xd4a16e)
        .roundRect(0, 0, w, h * 0.3, 10).fill(0x455d45)
        .ellipse(w * 0.27, h * 0.13, w * 0.2, h * 0.12).fill(0x728456)
        .ellipse(w * 0.72, h * 0.16, w * 0.2, h * 0.12).fill(0x728456);
      for (const x of [w * 0.2, w * 0.51, w * 0.81]) {
        shape.circle(x, h * 0.16, 5).fill(0xd98b83).circle(x, h * 0.16, 2).fill(0xf4d29a);
      }
    }
    obstacle.addChild(shape);
    return obstacle;
  }

  const label = theme === 'retro' ? 'counter' : theme === 'winter' ? 'ice-shelf' : 'bench';
  obstacle.label = label;
  const surface = new Graphics();
  surface.label = 'collision-surface';
  const support = new Graphics();
  support.label = label;
  support.y = h;
  const legHeight = 92;
  if (theme === 'retro') {
    surface.roundRect(0, 0, w, h, 4).fill(0xead5b7).rect(0, h - 4, w, 4).fill(0x9f5754);
    support.rect(12, 0, w - 24, legHeight).fill(0x6f4148)
      .rect(18, 5, w - 36, legHeight - 12).fill(0xba6c63)
      .rect(12, legHeight - 9, w - 24, 9).fill(0xd3ad78);
    for (let x = 28; x < w - 20; x += 32) support.rect(x, 10, 3, legHeight - 27).fill(0xe0b393);
  } else if (theme === 'winter') {
    surface.roundRect(0, 0, w, h, 5).fill(0xf5f2e7).rect(0, h - 5, w, 5).fill(0xb1d5e0);
    for (const x of [18, w - 50]) {
      support.poly([x, 0, x + 32, 0, x + 38, legHeight, x - 6, legHeight]).fill(0x94b9cd)
        .poly([x + 3, 0, x + 14, 0, x + 8, legHeight - 3, x - 2, legHeight - 3]).fill(0xc8e0e6);
    }
    for (let x = 65; x < w - 55; x += 27) support.poly([x, 0, x + 10, 0, x + 4, 23]).fill(0xd2e6e9);
  } else {
    surface.roundRect(0, 0, w, h, 3).fill(0x7d4b3b).rect(0, 2, w, 4).fill(0xc29666)
      .rect(0, h - 4, w, 2).fill(0xa36c4b);
    for (const x of [22, w - 38]) {
      support.roundRect(x, 0, 16, legHeight, 3).fill(0x354c48)
        .roundRect(x - 9, legHeight - 7, 34, 7, 2).fill(0x354c48);
    }
    support.rect(33, 24, w - 66, 7).fill(0x354c48);
  }
  obstacle.addChild(support, surface);
  return obstacle;
}
