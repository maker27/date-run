import { LEVEL } from '../../src/shared/level.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../src/shared/simulation-config.js';
import type { PlayerInput } from '../../src/shared/model.js';
import { LoadClient } from './client.js';

export type ScenarioMode = 'steady' | 'completion';

export class PlayerRoute {
  private direction = 1;
  private lastJumpAt = -Infinity;
  constructor(private readonly client: LoadClient, private readonly mode: ScenarioMode) {}

  next(now: number): PlayerInput {
    const snapshot = this.client.snapshot;
    const player = snapshot?.state.players.find((candidate) => candidate.id === this.client.playerId);
    if (!player || snapshot?.state.phase !== 'playing') return { axis: 0, jumpPressed: false };
    const distance = this.client.role === 'a' ? player.body.x : LEVEL.bounds.width - player.body.x - PLAYER_WIDTH;
    const speed = this.client.role === 'a' ? player.body.vx : -player.body.vx;
    const gift = snapshot.state.gifts.find((candidate) => candidate.ownerRole === this.client.role);
    if (gift && gift.collectedBy === null && Math.abs(distance - 4484) < 24 && Math.abs(player.body.y + PLAYER_HEIGHT / 2 - 816) < 35) {
      this.client.tryCollectGift(gift.id);
    }

    let target: number;
    if (this.mode === 'completion' && gift && gift.collectedBy !== null) {
      target = snapshot.state.gateOpen ? 8970 : 8792;
    } else if (distance < 4200) target = 4500;
    else {
      if (distance >= 4800) this.direction = -1;
      if (distance <= 4200) this.direction = 1;
      target = this.direction > 0 ? 4800 : 4200;
    }

    const difference = target - distance;
    const axis: -1 | 0 | 1 = Math.abs(difference) < 8 && Math.abs(speed) < 25 ? 0 : difference > 0 ? 1 : -1;
    const nextHurdle = LEVEL.solids
      .filter((solid) => solid.x < LEVEL.bounds.width / 2)
      .map((solid) => solid.x)
      .find((x) => x > distance + PLAYER_WIDTH && x - distance < 135);
    const jumpPressed = axis === 1 && nextHurdle !== undefined && nextHurdle - distance > 45
      && player.body.grounded && now - this.lastJumpAt > 450;
    if (jumpPressed) this.lastJumpAt = now;
    const roleAxis: -1 | 0 | 1 = this.client.role === 'a' ? axis : axis === 0 ? 0 : axis === 1 ? -1 : 1;
    return { axis: roleAxis, jumpPressed };
  }
}
