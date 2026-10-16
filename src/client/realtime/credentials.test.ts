import { describe, expect, it, vi } from 'vitest';
import type { Credential } from '../../shared/model.js';
import { CredentialStore } from './credentials.js';

const credential: Credential = {
  schemaVersion: 1,
  roomId: 'ABCD2345',
  playerId: '00000000-0000-4000-8000-000000000001',
  sessionToken: '00000000-0000-4000-8000-000000000002',
  nextSeq: 1,
};

function storageWith(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set('date-run:v1:session', initial);

  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe('CredentialStore', () => {
  it('round-trips only a strict credential schema', () => {
    const storage = storageWith();
    const store = new CredentialStore(storage);

    expect(store.write(credential)).toEqual({ kind: 'stored' });
    expect(store.read()).toEqual(credential);
    expect(Object.keys(store.read() ?? {})).toEqual([
      'schemaVersion', 'roomId', 'playerId', 'sessionToken', 'nextSeq',
    ]);
  });

  it.each([
    ['invalid JSON', '{'],
    ['invalid schema', JSON.stringify({ ...credential, nextSeq: 0 })],
    ['unknown fields', JSON.stringify({ ...credential, expiresAt: 123 })],
  ])('clears %s without logging its content', (_label, raw) => {
    const storage = storageWith(raw);
    const store = new CredentialStore(storage);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(store.read()).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('date-run:v1:session');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it('switches to memory after storage denial, warns current and later subscribers, and keeps the latest value', () => {
    const storage = storageWith();
    storage.setItem.mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const store = new CredentialStore(storage);
    const warnings: string[] = [];

    expect(store.write(credential)).toEqual({ kind: 'memory', warning: 'storage_unavailable' });
    const unsubscribe = store.onWarning((warning) => warnings.push(warning));
    expect(warnings).toEqual(['storage_unavailable']);
    expect(store.read()).toEqual(credential);
    expect(store.clear()).toEqual({ kind: 'memory', warning: 'storage_unavailable' });
    expect(store.read()).toBeNull();
    unsubscribe();
  });

  it('treats quota errors the same as denied storage and publishes the warning once', () => {
    const storage = storageWith();
    storage.setItem.mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const store = new CredentialStore(storage);
    const warnings: string[] = [];
    store.onWarning((warning) => warnings.push(warning));

    expect(store.write(credential)).toEqual({ kind: 'memory', warning: 'storage_unavailable' });
    expect(store.write({ ...credential, nextSeq: 2 })).toEqual({ kind: 'memory', warning: 'storage_unavailable' });
    expect(store.read()?.nextSeq).toBe(2);
    expect(warnings).toEqual(['storage_unavailable']);
  });
});
