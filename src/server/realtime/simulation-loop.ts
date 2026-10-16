import { STEP_SECONDS } from '../../shared/timing.js';

interface LoopOptions { clock: () => number; step: () => void; snapshot: () => void; onDropped?: (ms: number) => void; onTickDuration?: (ms: number) => void }
export class SimulationLoop {
  private lastNow: number;
  private remainder = 0;
  private steps = 0;
  private stopped = false;
  constructor(private readonly options: LoopOptions) { this.lastNow = options.clock(); }
  advance(now: number): void {
    if (this.stopped || now < this.lastNow) return;
    this.remainder += now - this.lastNow;
    this.lastNow = now;
    const stepMs = STEP_SECONDS * 1000;
    const available = Math.floor((this.remainder + 1e-7) / stepMs);
    const dropped = Math.max(0, available - 5);
    if (dropped) { this.remainder -= dropped * stepMs; this.options.onDropped?.(dropped * stepMs); }
    for (let index = 0; index < Math.min(available, 5); index += 1) {
      const startedAt = performance.now();
      this.remainder -= stepMs;
      this.options.step();
      this.steps += 1;
      if (this.steps % 3 === 0) this.options.snapshot();
      this.options.onTickDuration?.(performance.now() - startedAt);
    }
  }
  stop(): void { this.stopped = true; }
}
