import type { PlayerId, PlayerBody, WorldSnapshot } from '../../src/shared/model.js';

export const localPlayerId: PlayerId = '00000000-0000-4000-8000-000000000001';
export const peerPlayerId: PlayerId = '00000000-0000-4000-8000-000000000002';

export function makeSnapshot(options: {
  roomId?: WorldSnapshot['roomId'];
  epoch?: number;
  tick?: number;
  revision?: number;
  serverTime?: number;
  localBody?: PlayerBody;
  localGeneration?: number;
  lastAcceptedSeq?: number;
  lastProcessedSeq?: number;
  gateOpen?: boolean;
} = {}): WorldSnapshot {
  const {
    roomId = 'ABCD2345',
    epoch = 1,
    tick = 1,
    revision = 0,
    serverTime = tick * 50,
    localBody = { x: 100, y: 792, vx: 0, vy: 0, grounded: true, facing: 1 },
    localGeneration = 1,
    lastAcceptedSeq = 0,
    lastProcessedSeq = 0,
    gateOpen = false,
  } = options;

  return {
    roomId,
    epoch,
    tick,
    revision,
    serverTime,
    state: {
      themeId: 'first-date',
      hostId: localPlayerId,
      phase: 'playing',
      paused: false,
      players: [
        {
          id: localPlayerId,
          role: 'a',
          connected: true,
          ready: false,
          rematch: false,
          body: localBody,
          inputGeneration: localGeneration,
          lastAcceptedSeq,
          lastProcessedSeq,
        },
        {
          id: peerPlayerId,
          role: 'b',
          connected: true,
          ready: false,
          rematch: false,
          body: { x: 17904, y: 792, vx: 0, vy: 0, grounded: true, facing: -1 },
          inputGeneration: 1,
          lastAcceptedSeq: 0,
          lastProcessedSeq: 0,
        },
      ],
      gifts: [
        { id: 'gift-a', ownerRole: 'a', collectedBy: null },
        { id: 'gift-b', ownerRole: 'b', collectedBy: null },
      ],
      switches: [
        { id: 'switch-left', occupant: null },
        { id: 'switch-right', occupant: null },
      ],
      gateOpen,
      finishStartedAt: null,
    },
  };
}
