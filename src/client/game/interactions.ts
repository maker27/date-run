import { LEVEL, type LevelDefinition } from '../../shared/level.js';
import type { ObjectId, PlayerId, WorldSnapshot } from '../../shared/model.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';

export function findOwnInteractable(snapshot: WorldSnapshot, localId: PlayerId, level: LevelDefinition = LEVEL): ObjectId | null {
  if (snapshot.state.phase !== 'playing' || snapshot.state.paused) return null;
  const player = snapshot.state.players.find(({ id }) => id === localId);
  if (!player?.connected) return null;
  const ownGift = snapshot.state.gifts.find(({ ownerRole, collectedBy }) => ownerRole === player.role && collectedBy === null);
  if (!ownGift) return null;
  const definition = level.gifts.find(({ id, ownerRole }) => id === ownGift.id && ownerRole === player.role);
  if (!definition) return null;
  const dx = player.body.x + PLAYER_WIDTH / 2 - definition.position.x;
  const dy = player.body.y + PLAYER_HEIGHT / 2 - definition.position.y;
  return Math.hypot(dx, dy) <= 48 ? ownGift.id : null;
}
