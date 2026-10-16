import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('starts at capacity and refills fractionally at the exact time boundary', () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2 });

    expect(bucket.take('ip', 0)).toBe(true);
    expect(bucket.take('ip', 0)).toBe(true);
    expect(bucket.take('ip', 0)).toBe(true);
    expect(bucket.take('ip', 0)).toBe(false);
    expect(bucket.take('ip', 499)).toBe(false);
    expect(bucket.take('ip', 500)).toBe(true);
    expect(bucket.take('ip', 500)).toBe(false);
  });

  it('caps refills, ignores backward clock movement, and does not mint credit', () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1 });

    expect(bucket.take('peer', 1000)).toBe(true);
    expect(bucket.take('peer', 1000)).toBe(true);
    expect(bucket.take('peer', 3000)).toBe(true);
    expect(bucket.take('peer', 3000)).toBe(true);
    expect(bucket.take('peer', 2000)).toBe(false);
    expect(bucket.take('peer', 4000)).toBe(true);
  });

  it('evicts idle keys at the boundary and refuses new keys at capacity without resetting live limits', () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, maxKeys: 2, idleMs: 100 });

    expect(bucket.take('one', 0)).toBe(true);
    expect(bucket.take('two', 0)).toBe(true);
    expect(bucket.take('one', 10)).toBe(false);
    expect(bucket.take('new', 10)).toBe(false);
    expect(bucket.size()).toBe(2);
    expect(bucket.take('one', 50)).toBe(false);

    bucket.evict(100);
    expect(bucket.size()).toBe(1);
    bucket.evict(150);
    expect(bucket.size()).toBe(0);
    expect(bucket.take('new', 150)).toBe(true);
  });
});
