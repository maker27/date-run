import { RoomIdSchema } from './model.js';

export function normalizeRoomCode(value: string): string | null {
  const normalized = value.trim().replace(/[a-z]/g, (letter) => letter.toUpperCase());
  return RoomIdSchema.safeParse(normalized).success ? normalized : null;
}
