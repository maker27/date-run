import type { PlayerBody, PlayerId, RoomId, WorldSnapshot } from '../../shared/model.js';

export interface SnapshotIdentity {
  roomId: RoomId;
  epoch: number;
}

export interface RenderWorld extends SnapshotIdentity {
  players: ReadonlyMap<PlayerId, PlayerBody>;
}

interface VisualSample {
  tick: number;
  revision: number;
  serverTime: number;
  players: ReadonlyMap<PlayerId, PlayerBody>;
}

function clonePlayers(players: ReadonlyMap<PlayerId, PlayerBody>): Map<PlayerId, PlayerBody> {
  return new Map([...players].map(([id, body]) => [id, { ...body }]));
}

function interpolatePlayers(earlier: VisualSample, later: VisualSample, fraction: number): Map<PlayerId, PlayerBody> {
  const players = new Map<PlayerId, PlayerBody>();
  for (const [id, before] of earlier.players) {
    const after = later.players.get(id);
    if (!after) continue;
    players.set(id, {
      x: before.x + (after.x - before.x) * fraction,
      y: before.y + (after.y - before.y) * fraction,
      vx: before.vx + (after.vx - before.vx) * fraction,
      vy: before.vy + (after.vy - before.vy) * fraction,
      grounded: before.grounded,
      facing: before.facing,
    });
  }
  return players;
}

export class SnapshotBuffer {
  private identity: SnapshotIdentity | undefined;
  private readonly samples: VisualSample[] = [];

  constructor(identity?: SnapshotIdentity) {
    this.identity = identity;
  }

  get length(): number {
    return this.samples.length;
  }

  reset(identity: SnapshotIdentity): void {
    this.identity = identity;
    this.samples.length = 0;
  }

  push(snapshot: WorldSnapshot): boolean {
    if (this.identity && (snapshot.roomId !== this.identity.roomId || snapshot.epoch !== this.identity.epoch)) return false;
    const latest = this.samples.at(-1);
    if (latest && (snapshot.tick < latest.tick || snapshot.revision < latest.revision
      || snapshot.serverTime < latest.serverTime
      || (snapshot.tick === latest.tick && snapshot.revision === latest.revision))) return false;

    this.identity ??= { roomId: snapshot.roomId, epoch: snapshot.epoch };
    const players = new Map(snapshot.state.players.map(({ id, body }) => [id, { ...body }]));
    const sample = { tick: snapshot.tick, revision: snapshot.revision, serverTime: snapshot.serverTime, players };
    if (latest && (snapshot.tick === latest.tick || snapshot.serverTime === latest.serverTime)) {
      this.samples[this.samples.length - 1] = sample;
    }
    else this.samples.push(sample);

    while (this.samples.length > 32) this.samples.shift();
    while (this.samples[0]?.serverTime !== undefined
      && this.samples[0].serverTime < snapshot.serverTime - 1000) {
      this.samples.shift();
    }
    return true;
  }

  sample(serverRenderTime: number): RenderWorld | null {
    if (!this.identity) return null;
    const [first, ...rest] = this.samples;
    if (!first) return null;
    if (serverRenderTime <= first.serverTime) return { ...this.identity, players: clonePlayers(first.players) };
    let earlier = first;
    for (const later of rest) {
      if (serverRenderTime > later.serverTime) {
        earlier = later;
        continue;
      }
      if (serverRenderTime === later.serverTime) return { ...this.identity, players: clonePlayers(later.players) };
      const fraction = (serverRenderTime - earlier.serverTime) / (later.serverTime - earlier.serverTime);
      return { ...this.identity, players: interpolatePlayers(earlier, later, fraction) };
    }
    return { ...this.identity, players: clonePlayers(earlier.players) };
  }
}
