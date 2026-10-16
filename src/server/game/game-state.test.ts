import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { LEVEL } from '../../shared/level.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../shared/simulation-config.js';
import type { PlayerId, PlayerInput, Role } from '../../shared/model.js';
import {
  configureRoom,
  createRoom,
  disconnectPlayer,
  interact,
  joinRoom,
  leaveRoom,
  projectGameplay,
  reconnectPlayer,
  returnToLobby,
  setReady,
  stepRoom,
  voteRematch,
} from './game-state.js';
import type { DomainPlayer, GameResult, GameState } from './game-types.js';

const roomId = 'ABCDEFGH';
const playerA: PlayerId = '00000000-0000-4000-8000-000000000001';
const playerB: PlayerId = '00000000-0000-4000-8000-000000000002';
const playerC: PlayerId = '00000000-0000-4000-8000-000000000003';
const neutral: PlayerInput = { axis: 0, jumpPressed: false };

function domainPlayer(id: PlayerId, role: Role = 'a'): DomainPlayer {
  const spawn = LEVEL.spawns[role];
  return {
    id,
    role,
    connected: true,
    ready: false,
    rematch: false,
    body: {
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      grounded: true,
      facing: role === 'a' ? 1 : -1,
    },
  };
}

function successful(result: GameResult): GameState {
  assert(result.ok);
  return result.state;
}

function roomWithTwo(): GameState {
  const created = createRoom(roomId, 'first-date', domainPlayer(playerA), LEVEL);
  return successful(joinRoom(created, domainPlayer(playerB)));
}

function startRoom(): GameState {
  const withAReady = successful(setReady(roomWithTwo(), playerA, true));
  return successful(setReady(withAReady, playerB, true));
}

function playerAt(state: GameState, id: PlayerId, x: number, y: number): GameState {
  return {
    ...state,
    players: state.players.map((player) => player.id === id
      ? { ...player, body: { ...player.body, x, y, vx: 0, vy: 0, grounded: true } }
      : player),
  };
}

function playingWithGiftsCollected(): GameState {
  const state = startRoom();
  return {
    ...state,
    gifts: state.gifts.map((gift) => ({ ...gift, collectedBy: gift.ownerRole === 'a' ? playerA : playerB })),
  };
}

function stateOnBothSwitches(state: GameState): GameState {
  const left = LEVEL.switches[0];
  const right = LEVEL.switches[1];
  assert(left);
  assert(right);
  return playerAt(playerAt(state, playerA, left.bounds.x, LEVEL.groundY - PLAYER_HEIGHT), playerB, right.bounds.x, LEVEL.groundY - PLAYER_HEIGHT);
}

function atGift(state: GameState, id: PlayerId, giftIndex: number): GameState {
  const gift = LEVEL.gifts[giftIndex];
  assert(gift);
  return playerAt(state, id, gift.position.x - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT);
}

describe('game room transitions', () => {
  it('assigns the other role, rejects a third player, and allows only the host to configure in lobby', () => {
    const created = createRoom(roomId, 'first-date', domainPlayer(playerA), LEVEL);
    const joined = successful(joinRoom(created, domainPlayer(playerB, 'a')));
    expect(joined.players.map(({ role }) => role)).toEqual(['a', 'b']);

    const full = joinRoom(joined, domainPlayer(playerC));
    assert(!full.ok);
    expect(full.code).toBe('room_full');

    const denied = configureRoom(joined, playerB, 'retro', 'b');
    assert(!denied.ok);
    expect(denied.code).toBe('not_host');

    const configured = successful(configureRoom(joined, playerA, 'winter', 'b'));
    expect(configured.themeId).toBe('winter');
    expect(configured.players.map(({ role, ready }) => ({ role, ready }))).toEqual([
      { role: 'b', ready: false },
      { role: 'a', ready: false },
    ]);
    expect(configured.epoch).toBe(joined.epoch + 1);
    expect(configured.tick).toBe(0);
    expect(configured.revision).toBe(0);

    const ready = successful(setReady(configured, playerA, true));
    const wrongPhase = configureRoom(ready, playerA, 'retro', 'a');
    assert(!wrongPhase.ok);
    expect(wrongPhase.code).toBe('invalid_phase');

    const playing = startRoom();
    const playingConfigure = configureRoom(playing, playerA, 'retro', 'a');
    assert(!playingConfigure.ok);
    expect(playingConfigure.code).toBe('invalid_phase');

    const unknownReady = setReady(joined, playerC, true);
    assert(!unknownReady.ok);
    expect(unknownReady.code).toBe('not_in_room');
  });

  it('starts only when both connected players are ready and clears ready flags', () => {
    const state = roomWithTwo();
    const oneReady = successful(setReady(state, playerA, true));
    expect(oneReady.phase).toBe('ready');
    expect(oneReady.players.find(({ id }) => id === playerA)?.ready).toBe(true);
    expect(oneReady.players.find(({ id }) => id === playerB)?.ready).toBe(false);

    const started = successful(setReady(oneReady, playerB, true));
    expect(started.phase).toBe('playing');
    expect(started.epoch).toBe(oneReady.epoch + 1);
    expect(started.tick).toBe(0);
    expect(started.revision).toBe(0);
    expect(started.players.every(({ ready }) => !ready)).toBe(true);
    expect(started.gifts.every(({ collectedBy }) => collectedBy === null)).toBe(true);
  });

  it('does not start when a ready room loses a player connection', () => {
    const oneReady = successful(setReady(roomWithTwo(), playerA, true));
    const disconnected = successful(disconnectPlayer(oneReady, playerB));
    expect(disconnected.phase).toBe('ready');
    expect(disconnected.players.find(({ id }) => id === playerA)?.ready).toBe(true);
    expect(disconnected.players.find(({ id }) => id === playerB)?.connected).toBe(false);

    const attemptedStart = setReady(disconnected, playerA, true);
    assert(attemptedStart.ok);
    expect(attemptedStart.state.phase).toBe('ready');
    expect(attemptedStart.state.epoch).toBe(disconnected.epoch);
  });

  it('only accepts an owner’s nearby gift and leaves duplicate collection unchanged', () => {
    const state = atGift(startRoom(), playerA, 0);
    const snapshot = structuredClone(state);
    const accepted = interact(state, playerA, 'gift-a');
    expect(accepted.outcome).toBe('accepted');
    expect(accepted.state.gifts[0]?.collectedBy).toBe(playerA);
    expect(state).toEqual(snapshot);

    const duplicate = interact(accepted.state, playerA, 'gift-a');
    expect(duplicate.outcome).toBe('already_collected');
    expect(duplicate.state).toEqual(accepted.state);
    expect(interact(state, playerA, 'gift-b').outcome).toBe('not_owner');

    const distant = interact(startRoom(), playerA, 'gift-a');
    expect(distant.outcome).toBe('out_of_range');
    expect(distant.state).toEqual(startRoom());
    expect(interact(state, playerA, 'unknown-object').outcome).toBe('unknown_object');
  });

  it('latches the gate from two distinct switch occupants and completes only with every objective', () => {
    const started = playingWithGiftsCollected();
    const switchState = stateOnBothSwitches(started);
    const latched = stepRoom(switchState, new Map(), 1000);
    expect(latched.gateOpen).toBe(true);
    expect(latched.switches.map(({ occupant }) => occupant)).toEqual([playerA, playerB]);

    const leftPlatform = LEVEL.switches[0];
    assert(leftPlatform);
    const steppedAway = stepRoom(playerAt(latched, playerA, leftPlatform.bounds.x + leftPlatform.bounds.width + 50, LEVEL.groundY - PLAYER_HEIGHT), new Map(), 1017);
    expect(steppedAway.gateOpen).toBe(true);

    const sameSide = playerAt(playerAt(started, playerA, 8792, LEVEL.groundY - PLAYER_HEIGHT), playerB, 8792, LEVEL.groundY - PLAYER_HEIGHT);
    const oneSideOnly = stepRoom(sameSide, new Map(), 1017);
    expect(oneSideOnly.gateOpen).toBe(false);
    expect(oneSideOnly.switches.filter(({ occupant }) => occupant !== null)).toHaveLength(1);

    const finishReady = playerAt(playerAt(started, playerA, 8880 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT), playerB, 9120 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT);
    const withoutSwitches = stepRoom(finishReady, new Map(), 2000);
    expect(withoutSwitches.phase).toBe('playing');

    const latchedForNegativeCases = stepRoom(stateOnBothSwitches(started), new Map(), 1500);
    expect(latchedForNegativeCases.gateOpen).toBe(true);
    const oneGiftMissing = {
      ...latchedForNegativeCases,
      gifts: started.gifts.map((gift) => gift.ownerRole === 'a' ? { ...gift, collectedBy: null } : gift),
    };
    const bothInFinish = (state: GameState) => playerAt(playerAt(state, playerA, 8900 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT), playerB, 9100 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT);
    const withoutGift = stepRoom(bothInFinish(oneGiftMissing), new Map(), 2000);
    expect(withoutGift.phase).toBe('playing');

    const onePlayerMissing = stepRoom(playerAt(playerAt(latchedForNegativeCases, playerA, 8900 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT), playerB, LEVEL.spawns.b.x, LEVEL.spawns.b.y), new Map(), 2000);
    expect(onePlayerMissing.phase).toBe('playing');

    const completeCandidate = stepRoom(stateOnBothSwitches(started), new Map(), 2200);
    expect(completeCandidate.gateOpen).toBe(true);
    const bothAtFinish = bothInFinish(completeCandidate);
    const complete = stepRoom(bothAtFinish, new Map(), 2345);
    expect(complete.phase).toBe('complete');
    expect(complete.finishStartedAt).toBe(2345);
    expect(stepRoom(complete, new Map(), 2400).finishStartedAt).toBe(2345);
  });

  it('pauses on disconnect, preserves the world on reconnect, and resets on leave with host transfer', () => {
    const started = playerAt(playingWithGiftsCollected(), playerA, 500, LEVEL.groundY - PLAYER_HEIGHT);
    const disconnected = successful(disconnectPlayer(started, playerB));
    expect(disconnected.paused).toBe(true);
    expect(disconnected.gifts).toEqual(started.gifts);
    const pauseStep = stepRoom(disconnected, new Map([[playerA, { axis: 1, jumpPressed: true }]]), 1100);
    expect(pauseStep.players.map(({ body }) => body)).toEqual(disconnected.players.map(({ body }) => body));
    const reconnected = successful(reconnectPlayer(disconnected, playerB));
    expect(reconnected.paused).toBe(false);
    expect(reconnected.gifts).toEqual(started.gifts);
    expect(reconnected.players.map(({ body }) => body)).toEqual(started.players.map(({ body }) => body));

    const left = successful(leaveRoom(reconnected, playerA));
    expect(left.phase).toBe('lobby');
    expect(left.epoch).toBe(reconnected.epoch + 1);
    expect(left.players.map(({ id }) => id)).toEqual([playerB]);
    expect(left.hostId).toBe(playerB);
    expect(left.gifts.every(({ collectedBy }) => collectedBy === null)).toBe(true);
    expect(left.gateOpen).toBe(false);
    expect(left.tick).toBe(0);
    expect(left.revision).toBe(0);
  });

  it('requires two rematch votes and lets either member return a completed round to lobby', () => {
    const state = playingWithGiftsCollected();
    const latched = stepRoom(stateOnBothSwitches(state), new Map(), 2500);
    const finish = playerAt(playerAt(latched, playerA, 8900 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT), playerB, 9100 - PLAYER_WIDTH / 2, LEVEL.groundY - PLAYER_HEIGHT);
    const complete = stepRoom(finish, new Map(), 3000);
    const oneVote = successful(voteRematch(complete, playerA));
    expect(oneVote.phase).toBe('complete');
    expect(oneVote.players.find(({ id }) => id === playerA)?.rematch).toBe(true);

    const rematch = successful(voteRematch(oneVote, playerB));
    expect(rematch.phase).toBe('lobby');
    expect(rematch.epoch).toBe(oneVote.epoch + 1);
    expect(rematch.tick).toBe(0);
    expect(rematch.revision).toBe(0);
    expect(rematch.gifts.every(({ collectedBy }) => collectedBy === null)).toBe(true);
    expect(rematch.gateOpen).toBe(false);

    const returned = successful(returnToLobby(complete, playerB));
    expect(returned.phase).toBe('lobby');
    expect(returned.players).toHaveLength(2);
    expect(returned.epoch).toBe(complete.epoch + 1);
    expect(returned.tick).toBe(0);
    expect(returned.revision).toBe(0);
  });

  it('projects gameplay without input counters or session metadata', () => {
    const projected = projectGameplay(startRoom());
    expect(projected.players).toHaveLength(2);
    expect(projected.players.every((player) => !('inputGeneration' in player))).toBe(true);
    expect(projected.players.every((player) => !('lastAcceptedSeq' in player))).toBe(true);
    expect(projected.players.every((player) => !('lastProcessedSeq' in player))).toBe(true);
    expect('sessionToken' in projected).toBe(false);
  });

  it('increments tick on every step while leaving the source state unchanged', () => {
    const state = startRoom();
    const snapshot = structuredClone(state);
    const stepped = stepRoom(state, new Map([[playerA, neutral]]), 100);
    expect(stepped.tick).toBe(state.tick + 1);
    expect(state).toEqual(snapshot);
  });
});
