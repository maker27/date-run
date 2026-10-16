interface CacheOptions {
  capacity?: number;
  ttlMs?: number;
}

export type CacheResult<T> = { kind: 'miss' } | { kind: 'conflict' } | { kind: 'hit'; response: T };

interface CacheEntry<T> {
  payload: string;
  response: T;
  expiresAt: number;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current;
    return Object.fromEntries(Object.entries(current).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export class RequestCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(options: CacheOptions = {}) {
    this.capacity = options.capacity ?? 128;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  lookup(requestId: string, payload: unknown, now: number): CacheResult<T> {
    const entry = this.entries.get(requestId);
    if (!entry) return { kind: 'miss' };
    if (now >= entry.expiresAt) {
      this.entries.delete(requestId);
      return { kind: 'miss' };
    }
    if (entry.payload !== canonicalJson(payload)) return { kind: 'conflict' };
    return { kind: 'hit', response: entry.response };
  }

  record(requestId: string, payload: unknown, response: T, now: number): void {
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
    this.entries.delete(requestId);
    if (this.capacity <= 0) return;
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(requestId, { payload: canonicalJson(payload), response, expiresAt: now + this.ttlMs });
  }

  size(): number {
    return this.entries.size;
  }
}
