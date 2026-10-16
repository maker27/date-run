import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from './room-code.js';

describe('normalizeRoomCode', () => {
  it('trims surrounding whitespace and normalizes ASCII letters to uppercase', () => {
    expect(normalizeRoomCode(' abcd2345 ')).toBe('ABCD2345');
  });

  it('rejects invalid lengths and characters outside the room-code alphabet', () => {
    expect(normalizeRoomCode('ABC2345')).toBeNull();
    expect(normalizeRoomCode('ABCD23456')).toBeNull();
    expect(normalizeRoomCode('ABCDI345')).toBeNull();
    expect(normalizeRoomCode('АBCD2345')).toBeNull();
  });
});
