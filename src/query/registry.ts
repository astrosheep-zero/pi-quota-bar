import { safeLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { AccountBalance, QuotaAdapter, QuotaSnapshot } from './types.ts';

export class AdapterRegistry {
  private readonly adapters = new Map<string, QuotaAdapter>();

  constructor(adapters: readonly QuotaAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: QuotaAdapter): void {
    if (!adapter.provider || !adapter.label || this.adapters.has(adapter.provider)) {
      throw new Error('Quota adapter must have a unique provider ID and a label');
    }
    this.adapters.set(adapter.provider, { ...adapter, label: safeLabel(adapter.label) });
  }

  get(provider: string | undefined): QuotaAdapter | undefined {
    return provider ? this.adapters.get(provider) : undefined;
  }
}

// Validate even custom adapter output before it reaches the bar.
export function validateSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  if (!snapshot || !Number.isFinite(snapshot.fetchedAt) || !Array.isArray(snapshot.windows)
    || (snapshot.windows.length === 0 && snapshot.balance === undefined)
    || snapshot.windows.length > 64) throw new QuotaError('schema');
  let balance: AccountBalance | undefined;
  if (snapshot.balance !== undefined) {
    const data = snapshot.balance;
    if (!data || typeof data.currency !== 'string' || !/^[A-Z]{3}$/.test(data.currency)
      || !Number.isFinite(data.remaining) || !Number.isFinite(data.used) || data.used < 0) {
      throw new QuotaError('schema');
    }
    balance = { currency: data.currency, remaining: data.remaining, used: data.used };
  }
  const ids = new Set<string>();
  const windows = snapshot.windows.map(window => {
    if (!window || typeof window.id !== 'string' || ids.has(window.id)
      || typeof window.label !== 'string'
      || (window.scope !== undefined && typeof window.scope !== 'string')
      || !Number.isFinite(window.durationSeconds) || window.durationSeconds <= 0
      || (window.remainingPercent !== null && (!Number.isFinite(window.remainingPercent)
        || window.remainingPercent < 0 || window.remainingPercent > 100))
      || (window.resetAt !== null && (!Number.isFinite(window.resetAt) || window.resetAt <= 0))) {
      throw new QuotaError('schema');
    }
    ids.add(window.id);
    return { ...window, label: safeLabel(window.label),
      ...(window.scope !== undefined ? { scope: safeLabel(window.scope) } : {}) };
  });
  return { fetchedAt: snapshot.fetchedAt, windows, ...(balance ? { balance } : {}) };
}
