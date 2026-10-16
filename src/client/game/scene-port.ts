import type { ThemeId } from '../../shared/model.js';
import type { PlayerBody, PlayerId, WorldSnapshot } from '../../shared/model.js';
import type { FinishView } from './finish-sequence.js';

export interface SceneHooks {
  onFrame(clientNow: number): void;
  onError(error: Error): void;
  onContextLost(): void;
  onContextRestored(): void;
}

export interface ScenePort {
  mount(container: HTMLElement): Promise<void>;
  setTheme(themeId: ThemeId): Promise<void>;
  applyWorld(snapshot: WorldSnapshot): void;
  applyFinish(view: FinishView): void;
  setLocalPlayer(id: PlayerId): void;
  setLocalBody(body: PlayerBody): void;
  setRemoteBodies(bodies: ReadonlyMap<PlayerId, PlayerBody>): void;
  setPaused(paused: boolean): void;
  destroy(): void;
}

export type SceneFactory = (hooks: SceneHooks) => ScenePort;
