import { LEVEL, type LevelDefinition } from '../../shared/level.js';
import type { PlayerId, RoomId, WorldSnapshot } from '../../shared/model.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';

export type FinishStage = 'inactive' | 'syncing' | 'approach' | 'exchange' | 'happy' | 'result';
export interface FinishView {
  stage: FinishStage;
  players: ReadonlyMap<PlayerId, { x: number; y: number; facing: -1 | 1 }>;
  exchange: boolean;
  resultsVisible: boolean;
}

export class FinishPresenter {
  private roomId: RoomId | null = null;
  private epoch: number | null = null;
  private startedAt: number | null = null;
  private origins = new Map<PlayerId, { x: number; y: number }>();

  constructor(private readonly level: LevelDefinition = LEVEL) {}

  apply(snapshot: WorldSnapshot, serverNow: number | null): FinishView {
    if (snapshot.state.phase !== 'complete') {
      this.reset();
      return this.view('inactive', new Map());
    }
    if (this.roomId !== snapshot.roomId || this.epoch !== snapshot.epoch) {
      this.reset();
      this.roomId = snapshot.roomId;
      this.epoch = snapshot.epoch;
      this.startedAt = snapshot.state.finishStartedAt;
      this.origins = new Map(snapshot.state.players.map(({ id, body }) => [id, { x: body.x, y: body.y }]));
    }
    if (this.startedAt === null && snapshot.state.finishStartedAt !== null) this.startedAt = snapshot.state.finishStartedAt;
    if (serverNow === null || snapshot.state.finishStartedAt === null || this.startedAt === null) return this.view('syncing', new Map());
    const elapsed = Math.max(0, serverNow - this.startedAt);
    const stage: FinishStage = elapsed >= 3000 ? 'result' : elapsed >= 1800 ? 'happy' : elapsed >= 1000 ? 'exchange' : 'approach';
    const progress = Math.min(1, elapsed / 1000);
    const centerX = this.level.finish.x + this.level.finish.width / 2;
    const players = new Map<PlayerId, { x: number; y: number; facing: -1 | 1 }>();
    for (const player of snapshot.state.players) {
      const start = this.origins.get(player.id) ?? player.body;
      const facing: -1 | 1 = player.role === 'a' ? 1 : -1;
      const targetX = centerX - facing * 28 - PLAYER_WIDTH / 2;
      players.set(player.id, {
        x: start.x + (targetX - start.x) * progress,
        y: start.y + (this.level.groundY - PLAYER_HEIGHT - start.y) * progress,
        facing,
      });
    }
    return this.view(stage, players);
  }

  reset(): void { this.roomId = null; this.epoch = null; this.startedAt = null; this.origins.clear(); }
  destroy(): void { this.reset(); }

  private view(stage: FinishStage, players: ReadonlyMap<PlayerId, { x: number; y: number; facing: -1 | 1 }>): FinishView {
    return { stage, players, exchange: stage === 'exchange' || stage === 'happy' || stage === 'result', resultsVisible: stage === 'result' };
  }
}
