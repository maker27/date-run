import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestId } from './request-id.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('createRequestId', () => {
  it.each([
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  ])('serializes random byte %i with UUID v4 version and variant bits', (byte, expected) => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(byte) });
    expect(createRequestId()).toBe(expected);
  });
});
