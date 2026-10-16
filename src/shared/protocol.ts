import { z } from 'zod';
import {
  CredentialSchema,
  ObjectIdSchema,
  PlayerInputSchema,
  RequestIdSchema,
  RejoinStateSchema,
  RoleSchema,
  RoomIdSchema,
  SequenceSchema,
  ThemeIdSchema,
  TimestampSchema,
  WorldSnapshotSchema,
} from './model.js';

const Envelope = { version: z.literal(1) };
const Request = { ...Envelope, requestId: RequestIdSchema };
const CommandName = z.enum([
  'room:configure', 'room:leave', 'player:ready', 'room:rematch', 'room:reset',
]);
const ErrorCode = z.enum([
  'room_full', 'room_not_found', 'session_expired', 'invalid_message',
  'unsupported_version', 'not_in_room', 'not_host', 'invalid_phase', 'stale_epoch',
  'stale_input_generation', 'queue_full', 'server_full', 'rate_limited',
]);

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Request, type: z.literal('room:create'), themeId: ThemeIdSchema, role: RoleSchema }).strict(),
  z.object({ ...Request, type: z.literal('room:join'), roomId: RoomIdSchema }).strict(),
  z.object({ ...Request, type: z.literal('room:rejoin'), sessionToken: z.uuid() }).strict(),
  z.object({ ...Request, type: z.literal('room:configure'), themeId: ThemeIdSchema, hostRole: RoleSchema }).strict(),
  z.object({ ...Request, type: z.literal('room:leave') }).strict(),
  z.object({ ...Request, type: z.literal('player:ready'), ready: z.boolean() }).strict(),
  z.object({ ...Request, type: z.literal('room:rematch') }).strict(),
  z.object({ ...Request, type: z.literal('room:reset') }).strict(),
  z.object({ ...Envelope, type: z.literal('input:update'), epoch: SequenceSchema, inputGeneration: SequenceSchema, seq: SequenceSchema.min(1), input: PlayerInputSchema }).strict(),
  z.object({ ...Request, type: z.literal('player:suspend'), epoch: SequenceSchema }).strict(),
  z.object({ ...Request, type: z.literal('world:interact'), epoch: SequenceSchema, objectId: ObjectIdSchema }).strict(),
  z.object({ ...Request, type: z.literal('room:resync') }).strict(),
  z.object({ ...Request, type: z.literal('time:ping'), clientTime: TimestampSchema }).strict(),
]);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Request, type: z.literal('room:joined'), credential: CredentialSchema, rejoinState: RejoinStateSchema, snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Request, type: z.literal('command:result'), command: CommandName, outcome: z.literal('ok') }).strict(),
  z.object({ ...Envelope, type: z.literal('room:state'), snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Envelope, type: z.literal('round:start'), snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Envelope, type: z.literal('world:update'), snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Envelope, type: z.literal('room:complete'), snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Request, type: z.literal('room:resynced'), rejoinState: RejoinStateSchema, snapshot: WorldSnapshotSchema }).strict(),
  z.object({ ...Request, type: z.literal('world:interact:result'), epoch: SequenceSchema, objectId: ObjectIdSchema, outcome: z.enum(['accepted', 'already_collected', 'not_owner', 'out_of_range', 'invalid_phase', 'unknown_object']) }).strict(),
  z.object({ ...Request, type: z.literal('time:pong'), clientTime: TimestampSchema, serverTime: TimestampSchema }).strict(),
  z.object({ ...Envelope, type: z.literal('room:closing'), reason: z.enum(['idle', 'restart']), remainingMs: TimestampSchema }).strict(),
  z.object({ ...Envelope, type: z.literal('session:replaced') }).strict(),
  z.object({ ...Envelope, type: z.literal('error'), requestId: RequestIdSchema.optional(), code: ErrorCode }).strict(),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ClientRequest = Exclude<ClientMessage, { type: 'input:update' }>;
export type InputUpdate = Extract<ClientMessage, { type: 'input:update' }>;
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>;
type CorrelatedError = Omit<ErrorMessage, 'requestId'> & { requestId: string };
type UncorrelatedError = Omit<ErrorMessage, 'requestId'> & { requestId?: undefined };
type CorrelatedReply = Extract<ServerMessage, {
  type: 'room:joined' | 'command:result' | 'room:resynced' | 'world:interact:result' | 'time:pong'
}>;
export type ServerReply = CorrelatedReply | CorrelatedError;
export type ServerEvent = Exclude<ServerMessage, CorrelatedReply | ErrorMessage> | UncorrelatedError;
export type Unsubscribe = () => void;
