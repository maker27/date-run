import type { Phase, PlayerId, Role, RoomId, ThemeId, WorldSnapshot } from '../../shared/model.js';
import type { SocketStatus } from '../realtime/socket-client.js';

export type UiErrorCode = 'busy' | 'room_full' | 'room_not_found' | 'session_expired' | 'session_replaced' | 'invalid_message' | 'unsupported_version' | 'not_in_room' | 'not_host' | 'invalid_phase' | 'stale_epoch' | 'stale_input_generation' | 'queue_full' | 'server_full' | 'rate_limited' | 'network_error' | 'timeout' | 'aborted' | 'invalid_response' | 'graphics_error' | 'interaction_failed' | 'unexpected_error';
export interface UiContext {
  connection: SocketStatus;
  loading: boolean;
  error: UiErrorCode | null;
  storageWarning: boolean;
  closing: 'idle' | 'restart' | null;
  sceneReady: boolean;
  resultsVisible: boolean;
}
export interface UiSummary extends UiContext {
  screen: 'landing' | 'lobby' | 'game' | 'result';
  roomId: RoomId | null;
  phase: Phase | null;
  selectedTheme: ThemeId;
  ownRole: Role | null;
  isHost: boolean;
  players: readonly { role: Role; connected: boolean; ready: boolean; rematch: boolean }[];
  ownGift: boolean;
  partnerGift: boolean;
  gateOpen: boolean;
  occupiedPlates: number;
  paused: boolean;
}

export function projectUi(snapshot: WorldSnapshot | null, localId: PlayerId | null, context: UiContext): UiSummary {
  const state = snapshot?.state;
  const ownRole = state?.players.find(({ id }) => id === localId)?.role ?? null;
  return {
    ...context,
    screen: state?.phase === 'complete' && context.resultsVisible ? 'result' : state?.phase === 'complete' || state?.phase === 'playing' ? 'game' : state ? 'lobby' : 'landing',
    roomId: snapshot?.roomId ?? null,
    phase: state?.phase ?? null,
    selectedTheme: state?.themeId ?? 'first-date',
    ownRole,
    isHost: localId !== null && state?.hostId === localId,
    players: state?.players.map(({ role, connected, ready, rematch }) => ({ role, connected, ready, rematch })) ?? [],
    ownGift: state?.gifts.some(({ ownerRole, collectedBy }) => ownerRole === ownRole && collectedBy !== null) ?? false,
    partnerGift: state?.gifts.some(({ ownerRole, collectedBy }) => ownerRole !== ownRole && collectedBy !== null) ?? false,
    gateOpen: state?.gateOpen ?? false,
    occupiedPlates: state?.switches.filter(({ occupant }) => occupant !== null).length ?? 0,
    paused: state?.paused ?? false,
  };
}

export function sameUiSummary(a: UiSummary, b: UiSummary): boolean {
  return a.screen === b.screen && a.roomId === b.roomId && a.phase === b.phase
    && a.connection === b.connection && a.selectedTheme === b.selectedTheme
    && a.ownRole === b.ownRole && a.isHost === b.isHost && a.ownGift === b.ownGift
    && a.partnerGift === b.partnerGift && a.gateOpen === b.gateOpen && a.occupiedPlates === b.occupiedPlates && a.paused === b.paused
    && a.loading === b.loading && a.error === b.error && a.storageWarning === b.storageWarning
    && a.closing === b.closing && a.players.length === b.players.length
    && a.sceneReady === b.sceneReady && a.resultsVisible === b.resultsVisible
    && a.players.every((player, index) => {
      const other = b.players[index];
      return other !== undefined && player.role === other.role && player.connected === other.connected
        && player.ready === other.ready && player.rematch === other.rematch;
    });
}
