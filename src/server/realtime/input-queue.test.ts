import { describe, expect, it } from 'vitest';
import type { Session } from './session-store.js';
import { InputQueue } from './input-queue.js';

function fixture() {
  const session: Pick<Session, 'inputGeneration' | 'lastAcceptedSeq' | 'lastProcessedSeq' | 'suspended'> = {
    inputGeneration: 1,
    lastAcceptedSeq: 0,
    lastProcessedSeq: 0,
    suspended: false,
  };
  let epoch = 4;
  const queue = new InputQueue(session, () => epoch);
  return { session, queue, setEpoch: (value: number) => { epoch = value; } };
}

function command(seq: number, overrides: { epoch?: number; generation?: number; axis?: -1 | 0 | 1; jumpPressed?: boolean } = {}) {
  return {
    version: 1 as const,
    type: 'input:update' as const,
    epoch: overrides.epoch ?? 4,
    inputGeneration: overrides.generation ?? 1,
    seq,
    input: { axis: overrides.axis ?? 1, jumpPressed: overrides.jumpPressed ?? false },
  };
}

describe('InputQueue', () => {
  it('keeps FIFO order, ignores duplicate sequences, and processes only one command per consume', () => {
    const { session, queue } = fixture();
    expect(queue.enqueue(command(1))).toEqual({ kind: 'accepted' });
    expect(queue.enqueue(command(2, { axis: -1 }))).toEqual({ kind: 'accepted' });
    expect(queue.enqueue(command(2))).toEqual({ kind: 'ignored' });
    expect(session.lastAcceptedSeq).toBe(2);

    expect(queue.consume()).toEqual({ seq: 1, input: { axis: 1, jumpPressed: false } });
    expect(session.lastProcessedSeq).toBe(1);
    expect(queue.consume()).toEqual({ seq: 2, input: { axis: -1, jumpPressed: false } });
    expect(queue.consume()).toBeNull();
  });

  it('rejects stale epoch, stale generation, and suspended input without changing ACKs', () => {
    const { session, queue, setEpoch } = fixture();
    expect(queue.enqueue(command(1, { epoch: 3 }))).toEqual({ kind: 'rejected', code: 'stale_epoch' });
    expect(queue.enqueue(command(1, { generation: 2 }))).toEqual({ kind: 'rejected', code: 'stale_input_generation' });
    session.suspended = true;
    expect(queue.enqueue(command(1))).toEqual({ kind: 'rejected', code: 'invalid_phase' });
    session.suspended = false;
    setEpoch(5);
    expect(queue.enqueue(command(1))).toEqual({ kind: 'rejected', code: 'stale_epoch' });
    expect(session.lastAcceptedSeq).toBe(0);
    expect(session.lastProcessedSeq).toBe(0);
    expect(queue.length).toBe(0);
  });

  it('accepts at most 120 queued steps and never ACKs an overflowed sequence', () => {
    const { session, queue } = fixture();
    for (let seq = 1; seq <= 120; seq += 1) {
      expect(queue.enqueue(command(seq))).toEqual({ kind: 'accepted' });
    }
    expect(queue.length).toBe(120);
    expect(queue.enqueue(command(121))).toEqual({ kind: 'rejected', code: 'queue_full' });
    expect(session.lastAcceptedSeq).toBe(120);
    expect(session.lastProcessedSeq).toBe(0);

    for (let seq = 1; seq <= 120; seq += 1) {
      expect(queue.consume()).toMatchObject({ seq });
    }
    expect(queue.consume()).toBeNull();
    expect(session.lastProcessedSeq).toBe(120);
  });

  it('drops commands from a cancelled generation without advancing processed ACK', () => {
    const { session, queue } = fixture();
    queue.enqueue(command(1));
    queue.enqueue(command(2, { jumpPressed: true }));
    session.inputGeneration += 1;

    expect(queue.consume()).toBeNull();
    expect(queue.length).toBe(0);
    expect(session.lastAcceptedSeq).toBe(2);
    expect(session.lastProcessedSeq).toBe(0);
    expect(queue.enqueue(command(3, { generation: 1 }))).toEqual({ kind: 'rejected', code: 'stale_input_generation' });
    expect(queue.enqueue(command(3, { generation: 2 }))).toEqual({ kind: 'accepted' });
  });

  it('returns a jump edge once and neutral input after the FIFO drains', () => {
    const { queue } = fixture();
    expect(queue.enqueue(command(1, { axis: 0, jumpPressed: true }))).toEqual({ kind: 'accepted' });
    expect(queue.consume()).toEqual({ seq: 1, input: { axis: 0, jumpPressed: true } });
    expect(queue.consume()).toBeNull();
    expect(queue.consume()).toBeNull();
  });
});
