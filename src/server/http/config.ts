import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  host: string;
  clientRoot: string;
  allowedOrigins: readonly string[];
  proxyMode: 'none' | 'nginx';
  trustedProxyPeers: readonly string[];
  revision: string;
}

const defaultOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173'];

function proxyRules(peers: readonly string[]): BlockList {
  const rules = new BlockList();
  for (const peer of peers) {
    const slash = peer.indexOf('/');
    const address = slash < 0 ? peer : peer.slice(0, slash);
    const family = isIP(address);
    if (!family || (slash >= 0 && (!/^\d+$/.test(peer.slice(slash + 1)) || Number(peer.slice(slash + 1)) > (family === 4 ? 32 : 128)))) {
      throw new Error('Invalid TRUSTED_PROXY_PEERS');
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (slash < 0) rules.addAddress(address, type);
    else rules.addSubnet(address, Number(peer.slice(slash + 1)), type);
  }
  return rules;
}

export function parseServerConfig(env: Readonly<Record<string, string | undefined>>): ServerConfig {
  const portValue = env.PORT;
  if (portValue !== undefined && (!/^[1-9]\d*$/.test(portValue) || Number(portValue) > 65535)) throw new Error('Invalid PORT');
  const port = portValue === undefined ? 3000 : Number(portValue);
  const host = env.BIND_HOST ?? '127.0.0.1';
  if (!host || isIP(host) === 0 && host !== 'localhost') throw new Error('Invalid BIND_HOST');
  const production = env.NODE_ENV === 'production';
  const originsValue = env.ALLOWED_ORIGINS;
  if (production && !originsValue) throw new Error('Missing ALLOWED_ORIGINS');
  const allowedOrigins = originsValue === undefined ? defaultOrigins : originsValue.split(',').map((value) => {
    const trimmed = value.trim();
    if (!/^https?:\/\/[^/?#]+\/?$/i.test(trimmed)) throw new Error('Invalid ALLOWED_ORIGINS');
    let url: URL;
    try { url = new URL(trimmed); } catch { throw new Error('Invalid ALLOWED_ORIGINS'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[?#@\\*]/.test(trimmed)) {
      throw new Error('Invalid ALLOWED_ORIGINS');
    }
    return url.origin;
  });
  if (allowedOrigins.length === 0 || allowedOrigins.some((origin) => origin === 'null')) throw new Error('Invalid ALLOWED_ORIGINS');
  const proxyMode = env.PROXY_MODE ?? 'none';
  if (proxyMode !== 'none' && proxyMode !== 'nginx') throw new Error('Invalid PROXY_MODE');
  const trustedProxyPeers = env.TRUSTED_PROXY_PEERS === undefined ? [] : env.TRUSTED_PROXY_PEERS.split(',').map((peer) => peer.trim());
  if (proxyMode === 'nginx' && trustedProxyPeers.length === 0) throw new Error('Missing TRUSTED_PROXY_PEERS');
  proxyRules(trustedProxyPeers);
  const revision = env.APP_REVISION ?? 'dev';
  if (production ? !/^[a-fA-F0-9]{40}$/.test(revision) : revision !== 'dev' && !/^[a-fA-F0-9]{40}$/.test(revision)) {
    throw new Error('Invalid APP_REVISION');
  }
  return { port, host, clientRoot: env.CLIENT_ROOT ?? fileURLToPath(new URL('../../client/', import.meta.url)), allowedOrigins, proxyMode, trustedProxyPeers, revision };
}

export function resolveClientIp(request: IncomingMessage, config: ServerConfig): string | null {
  const peer = request.socket.remoteAddress;
  if (!peer || !isIP(peer)) return null;
  if (config.proxyMode === 'none') return peer;
  const rules = proxyRules(config.trustedProxyPeers);
  if (!rules.check(peer, isIP(peer) === 4 ? 'ipv4' : 'ipv6')) return peer;
  const forwarded = request.headers['x-real-ip'];
  if (typeof forwarded !== 'string' || !isIP(forwarded) || forwarded.includes(',')) return null;
  const raw = request.rawHeaders.filter((value) => value.toLowerCase() === 'x-real-ip');
  if (raw.length > 1) return null;
  return forwarded;
}
