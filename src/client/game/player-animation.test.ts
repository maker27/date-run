import { describe, expect, it } from 'vitest';
import { ANIMATION_SPECS } from '../themes/theme-schema.js';
import { PlayerAnimation } from './player-animation.js';

describe('player animation', () => {
  it('uses the contracted frame counts for every state', () => {
    expect(Object.fromEntries(Object.entries(ANIMATION_SPECS).map(([state, spec]) => [state, spec.frameCount]))).toEqual({
      idle: 4,
      run: 8,
      jump: 1,
      fall: 1,
      land: 2,
      interact: 4,
      happy: 6,
    });
  });

  it('keeps a looping state phase when the same state is selected again', () => {
    const animation = new PlayerAnimation('idle');
    animation.advance(125);
    expect(animation.frameIndex).toBe(1);

    animation.setState('idle');
    animation.advance(125);

    expect(animation.state).toBe('idle');
    expect(animation.frameIndex).toBe(2);
  });

  it('advances every run frame at 12 FPS without phase drift across repeated steps', () => {
    const animation = new PlayerAnimation('run');

    for (let step = 1; step <= 24; step += 1) {
      animation.advance(1000 / 12);
      expect(animation.frameIndex).toBe(step % 8);
      if (step === 3 || step === 11 || step === 19) animation.setState('run');
    }
  });

  it('plays both land frames at 12 FPS and returns to the latest locomotion state', () => {
    const animation = new PlayerAnimation('run');
    animation.setState('land');
    expect(animation.frameIndex).toBe(0);

    animation.advance(1000 / 12);
    expect(animation.state).toBe('land');
    expect(animation.frameIndex).toBe(1);

    animation.setState('idle');
    animation.advance(1000 / 12);

    expect(animation.state).toBe('idle');
    expect(animation.frameIndex).toBe(0);
  });

  it('returns from a one-shot to the latest locomotion state', () => {
    const animation = new PlayerAnimation('run');
    animation.setState('interact');
    animation.setState('idle');
    animation.advance(500);

    expect(animation.state).toBe('idle');
    expect(animation.frameIndex).toBe(0);
  });

  it('does not restart the same one-shot and carries leftover time into locomotion', () => {
    const animation = new PlayerAnimation('run');
    animation.setState('interact');
    animation.advance(125);
    expect(animation.frameIndex).toBe(1);

    animation.setState('interact');
    animation.advance(500);

    expect(animation.state).toBe('run');
    expect(animation.frameIndex).toBe(1);
  });

  it('lets a different explicit one-shot replace the current one', () => {
    const animation = new PlayerAnimation('run');
    animation.setState('interact');
    animation.advance(125);
    animation.setState('land');

    expect(animation.state).toBe('land');
    expect(animation.frameIndex).toBe(0);
    animation.advance(167);
    expect(animation.state).toBe('run');
  });

  it('holds the single jump and fall frames', () => {
    const animation = new PlayerAnimation('jump');
    animation.advance(10_000);
    expect(animation.state).toBe('jump');
    expect(animation.frameIndex).toBe(0);

    animation.setState('fall');
    animation.advance(10_000);
    expect(animation.state).toBe('fall');
    expect(animation.frameIndex).toBe(0);
  });

  it('rejects invalid elapsed time', () => {
    const animation = new PlayerAnimation();
    expect(() => animation.advance(-1)).toThrow(RangeError);
    expect(() => animation.advance(Number.NaN)).toThrow(RangeError);
    expect(() => animation.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
