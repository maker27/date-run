import { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { parseServerConfig, resolveClientIp } from './config.js';

describe('server configuration', () => {
  it('uses safe development defaults and normalizes configured origins', () => {
    expect(parseServerConfig({})).toMatchObject({
      port: 3000,
      host: '127.0.0.1',
      allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
      proxyMode: 'none',
      trustedProxyPeers: [],
      revision: 'dev',
    });
    expect(parseServerConfig({ ALLOWED_ORIGINS: 'HTTPS://Example.test/, http://localhost:5173' }).allowedOrigins)
      .toEqual(['https://example.test', 'http://localhost:5173']);
  });

  it('requires a full revision and origins in production', () => {
    expect(() => parseServerConfig({ NODE_ENV: 'production' })).toThrow(/ALLOWED_ORIGINS/);
    expect(() => parseServerConfig({
      NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.test', APP_REVISION: 'dev',
    })).toThrow(/APP_REVISION/);
    expect(parseServerConfig({
      NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.test', APP_REVISION: 'a'.repeat(40),
    }).revision).toBe('a'.repeat(40));
  });

  it('rejects permissive, malformed, and non-origin configuration values', () => {
    for (const origins of [
      '*', 'null', 'https://user@example.test', 'https://example.test/path', 'https://example.test?x=1',
      'https://example.test/a/..', 'https://example.test/%2e%2e/',
    ]) {
      expect(() => parseServerConfig({ ALLOWED_ORIGINS: origins })).toThrow(/ALLOWED_ORIGINS/);
    }
    for (const port of ['0', '3000tail', ' 3000', '65536', '1.5']) {
      expect(() => parseServerConfig({ PORT: port })).toThrow(/PORT/);
    }
    expect(() => parseServerConfig({ PROXY_MODE: 'nginx' })).toThrow(/TRUSTED_PROXY_PEERS/);
    expect(() => parseServerConfig({ PROXY_MODE: 'nginx', TRUSTED_PROXY_PEERS: '127.0.0.1,not-an-ip' }))
      .toThrow(/TRUSTED_PROXY_PEERS/);
  });

  it('trusts forwarded client IP only from configured proxy peers and ignores X-Forwarded-For', () => {
    const direct = parseServerConfig({});
    const directRequest = incomingRequest('127.0.0.1', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.8' });
    expect(resolveClientIp(directRequest, direct)).toBe('127.0.0.1');

    const proxyConfig = parseServerConfig({
      PROXY_MODE: 'nginx', TRUSTED_PROXY_PEERS: '127.0.0.0/8,2001:db8::1',
    });
    expect(resolveClientIp(incomingRequest('127.0.0.1', { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }), proxyConfig))
      .toBe('203.0.113.9');
    expect(resolveClientIp(incomingRequest('192.0.2.3', { 'x-real-ip': '203.0.113.9' }), proxyConfig)).toBe('192.0.2.3');
    expect(resolveClientIp(incomingRequest('127.0.0.1', { 'x-real-ip': 'bad address' }), proxyConfig)).toBeNull();
    expect(resolveClientIp(incomingRequest('127.0.0.1', { 'x-real-ip': ['203.0.113.9', '203.0.113.10'] }), proxyConfig)).toBeNull();
  });

  it('matches IPv4-mapped IPv6 peers against an explicit IPv4 proxy rule', () => {
    const config = parseServerConfig({ PROXY_MODE: 'nginx', TRUSTED_PROXY_PEERS: '192.0.2.0/24' });
    expect(resolveClientIp(incomingRequest('::ffff:192.0.2.12', { 'x-real-ip': '198.51.100.4' }), config)).toBe('198.51.100.4');
  });
});

function incomingRequest(peerAddress: string, headers: Record<string, string | string[]>): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: peerAddress });
  const request = new IncomingMessage(socket);
  request.headers = headers;
  return request;
}
