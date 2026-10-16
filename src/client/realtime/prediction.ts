import { LEVEL, type LevelDefinition } from '../../shared/level.js';
import type { PlayerBody, PlayerId, PlayerInput, RoomId, WorldSnapshot } from '../../shared/model.js';
import { collisionWorld, stepPlayer } from '../../shared/movement.js';

interface PendingInput {
  seq: number;
  input: PlayerInput;
}

interface PredictionIdentity {
  roomId: RoomId;
  epoch: number;
}

export class Prediction {
  private currentBody: PlayerBody | undefined;
  private generation: number | undefined;
  private identity: PredictionIdentity | undefined;
  private gateOpen = false;
  private readonly pending: PendingInput[] = [];
  private resyncRequested = false;

  constructor(
    private readonly level: LevelDefinition = LEVEL,
    private readonly onResync: () => void = () => {},
  ) {}

  get body(): PlayerBody {
    if (!this.currentBody) throw new Error('Prediction is not initialized');
    return { ...this.currentBody };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  reset(body: PlayerBody, generation: number): void {
    this.currentBody = { ...body };
    this.generation = generation;
    this.pending.length = 0;
    this.resyncRequested = false;
  }

  predict(seq: number, input: PlayerInput): PlayerBody {
    if (!this.currentBody) throw new Error('Prediction is not initialized');
    if (this.pending.length === 120) {
      if (!this.resyncRequested) {
        this.resyncRequested = true;
        this.onResync();
      }
      return { ...this.currentBody };
    }
    const copiedInput = { ...input };
    this.pending.push({ seq, input: copiedInput });
    this.currentBody = stepPlayer(this.currentBody, copiedInput, collisionWorld(this.level, this.gateOpen));
    return { ...this.currentBody };
  }

  reconcile(snapshot: WorldSnapshot, localId: PlayerId): PlayerBody {
    const localPlayer = snapshot.state.players.find(({ id }) => id === localId);
    if (!localPlayer) throw new Error('Local player is missing from snapshot');

    const changedIdentity = this.identity !== undefined
      && (this.identity.roomId !== snapshot.roomId || this.identity.epoch !== snapshot.epoch);
    const changedGeneration = this.generation !== undefined && this.generation !== localPlayer.inputGeneration;
    if (changedIdentity || changedGeneration) {
      this.pending.length = 0;
      this.resyncRequested = false;
    }
    this.identity = { roomId: snapshot.roomId, epoch: snapshot.epoch };
    this.generation = localPlayer.inputGeneration;
    this.gateOpen = snapshot.state.gateOpen;
    this.currentBody = { ...localPlayer.body };
    while (this.pending[0]?.seq !== undefined && this.pending[0].seq <= localPlayer.lastProcessedSeq) {
      this.pending.shift();
    }
    const world = collisionWorld(this.level, this.gateOpen);
    for (const { input } of this.pending) this.currentBody = stepPlayer(this.currentBody, input, world);
    return { ...this.currentBody };
  }
}
