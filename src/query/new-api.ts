import { bearer } from './http.ts';
import { numeric, object } from './parse.ts';
import { QuotaError } from './types.ts';
import type { AccountBalance, QuotaAdapter } from './types.ts';

export interface NewApiOptions {
  quotaPerUnit?: number;
  currency?: string;
}

export function validateNewApiOptions(options: NewApiOptions): Required<NewApiOptions> {
  const quotaPerUnit = options.quotaPerUnit ?? 500000;
  const currency = options.currency ?? 'USD';
  if (!Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0) throw new Error('quotaPerUnit must be a positive number');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter uppercase code');
  return { quotaPerUnit, currency };
}

export function newApiUsageUrl(baseUrl: string | undefined): string {
  if (!baseUrl) throw new QuotaError('unsupported-auth');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new QuotaError('unsupported-auth'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new QuotaError('unsupported-auth');
  // https://host/v1 -> https://host/api/user/self
  // https://host/gateway/v1 -> https://host/gateway/api/user/self
  // No cross-origin endpoint override, auto-discovery, or billing fallback.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/api/user/self';
  return url.toString();
}

export function parseNewApi(payload: unknown, options: NewApiOptions = {}): AccountBalance {
  const { quotaPerUnit, currency } = validateNewApiOptions(options);
  const response = object(payload);
  if (response.success === false) throw new QuotaError('http');
  if (response.success !== true) throw new QuotaError('schema');
  const data = object(response.data);
  const remaining = numeric(data.quota);
  const used = numeric(data.used_quota);
  // Missing fields must not become a made-up zero balance. Limit precision loss
  // when raw quota integers exceed JavaScript's exact numeric range.
  if (remaining === null || used === null || !Number.isSafeInteger(remaining)
    || !Number.isSafeInteger(used) || used < 0) throw new QuotaError('schema');
  const balance = { currency, remaining: remaining / quotaPerUnit, used: used / quotaPerUnit };
  if (!Number.isFinite(balance.remaining) || !Number.isFinite(balance.used)) throw new QuotaError('schema');
  return balance;
}

export function createNewApiAdapter(provider: string, options: NewApiOptions = {}): QuotaAdapter {
  const settings = validateNewApiOptions(options);
  return {
    provider, label: provider,
    async query(context) {
      let auth;
      try { auth = await context.getAuth(context.provider); }
      catch { throw new QuotaError('auth'); }
      context.signal.throwIfAborted();
      if (!auth) throw new QuotaError('auth');
      const url = newApiUsageUrl(auth.baseUrl);
      const token = bearer(auth);
      let payload: unknown;
      try {
        payload = await context.getJson(url, { Authorization: `Bearer ${token}` }, context.signal);
      } catch (error) {
        // /api/user/self often requires an account/session token even when model
        // requests accept an API key. Do not scrape a browser or try other routes.
        if (error instanceof QuotaError && error.code === 'auth') throw new QuotaError('account-access');
        throw error;
      }
      return { windows: [], balance: parseNewApi(payload, settings), fetchedAt: context.now() };
    },
  };
}
