// Query-layer contracts: no Pi, terminal, or rendering dependencies.
export interface QuotaWindow {
  id: string;
  label: string;
  remainingPercent: number | null; // null is unknown, never silently 0 or 100
  resetAt: number | null; // epoch milliseconds
  durationSeconds: number;
  scope?: string; // e.g. a model-specific Codex quota domain
}

export interface AccountBalance {
  currency: string; // ISO-style currency code, e.g. USD
  remaining: number; // may be negative (debt); not a periodic allowance
  used: number;
  unlimited?: boolean; // provider granted no finite cap; ignore remaining
}

export interface QuotaSnapshot {
  windows: readonly QuotaWindow[];
  balance?: AccountBalance;
  fetchedAt: number;
}

export interface ProviderAuth {
  apiKey?: string;
  headers?: Record<string, string | undefined>;
  baseUrl?: string;
}

export interface QueryContext {
  provider: string;
  signal: AbortSignal;
  now(): number;
  getAuth(provider: string): Promise<ProviderAuth | undefined>;
  getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}

export interface QuotaAdapter {
  provider: string; // exact Pi provider ID; aliases must be explicitly registered
  label: string;
  query(context: QueryContext): Promise<QuotaSnapshot>;
}

export type QuotaErrorCode = 'auth' | 'unsupported-auth' | 'account-access' | 'network' | 'timeout' | 'rate-limit' | 'http' | 'schema';

export class QuotaError extends Error {
  readonly code: QuotaErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: QuotaErrorCode, retryAfterMs?: number) {
    super(code); // Never include response bodies, request headers, or raw exceptions.
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export type QuotaState =
  | { kind: 'hidden' }
  | { kind: 'loading'; provider: string; label: string }
  | { kind: 'ready'; provider: string; label: string; snapshot: QuotaSnapshot }
  | { kind: 'error'; provider: string; label: string; code: QuotaErrorCode };
