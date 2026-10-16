import type { LevelDefinition } from '../../shared/level.js';
import { collisionWorld, spawnBody, stepPlayer } from '../../shared/movement.js';
import type { ObjectId, PlayerId, PlayerInput, Rect, Role, RoomId, ThemeId } from '../../shared/model.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';
import type { DomainPlayer, GameResult, GameState, InteractionResult, RoomGameplayView } from './game-types.js';

const neutralInput: PlayerInput = { axis: 0, jumpPressed: false };

function resetPlayers(players: readonly DomainPlayer[], level: LevelDefinition): DomainPlayer[] {
  return players.map((player) => ({
    ...player,
    ready: false,
    rematch: false,
    body: spawnBody(player.role, level),
  }));
}

function resetRound(state: GameState): GameState {
  return {
    ...state,
    epoch: state.epoch + 1,
    tick: 0,
    revision: 0,
    paused: false,
    players: resetPlayers(state.players, state.level),
    gifts: state.level.gifts.map(({ id, ownerRole }) => ({ id, ownerRole, collectedBy: null })),
    switches: state.level.switches.map(({ id }) => ({ id, occupant: null })),
    gateOpen: false,
    finishStartedAt: null,
  };
}

function findPlayer(state: GameState, playerId: PlayerId): DomainPlayer | undefined {
  return state.players.find(({ id }) => id === playerId);
}

function updatePlayer(state: GameState, playerId: PlayerId, update: (player: DomainPlayer) => DomainPlayer): GameState {
  return {
    ...state,
    revision: state.revision + 1,
    players: state.players.map((player) => player.id === playerId ? update(player) : player),
  };
}

function otherRole(role: Role): Role {
  return role === 'a' ? 'b' : 'a';
}

export function createRoom(roomId: RoomId, themeId: ThemeId, host: DomainPlayer, level: LevelDefinition): GameState {
  return {
    roomId,
    themeId,
    hostId: host.id,
    phase: 'lobby',
    paused: false,
    players: [{ ...host, ready: false, rematch: false, body: spawnBody(host.role, level) }],
    gifts: level.gifts.map(({ id, ownerRole }) => ({ id, ownerRole, collectedBy: null })),
    switches: level.switches.map(({ id }) => ({ id, occupant: null })),
    gateOpen: false,
    finishStartedAt: null,
    epoch: 0,
    tick: 0,
    revision: 0,
    level,
  };
}

export function joinRoom(state: GameState, player: DomainPlayer): GameResult {
  if (state.phase !== 'lobby' && state.phase !== 'ready') return { ok: false, code: 'invalid_phase' };
  if (state.players.length >= 2) return { ok: false, code: 'room_full' };
  const role = state.players.some(({ role: occupied }) => occupied === 'a') ? 'b' : 'a';
  return {
    ok: true,
    state: {
      ...state,
      revision: state.revision + 1,
      players: [...state.players, { ...player, role, ready: false, rematch: false, body: spawnBody(role, state.level) }],
    },
  };
}

export function configureRoom(state: GameState, actorId: PlayerId, themeId: ThemeId, hostRole: Role): GameResult {
  if (!findPlayer(state, actorId)) return { ok: false, code: 'not_in_room' };
  if (state.phase !== 'lobby') return { ok: false, code: 'invalid_phase' };
  if (state.hostId !== actorId) return { ok: false, code: 'not_host' };
  const host = findPlayer(state, actorId);
  if (state.themeId === themeId && host?.role === hostRole) return { ok: true, state };
  const players = state.players.map((player) => ({ ...player, role: player.id === actorId ? hostRole : otherRole(hostRole) }));
  return { ok: true, state: resetRound({ ...state, themeId, players }) };
}

export function setReady(state: GameState, playerId: PlayerId, ready: boolean): GameResult {
  const player = findPlayer(state, playerId);
  if (!player) return { ok: false, code: 'not_in_room' };
  if ((state.phase !== 'lobby' && state.phase !== 'ready') || !player.connected) return { ok: false, code: 'invalid_phase' };
  if (player.ready === ready) return { ok: true, state };
  const updated = updatePlayer(state, playerId, (current) => ({ ...current, ready }));
  if (updated.players.length === 2 && updated.players.every(({ connected, ready: isReady }) => connected && isReady)) {
    return { ok: true, state: { ...resetRound(updated), phase: 'playing' } };
  }
  return { ok: true, state: { ...updated, phase: updated.players.some(({ ready: isReady }) => isReady) ? 'ready' : 'lobby' } };
}

export function voteRematch(state: GameState, playerId: PlayerId): GameResult {
  const player = findPlayer(state, playerId);
  if (!player) return { ok: false, code: 'not_in_room' };
  if (state.phase !== 'complete' || !player.connected) return { ok: false, code: 'invalid_phase' };
  if (player.rematch) return { ok: true, state };
  const updated = updatePlayer(state, playerId, (current) => ({ ...current, rematch: true }));
  if (updated.players.length === 2 && updated.players.every(({ connected, rematch }) => connected && rematch)) {
    return { ok: true, state: { ...resetRound(updated), phase: 'lobby' } };
  }
  return { ok: true, state: updated };
}

export function returnToLobby(state: GameState, playerId: PlayerId): GameResult {
  if (!findPlayer(state, playerId)) return { ok: false, code: 'not_in_room' };
  if (state.phase !== 'complete') return { ok: false, code: 'invalid_phase' };
  return { ok: true, state: { ...resetRound(state), phase: 'lobby' } };
}

export function leaveRoom(state: GameState, playerId: PlayerId): GameResult {
  if (!findPlayer(state, playerId)) return { ok: false, code: 'not_in_room' };
  const players = state.players.filter(({ id }) => id !== playerId);
  const hostId = state.hostId === playerId ? players[0]?.id ?? state.hostId : state.hostId;
  return { ok: true, state: { ...resetRound({ ...state, players, hostId }), phase: 'lobby' } };
}

export function disconnectPlayer(state: GameState, playerId: PlayerId): GameResult {
  const player = findPlayer(state, playerId);
  if (!player) return { ok: false, code: 'not_in_room' };
  if (!player.connected) return { ok: true, state };
  const updated = updatePlayer(state, playerId, (current) => ({ ...current, connected: false, ready: false }));
  return {
    ok: true,
    state: {
      ...updated,
      phase: state.phase === 'ready' && !updated.players.some(({ ready }) => ready) ? 'lobby' : state.phase,
      paused: state.phase === 'playing' ? true : state.paused,
    },
  };
}

export function reconnectPlayer(state: GameState, playerId: PlayerId): GameResult {
  const player = findPlayer(state, playerId);
  if (!player) return { ok: false, code: 'not_in_room' };
  if (player.connected) return { ok: true, state };
  const updated = updatePlayer(state, playerId, (current) => ({ ...current, connected: true }));
  return { ok: true, state: { ...updated, paused: state.phase === 'playing' && !updated.players.every(({ connected }) => connected) } };
}

function switchOccupant(players: readonly DomainPlayer[], bounds: Rect): PlayerId | null {
  const occupant = players.find(({ connected, body }) =>
    connected && body.grounded &&
    body.x < bounds.x + bounds.width && body.x + PLAYER_WIDTH > bounds.x &&
    body.y + PLAYER_HEIGHT > bounds.y && body.y + PLAYER_HEIGHT - 4 < bounds.y + bounds.height,
  );
  return occupant?.id ?? null;
}

function centerInside(body: DomainPlayer['body'], bounds: Rect): boolean {
  const centerX = body.x + PLAYER_WIDTH / 2;
  const centerY = body.y + PLAYER_HEIGHT / 2;
  return centerX >= bounds.x && centerX <= bounds.x + bounds.width &&
    centerY >= bounds.y && centerY <= bounds.y + bounds.height;
}

export function stepRoom(state: GameState, inputs: ReadonlyMap<PlayerId, PlayerInput>, now: number): GameState {
  const tick = state.tick + 1;
  const revision = state.revision + 1;
  if (state.phase !== 'playing' || state.paused) return { ...state, tick, revision };

  const world = collisionWorld(state.level, state.gateOpen);
  const players = state.players.map((player) => player.connected
    ? { ...player, body: stepPlayer(player.body, inputs.get(player.id) ?? neutralInput, world) }
    : player);
  const switches = state.level.switches.map(({ id, bounds }) => ({ id, occupant: switchOccupant(players, bounds) }));
  const occupants = switches.map(({ occupant }) => occupant);
  const gateOpen = state.gateOpen || (occupants.length === 2 && occupants[0] !== null && occupants[1] !== null && occupants[0] !== occupants[1]);
  const complete = gateOpen && state.gifts.every(({ collectedBy }) => collectedBy !== null) &&
    players.length === 2 && players.every(({ connected, body }) => connected && centerInside(body, state.level.finish));
  return {
    ...state,
    tick,
    revision,
    players,
    switches,
    gateOpen,
    phase: complete ? 'complete' : 'playing',
    finishStartedAt: complete ? now : state.finishStartedAt,
  };
}

export function interact(state: GameState, playerId: PlayerId, objectId: ObjectId): InteractionResult {
  const player = findPlayer(state, playerId);
  if (state.phase !== 'playing' || state.paused || !player?.connected) return { state, outcome: 'invalid_phase' };
  const gift = state.level.gifts.find(({ id }) => id === objectId);
  if (!gift) return { state, outcome: 'unknown_object' };
  if (gift.ownerRole !== player.role) return { state, outcome: 'not_owner' };
  if (state.gifts.some(({ id, collectedBy }) => id === objectId && collectedBy !== null)) return { state, outcome: 'already_collected' };
  const dx = player.body.x + PLAYER_WIDTH / 2 - gift.position.x;
  const dy = player.body.y + PLAYER_HEIGHT / 2 - gift.position.y;
  if (Math.hypot(dx, dy) > 48) return { state, outcome: 'out_of_range' };
  return {
    state: {
      ...state,
      revision: state.revision + 1,
      gifts: state.gifts.map((current) => current.id === objectId ? { ...current, collectedBy: playerId } : current),
    },
    outcome: 'accepted',
  };
}

export function projectGameplay(state: GameState): RoomGameplayView {
  return {
    themeId: state.themeId,
    hostId: state.hostId,
    phase: state.phase,
    paused: state.paused,
    players: state.players.map(({ id, role, connected, ready, rematch, body }) => ({
      id, role, connected, ready, rematch, body: { ...body },
    })),
    gifts: state.gifts.map((gift) => ({ ...gift })),
    switches: state.switches.map((item) => ({ ...item })),
    gateOpen: state.gateOpen,
    finishStartedAt: state.finishStartedAt,
  };
}
