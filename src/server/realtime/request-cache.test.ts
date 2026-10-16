import { describe, expect, it } from 'vitest';
import { RequestCache } from './request-cache.js';

describe('RequestCache', () => {
  it('returns a hit for duplicate payloads with canonical nested object ordering', () => {
    const cache = new RequestCache<{ accepted: boolean }>();
    cache.record('request-1', { outer: { second: 2, first: 1 }, list: [{ z: true, a: false }] }, { accepted: true }, 100);

    expect(cache.lookup('request-1', { list: [{ a: false, z: true }], outer: { first: 1, second: 2 } }, 101))
      .toEqual({ kind: 'hit', response: { accepted: true } });
  });

  it('reports conflicts for changed values and array order', () => {
    const cache = new RequestCache<string>();
    cache.record('request-1', { values: [1, 2], enabled: true }, 'accepted', 0);

    expect(cache.lookup('request-1', { enabled: false, values: [1, 2] }, 1)).toEqual({ kind: 'conflict' });
    expect(cache.lookup('request-1', { enabled: true, values: [2, 1] }, 1)).toEqual({ kind: 'conflict' });
  });

  it('treats expiry as inclusive and does not refresh expiry on lookup', () => {
    const cache = new RequestCache<string>({ ttlMs: 30_000 });
    cache.record('request-1', { value: 'same' }, 'accepted', 10);

    expect(cache.lookup('request-1', { value: 'same' }, 30_009)).toEqual({ kind: 'hit', response: 'accepted' });
    expect(cache.lookup('request-1', { value: 'same' }, 30_010)).toEqual({ kind: 'miss' });
    expect(cache.size()).toBe(0);
  });

  it('keeps FIFO capacity at 128 entries and evicts the oldest entry', () => {
    const cache = new RequestCache<number>();
    for (let index = 0; index < 128; index += 1) cache.record(`request-${index}`, { index }, index, 0);
    expect(cache.size()).toBe(128);

    cache.record('request-128', { index: 128 }, 128, 1);
    expect(cache.size()).toBe(128);
    expect(cache.lookup('request-0', { index: 0 }, 1)).toEqual({ kind: 'miss' });
    expect(cache.lookup('request-1', { index: 1 }, 1)).toEqual({ kind: 'hit', response: 1 });
  });
});
