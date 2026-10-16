import type { PlayerInput } from '../../shared/model.js';
import type { InputUpdate } from '../../shared/protocol.js';
import type { Session } from './session-store.js';

export interface InputCommand { seq: number; input: PlayerInput }
export type QueueOutcome = { kind: 'accepted' } | { kind: 'ignored' } | { kind: 'rejected'; code: 'stale_epoch' | 'stale_input_generation' | 'queue_full' | 'invalid_phase' };

export class InputQueue {
  private commands: InputCommand[] = [];
  private generation: number;
  constructor(private readonly session: Pick<Session, 'inputGeneration' | 'lastAcceptedSeq' | 'lastProcessedSeq' | 'suspended'>, private readonly getEpoch: () => number) {
    this.generation = session.inputGeneration;
  }
  get length(): number { this.syncGeneration(); return this.commands.length; }
  enqueue(command: InputUpdate): QueueOutcome {
    this.syncGeneration();
    if (command.epoch !== this.getEpoch()) return { kind: 'rejected', code: 'stale_epoch' };
    if (command.inputGeneration !== this.session.inputGeneration) return { kind: 'rejected', code: 'stale_input_generation' };
    if (this.session.suspended) return { kind: 'rejected', code: 'invalid_phase' };
    if (command.seq <= this.session.lastAcceptedSeq) return { kind: 'ignored' };
    if (this.commands.length >= 120) return { kind: 'rejected', code: 'queue_full' };
    this.commands.push({ seq: command.seq, input: command.input });
    this.session.lastAcceptedSeq = command.seq;
    return { kind: 'accepted' };
  }
  consume(): InputCommand | null {
    this.syncGeneration();
    const command = this.commands.shift() ?? null;
    if (command) this.session.lastProcessedSeq = command.seq;
    return command;
  }
  reset(): void { this.commands = []; this.generation = this.session.inputGeneration; }
  private syncGeneration(): void { if (this.generation !== this.session.inputGeneration) this.reset(); }
}
