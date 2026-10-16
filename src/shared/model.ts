import { z } from 'zod';

export const ThemeIdSchema = z.enum(['first-date', 'retro', 'winter']);
export const RoleSchema = z.enum(['a', 'b']);
export const PhaseSchema = z.enum(['lobby', 'ready', 'playing', 'complete']);
export const RoomIdSchema = z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
export const PlayerIdSchema = z.uuid();
export const ObjectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const RequestIdSchema = z.uuid();
export const SequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const TimestampSchema = z.number().finite().min(0);
export const Vec2Schema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const RectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();

export const PlayerInputSchema = z.object({
  axis: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  jumpPressed: z.boolean(),
}).strict();

export const PlayerBodySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  vx: z.number().finite(),
  vy: z.number().finite(),
  grounded: z.boolean(),
  facing: z.union([z.literal(-1), z.literal(1)]),
}).strict();

export const PublicPlayerSchema = z.object({
  id: PlayerIdSchema,
  role: RoleSchema,
  connected: z.boolean(),
  ready: z.boolean(),
  rematch: z.boolean(),
  body: PlayerBodySchema,
  inputGeneration: SequenceSchema,
  lastAcceptedSeq: SequenceSchema,
  lastProcessedSeq: SequenceSchema,
}).strict();

export const GiftStateSchema = z.object({
  id: ObjectIdSchema,
  ownerRole: RoleSchema,
  collectedBy: PlayerIdSchema.nullable(),
}).strict();

export const SwitchStateSchema = z.object({
  id: ObjectIdSchema,
  occupant: PlayerIdSchema.nullable(),
}).strict();

export const RoomStateSchema = z.object({
  themeId: ThemeIdSchema,
  hostId: PlayerIdSchema,
  phase: PhaseSchema,
  paused: z.boolean(),
  players: z.array(PublicPlayerSchema).max(2),
  gifts: z.array(GiftStateSchema).length(2),
  switches: z.array(SwitchStateSchema).length(2),
  gateOpen: z.boolean(),
  finishStartedAt: TimestampSchema.nullable(),
}).strict();

export const WorldSnapshotSchema = z.object({
  roomId: RoomIdSchema,
  epoch: SequenceSchema,
  tick: SequenceSchema,
  revision: SequenceSchema,
  serverTime: TimestampSchema,
  state: RoomStateSchema,
}).strict();

export const RoomPreviewSchema = z.object({
  roomId: RoomIdSchema,
  themeId: ThemeIdSchema,
  availableRole: RoleSchema.nullable(),
  phase: PhaseSchema,
  occupiedPlaces: z.number().int().min(0).max(2),
}).strict();

export const CredentialSchema = z.object({
  schemaVersion: z.literal(1),
  roomId: RoomIdSchema,
  playerId: PlayerIdSchema,
  sessionToken: z.uuid(),
  nextSeq: SequenceSchema.min(1),
}).strict();

export const RejoinStateSchema = z.object({
  inputGeneration: SequenceSchema,
  nextSeq: SequenceSchema.min(1),
}).strict();

export type ThemeId = z.infer<typeof ThemeIdSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type RoomId = z.infer<typeof RoomIdSchema>;
export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type ObjectId = z.infer<typeof ObjectIdSchema>;
export type Vec2 = z.infer<typeof Vec2Schema>;
export type Rect = z.infer<typeof RectSchema>;
export type PlayerInput = z.infer<typeof PlayerInputSchema>;
export type PlayerBody = z.infer<typeof PlayerBodySchema>;
export type PublicPlayer = z.infer<typeof PublicPlayerSchema>;
export type GiftState = z.infer<typeof GiftStateSchema>;
export type SwitchState = z.infer<typeof SwitchStateSchema>;
export type RoomState = z.infer<typeof RoomStateSchema>;
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
export type RoomPreview = z.infer<typeof RoomPreviewSchema>;
export type Credential = z.infer<typeof CredentialSchema>;
export type RejoinState = z.infer<typeof RejoinStateSchema>;
