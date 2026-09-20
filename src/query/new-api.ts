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

// Billing endpoints live at the deployment root, never under /v1.
// https://host/v1 -> https://host, https://host/gateway/v1 -> https://host/gateway
export function newApiRootUrl(baseUrl: string | undefined): string {
  if (!baseUrl) throw new QuotaError('unsupported-auth');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new QuotaError('unsupported-auth'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new QuotaError('unsupported-auth');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v\d+(?:beta\d*)?$/i, '');
  return url.origin + path;
}

// GET /api/usage/token (new-api >= v0.9.0-alpha.8, PR QuantumNous/new-api#1161):
// accepts the sk- model key itself (TokenAuth), returns per-token quota in
// the same unit as /api/user/self quota. Response shell: {code:true,data:{...}}.
export function parseNewApiTokenUsage(payload: unknown, options: NewApiOptions = {}): AccountBalance | null {
  const { quotaPerUnit, currency } = validateNewApiOptions(options);
  const response = object(payload);
  if (response.code !== true) return null;
  const data = object(response.data);
  if (data.object !== 'token_usage') return null;
  const used = numeric(data.total_used);
  // Missing fields must not become a made-up zero balance.
  if (used === null || !Number.isSafeInteger(used) || used < 0) throw new QuotaError('schema');
  if (data.unlimited_quota === true) {
    return { currency, remaining: 0, used: used / quotaPerUnit, unlimited: true };
  }
  const remaining = numeric(data.total_available);
  if (remaining === null || !Number.isSafeInteger(remaining)) throw new QuotaError('schema');
  const balance = { currency, remaining: remaining / quotaPerUnit, used: used / quotaPerUnit };
  if (!Number.isFinite(balance.remaining) || !Number.isFinite(balance.used)) throw new QuotaError('schema');
  return balance;
}

// Legacy one-api billing pair, still the only option on older deployments.
// total_usage is in cents (divide by 100, per one-api issue #1785); most
// deployments report a fake 1e8 hard limit for unlimited quotas.
export function parseNewApiBilling(subscription: unknown, usage: unknown, options: NewApiOptions = {}): AccountBalance {
  const { currency } = validateNewApiOptions(options);
  const sub = object(subscription);
  const limit = numeric(sub.hard_limit_usd);
  const list = object(usage);
  const totalUsage = numeric(list.total_usage);
  if (limit === null || !Number.isFinite(limit) || limit < 0
    || totalUsage === null || !Number.isFinite(totalUsage) || totalUsage < 0) throw new QuotaError('schema');
  const used = totalUsage / 100;
  if (limit >= 1e7) return { currency, remaining: 0, used, unlimited: true };
  return { currency, remaining: limit - used, used };
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
      const root = newApiRootUrl(auth.baseUrl);
      const headers = { Authorization: `Bearer ${bearer(auth)}` };
      // 1. Account billing (one-api legacy): a finite hard limit is the real
      // account balance. 1e8 means unlimited — then the key quota may still
      // be finite and more precise.
      let billingBalance: AccountBalance | null = null;
      try {
        const pair = await Promise.all([
          context.getJson(`${root}/v1/dashboard/billing/subscription`, headers, context.signal),
          context.getJson(`${root}/v1/dashboard/billing/usage?start_date=2020-01-01&end_date=2100-01-01`, headers, context.signal),
        ]);
        const billing = parseNewApiBilling(pair[0], pair[1], settings);
        if (billing.unlimited !== true) return { windows: [], balance: billing, fetchedAt: context.now() };
        billingBalance = billing;
      } catch (error) {
        // 404: deployment has no billing pair. 401: try the key-native endpoint
        // below — some deployments accept sk- only there.
        if (error instanceof QuotaError && (error.code === 'http' || error.code === 'auth')) { /* fall through */ }
        else throw error;
      }
      // 2. Per-token usage (new-api ≥ v0.9.0-alpha.8): native sk- support.
      try {
        const payload = await context.getJson(`${root}/api/usage/token/`, headers, context.signal);
        const parsed = parseNewApiTokenUsage(payload, settings);
        if (parsed) return { windows: [], balance: parsed, fetchedAt: context.now() };
      } catch (error) {
        if (billingBalance && error instanceof QuotaError && error.code === 'http') {
          return { windows: [], balance: billingBalance, fetchedAt: context.now() };
        }
        if (error instanceof QuotaError && error.code === 'auth') throw new QuotaError('account-access');
        throw error;
      }
      if (billingBalance) return { windows: [], balance: billingBalance, fetchedAt: context.now() };
      throw new QuotaError('schema');
    },
  };
}
