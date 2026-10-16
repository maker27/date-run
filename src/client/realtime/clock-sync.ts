interface ClockSample {
  roundTripTime: number;
  offset: number;
}

export class ClockSync {
  private readonly samples: ClockSample[] = [];

  record(sentAt: number, receivedAt: number, serverTime: number): boolean {
    if (![sentAt, receivedAt, serverTime].every((time) => Number.isFinite(time) && time >= 0)
      || receivedAt < sentAt) return false;

    const roundTripTime = receivedAt - sentAt;
    const offset = serverTime - (sentAt + roundTripTime / 2);
    if (!Number.isFinite(offset)) return false;
    this.samples.push({
      roundTripTime,
      offset,
    });
    if (this.samples.length > 8) this.samples.shift();
    return true;
  }

  serverNow(clientNow: number): number | null {
    const [first, ...rest] = this.samples;
    if (!first) return null;
    let best = first;
    for (const sample of rest) {
      if (sample.roundTripTime <= best.roundTripTime) best = sample;
    }
    return clientNow + best.offset;
  }

  reset(): void {
    this.samples.length = 0;
  }
}
