import { describe, expect, it } from 'vitest';
import { appUrls } from './app-urls.js';

describe('appUrls', () => {
  it.each([
    ['https://example.org', 'wss://example.org'],
    ['https://play.example.org', 'wss://play.example.org'],
    ['http://localhost:5173', 'ws://localhost:5173'],
  ])('builds same-origin URLs for %s', (origin, socketOrigin) => {
    const urls = appUrls(origin);

    expect(urls.base).toBe(`${origin}/date-run/`);
    expect(urls.ws).toBe(`${socketOrigin}/date-run/ws`);
    expect(urls.preview(' abcd2345 ')).toBe(`${origin}/date-run/api/rooms/ABCD2345`);
    expect(urls.invite('abcd2345')).toBe(`${origin}/date-run/?room=ABCD2345`);
  });

  it.each(['ftp://example.org', 'not a url', 'https://user:password@example.org'])('rejects invalid origin %s', (origin) => {
    expect(() => appUrls(origin)).toThrow();
  });

  it.each(['ABCDEFGI', 'ABCD234', 'ABCD23450', 'ABCD-345'])('rejects invalid room code %s', (code) => {
    const urls = appUrls('https://example.org');

    expect(() => urls.preview(code)).toThrow();
    expect(() => urls.invite(code)).toThrow();
  });
});
