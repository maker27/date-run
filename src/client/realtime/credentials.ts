import { CredentialSchema, type Credential } from '../../shared/model.js';
import type { Unsubscribe } from '../../shared/protocol.js';

const STORAGE_KEY = 'date-run:v1:session';
export type StorageOutcome = { kind: 'stored' } | { kind: 'memory'; warning: 'storage_unavailable' };

export class CredentialStore {
  private memory: Credential | null = null;
  private unavailable = false;
  private readonly listeners = new Set<(warning: 'storage_unavailable') => void>();

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  read(): Credential | null {
    if (this.unavailable) return this.memory;
    let raw: string | null;
    try {
      raw = this.storage.getItem(STORAGE_KEY);
    } catch {
      this.failStorage();
      return this.memory;
    }
    if (raw === null) return this.memory;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.clear();
      return null;
    }
    const result = CredentialSchema.safeParse(parsed);
    if (!result.success) {
      this.clear();
      return null;
    }
    this.memory = result.data;
    return result.data;
  }

  write(value: Credential): StorageOutcome {
    const result = CredentialSchema.safeParse(value);
    if (!result.success) throw new Error('Invalid credential');
    const credential = result.data;
    this.memory = credential;
    if (this.unavailable) return this.memoryOutcome();
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(credential));
      return { kind: 'stored' };
    } catch {
      this.failStorage();
      return this.memoryOutcome();
    }
  }

  clear(): StorageOutcome {
    this.memory = null;
    if (this.unavailable) return this.memoryOutcome();
    try {
      this.storage.removeItem(STORAGE_KEY);
      return { kind: 'stored' };
    } catch {
      this.failStorage();
      return this.memoryOutcome();
    }
  }

  onWarning(listener: (warning: 'storage_unavailable') => void): Unsubscribe {
    this.listeners.add(listener);
    if (this.unavailable) listener('storage_unavailable');
    return () => this.listeners.delete(listener);
  }

  private failStorage(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    for (const listener of this.listeners) listener('storage_unavailable');
  }

  private memoryOutcome(): StorageOutcome {
    return { kind: 'memory', warning: 'storage_unavailable' };
  }
}
