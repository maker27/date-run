import type { PublicPlayer, RoomId, RoomState } from '../../shared/model.js';
import type { LevelDefinition } from '../../shared/level.js';
import type { ServerMessage } from '../../shared/protocol.js';

export type DomainPlayer = Omit<PublicPlayer, 'inputGeneration' | 'lastAcceptedSeq' | 'lastProcessedSeq'>;

export type RoomGameplayView = Omit<RoomState, 'players'> & { players: DomainPlayer[] };

export interface GameState extends RoomGameplayView {
  roomId: RoomId;
  epoch: number;
  tick: number;
  revision: number;
  level: LevelDefinition;
}

export type DomainError = 'room_full' | 'not_host' | 'invalid_phase' | 'not_in_room';
export type GameResult = { ok: true; state: GameState } | { ok: false; code: DomainError };
export type InteractionOutcome = Extract<ServerMessage, { type: 'world:interact:result' }>['outcome'];
export interface InteractionResult {
  state: GameState;
  outcome: InteractionOutcome;
}
