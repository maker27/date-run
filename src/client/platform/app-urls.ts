import { normalizeRoomCode } from '../../shared/room-code.js';

function roomCode(value: string): string {
  const code = normalizeRoomCode(value);
  if (code === null) throw new Error('Invalid room code');
  return code;
}

export function appUrls(origin: string): {
  base: string;
  ws: string;
  preview: (code: string) => string;
  invite: (code: string) => string;
} {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('Invalid origin');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== origin) {
    throw new Error('Invalid origin');
  }
  const base = `${parsed.origin}/date-run/`;
  const socketProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    base,
    ws: `${socketProtocol}//${parsed.host}/date-run/ws`,
    preview: (code) => `${base}api/rooms/${roomCode(code)}`,
    invite: (code) => `${base}?room=${roomCode(code)}`,
  };
}
