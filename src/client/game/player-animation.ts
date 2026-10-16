import { ANIMATION_SPECS, type AnimationState } from '../themes/theme-schema.js';

function isOneShot(state: AnimationState): boolean { return !ANIMATION_SPECS[state].loop; }

export class PlayerAnimation {
  private current: AnimationState;
  private locomotion: AnimationState;
  private elapsed = 0;
  private index = 0;
  constructor(initialState: AnimationState = 'idle') {
    this.current = initialState;
    this.locomotion = isOneShot(initialState) ? 'idle' : initialState;
  }
  get state(): AnimationState { return this.current; }
  get frameIndex(): number { return this.index; }
  setState(state: AnimationState): void {
    if (!isOneShot(state)) {
      this.locomotion = state;
      if (isOneShot(this.current)) return;
    }
    if (state === this.current) return;
    this.current = state;
    this.elapsed = 0;
    this.index = 0;
  }
  advance(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError('Invalid elapsed time');
    this.elapsed += deltaMs;
    for (;;) {
      const spec = ANIMATION_SPECS[this.current];
      if (spec.fps === 0) return;
      const frameDuration = 1000 / spec.fps;
      const steps = Math.floor(this.elapsed / frameDuration + 1e-9);
      if (isOneShot(this.current) && steps >= spec.frameCount) {
        this.elapsed = Math.max(0, this.elapsed - spec.frameCount * frameDuration);
        this.current = this.locomotion;
        this.index = 0;
        continue;
      }
      this.index = steps % spec.frameCount;
      if (spec.loop) this.elapsed = Math.max(0, this.elapsed - Math.floor(steps / spec.frameCount) * spec.frameCount * frameDuration);
      return;
    }
  }
}
