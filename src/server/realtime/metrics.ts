export class RealtimeMetrics {
  steps = 0;
  droppedSimulationMs = 0;
  backpressureSkips = 0;
  private readonly bins = [0, 0, 0, 0, 0, 0, 0, 0];
  private readonly limits = [0.25, 0.5, 1, 2, 4, 8, 16, Infinity];
  private maxDuration = 0;
  constructor(private readonly counts: () => { queuedInputs: number; socketCount: number; roomCount: number; occupiedPlaces: number } = () => ({ queuedInputs: 0, socketCount: 0, roomCount: 0, occupiedPlaces: 0 })) {}
  recordTick(duration: number): void {
    const value = Math.max(0, duration);
    const index = this.limits.findIndex((limit) => value <= limit);
    this.bins[index] = (this.bins[index] ?? 0) + 1;
    this.maxDuration = Math.max(this.maxDuration, value);
  }
  snapshot() {
    const count = this.bins.reduce((sum, value) => sum + value, 0);
    const percentile = (fraction: number) => {
      if (!count) return 0;
      const target = Math.ceil(count * fraction);
      let seen = 0;
      for (let index = 0; index < this.bins.length; index += 1) {
        seen += this.bins[index] ?? 0;
        if (seen >= target) return Math.min(this.limits[index] ?? 0, this.maxDuration);
      }
      return this.maxDuration;
    };
    return { steps: this.steps, droppedSimulationMs: this.droppedSimulationMs, backpressureSkips: this.backpressureSkips, ...this.counts(), tickDuration: { count, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: this.maxDuration } };
  }
}
