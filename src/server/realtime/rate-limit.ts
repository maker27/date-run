interface BucketOptions {
  capacity: number;
  refillPerSecond: number;
  maxKeys?: number;
  idleMs?: number;
}

interface BucketEntry {
  tokens: number;
  lastSeen: number;
  lastUsed: number;
}

export class TokenBucket {
  private readonly entries = new Map<string, BucketEntry>();
  private readonly maxKeys: number;
  private readonly idleMs: number;

  constructor(private readonly options: BucketOptions) {
    this.maxKeys = options.maxKeys ?? 10_000;
    this.idleMs = options.idleMs ?? 600_000;
  }

  take(key: string, now: number): boolean {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) this.evict(now);
      if (this.entries.size >= this.maxKeys) return false;
      entry = { tokens: this.options.capacity, lastSeen: now, lastUsed: now };
      this.entries.set(key, entry);
    }
    const elapsed = Math.max(0, now - entry.lastSeen);
    entry.tokens = Math.min(this.options.capacity, entry.tokens + elapsed * this.options.refillPerSecond / 1000);
    entry.lastSeen = Math.max(entry.lastSeen, now);
    entry.lastUsed = Math.max(entry.lastUsed, now);
    if (entry.tokens < 1) return false;
    entry.tokens -= 1;
    return true;
  }

  evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed >= this.idleMs) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }
}
