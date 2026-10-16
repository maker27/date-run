import { describe, expect, it } from 'vitest';
import { ClockSync } from './clock-sync.js';

describe('ClockSync', () => {
  it('maps client time with the offset from a valid sample', () => {
    const clock = new ClockSync();

    expect(clock.record(100, 200, 1150)).toBe(true);
    expect(clock.serverNow(500)).toBe(1500);
  });

  it('rejects negative RTT and invalid timestamps without replacing a valid sample', () => {
    const clock = new ClockSync();
    clock.record(100, 200, 1150);

    expect(clock.record(200, 100, 900)).toBe(false);
    expect(clock.record(Number.NaN, 200, 900)).toBe(false);
    expect(clock.record(100, Number.POSITIVE_INFINITY, 900)).toBe(false);
    expect(clock.record(-1, 200, 900)).toBe(false);
    expect(clock.serverNow(500)).toBe(1500);
  });

  it('keeps finite MAX_VALUE timestamps valid without overflowing the midpoint', () => {
    const clock = new ClockSync();

    expect(clock.record(Number.MAX_VALUE, Number.MAX_VALUE, 0)).toBe(true);
    expect(clock.serverNow(Number.MAX_VALUE)).toBe(0);
  });

  it('chooses minimum RTT among the latest eight samples and evicts older samples', () => {
    const clock = new ClockSync();
    for (let index = 0; index < 8; index += 1) {
      clock.record(index * 100, index * 100 + 80, index * 100 + 1100);
    }
    clock.record(800, 840, 1900);

    expect(clock.serverNow(500)).toBe(1580);
  });

  it('evicts an older best-RTT sample when it falls outside the eight-sample window', () => {
    const clock = new ClockSync();
    clock.record(0, 2, 1001);
    expect(clock.serverNow(500)).toBe(1500);

    for (let index = 0; index < 8; index += 1) {
      const sentAt = 100 + index * 100;
      clock.record(sentAt, sentAt + 100, sentAt + 50 + 2000);
    }

    expect(clock.serverNow(500)).toBe(2500);
  });

  it('uses the newest sample when RTTs tie and clears samples on reset', () => {
    const clock = new ClockSync();
    clock.record(100, 200, 1150);
    clock.record(400, 500, 1500);

    expect(clock.serverNow(500)).toBe(1550);
    clock.reset();
    expect(clock.serverNow(500)).toBeNull();
  });
});
