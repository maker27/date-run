import { Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { SnowLayer } from './snow-layer.js';

describe('SnowLayer', () => {
  it('keeps a fixed pool of translucent particles inside the resized viewport', () => {
    const layer = new SnowLayer({ width: 640, height: 360, reducedMotion: false, random: () => 0.999 });
    const particles = [...layer.container.children];
    const initialPositions = particles.map(({ x, y }) => [x, y]);

    expect(particles).toHaveLength(64);
    expect(particles.every((particle) => particle instanceof Graphics && particle.alpha > 0 && particle.alpha < 1)).toBe(true);

    layer.advance(1000);
    expect(particles.map(({ x, y }) => [x, y])).not.toEqual(initialPositions);

    for (let index = 0; index < 240; index += 1) {
      layer.advance(16.67);
      layer.resize(index % 2 === 0 ? 320 : 240, index % 2 === 0 ? 180 : 120);
    }

    expect(layer.container.children).toEqual(particles);
    expect(layer.container.children).toHaveLength(64);
    for (const particle of particles) {
      expect(particle.x).toBeGreaterThanOrEqual(0);
      expect(particle.x).toBeLessThan(240);
      expect(particle.y).toBeGreaterThanOrEqual(0);
      expect(particle.y).toBeLessThan(120);
    }
    layer.destroy();
  });

  it('creates no particles when reduced motion is enabled', () => {
    const layer = new SnowLayer({ width: 390, height: 844, reducedMotion: true, random: () => 0.5 });

    expect(layer.container.children).toHaveLength(0);
    layer.advance(1000);
    layer.resize(844, 390);
    expect(layer.container.children).toHaveLength(0);
    layer.destroy();
  });

  it('destroys the container and particles safely when called more than once', () => {
    const layer = new SnowLayer({ width: 800, height: 600, reducedMotion: false, random: () => 0.5 });
    const particles = [...layer.container.children];

    layer.destroy();
    layer.destroy();

    expect(layer.container.destroyed).toBe(true);
    expect(particles.every((particle) => particle.destroyed)).toBe(true);
  });
});
