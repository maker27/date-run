export class Histogram {
  private readonly counts = new Uint32Array(128);
  private count = 0;
  private max = 0;

  record(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const bucket = Math.min(this.counts.length - 1, Math.floor(value / 4));
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1;
    this.count += 1;
    this.max = Math.max(this.max, value);
  }

  percentile(fraction: number): number {
    if (!this.count) return 0;
    const target = Math.ceil(this.count * fraction);
    let seen = 0;
    for (let index = 0; index < this.counts.length; index += 1) {
      seen += this.counts[index] ?? 0;
      if (seen >= target) return index === this.counts.length - 1 ? this.max : Math.min(this.max, (index + 1) * 4);
    }
    return this.max;
  }

  reset(): void { this.counts.fill(0); this.count = 0; this.max = 0; }
}

export interface LoadReport {
  activePlayingRooms: number;
  completedRooms: number;
  snapshots: number;
  inputsSent: number;
  inputHzPerClient: number;
  expectedLateInputs: number;
  snapshotAgeP95Ms: number;
  unexpectedDisconnects: number;
  reconnectsRecovered: number;
  acceptedGifts: number;
  duplicateGifts: number;
  queueOverflows: number;
  bytesReceivedPerSecond: number;
  bytesSentPerSecond: number;
  errors: string[];
}

export class ReportCollector {
  readonly snapshotAges = new Histogram();
  readonly errors: string[] = [];
  snapshots = 0;
  inputsSent = 0;
  expectedLateInputs = 0;
  unexpectedDisconnects = 0;
  reconnectsRecovered = 0;
  acceptedGifts = 0;
  duplicateGifts = 0;
  queueOverflows = 0;
  bytesReceived = 0;
  bytesSent = 0;

  error(message: string): void {
    if (this.errors.length < 32) this.errors.push(message);
  }

  resetMeasurement(): void {
    this.snapshotAges.reset();
    this.snapshots = 0;
    this.inputsSent = 0;
    this.bytesReceived = 0;
    this.bytesSent = 0;
  }

  result(activePlayingRooms: number, completedRooms: number, durationSeconds: number, clients: number): LoadReport {
    return {
      activePlayingRooms,
      completedRooms,
      snapshots: this.snapshots,
      inputsSent: this.inputsSent,
      inputHzPerClient: Math.round(this.inputsSent / durationSeconds / clients * 10) / 10,
      expectedLateInputs: this.expectedLateInputs,
      snapshotAgeP95Ms: this.snapshotAges.percentile(0.95),
      unexpectedDisconnects: this.unexpectedDisconnects,
      reconnectsRecovered: this.reconnectsRecovered,
      acceptedGifts: this.acceptedGifts,
      duplicateGifts: this.duplicateGifts,
      queueOverflows: this.queueOverflows,
      bytesReceivedPerSecond: Math.round(this.bytesReceived / durationSeconds),
      bytesSentPerSecond: Math.round(this.bytesSent / durationSeconds),
      errors: [...this.errors],
    };
  }
}

export function loadFailures(report: LoadReport, options: { rooms: number; clients: number; mode?: 'steady' | 'completion' }): string[] {
  const failures: string[] = [];
  if (report.errors.length) failures.push(`Server/client errors: ${report.errors.join(', ')}`);
  if (report.unexpectedDisconnects) failures.push(`Unexpected disconnects: ${report.unexpectedDisconnects}`);
  if (report.queueOverflows) failures.push(`Input queue overflows: ${report.queueOverflows}`);
  if (report.duplicateGifts) failures.push(`Duplicate gifts: ${report.duplicateGifts}`);
  if (report.snapshots === 0) failures.push('No world snapshots received');
  if (!Number.isFinite(report.snapshotAgeP95Ms) || report.snapshotAgeP95Ms > 200) failures.push(`Snapshot age p95 exceeds 200ms: ${report.snapshotAgeP95Ms}`);
  if (options.mode === 'completion') {
    if (report.completedRooms !== options.rooms) failures.push(`Completed ${report.completedRooms}/${options.rooms} rooms`);
    if (report.acceptedGifts !== options.clients) failures.push(`Collected ${report.acceptedGifts}/${options.clients} gifts`);
  } else {
    if (report.activePlayingRooms !== options.rooms) failures.push(`Active playing rooms: ${report.activePlayingRooms}/${options.rooms}`);
    if (report.inputHzPerClient < 59.4) failures.push(`Input rate below 59.4Hz per client: ${report.inputHzPerClient}`);
    if (options.clients >= 20 && report.reconnectsRecovered !== 20) failures.push(`Recovered reconnects: ${report.reconnectsRecovered}/20`);
  }
  return failures;
}
