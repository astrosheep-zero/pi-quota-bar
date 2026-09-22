import { bearer } from './http.ts';
import { numeric, object, percent, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { AccountBalance, QuotaAdapter, QuotaAllowance, QuotaSnapshot, QuotaWindow, ProviderAuth } from './types.ts';

function usageUrl(baseUrl: string | undefined): string {
  if (!baseUrl) throw new QuotaError('unsupported-auth');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new QuotaError('unsupported-auth'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new QuotaError('unsupported-auth');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/usage`;
  return url.toString();
}

function currency(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw new QuotaError('schema');
  return value;
}

function amount(value: unknown): number {
  const result = numeric(value);
  if (result === null || result < 0) throw new QuotaError('schema');
  return result;
}

function allowance(data: Record<string, unknown>, unit: string): QuotaAllowance {
  const limit = amount(data.limit);
  const used = amount(data.used);
  const remaining = amount(data.remaining);
  return { currency: unit, limit, used, remaining };
}

function spend(data: Record<string, unknown>, unit: string) {
  const today = object(data.today);
  const total = object(data.total);
  const todayCost = numeric(today.actual_cost);
  const lifetimeCost = numeric(total.actual_cost);
  if (todayCost === null && lifetimeCost === null) return undefined;
  if ((todayCost !== null && todayCost < 0) || (lifetimeCost !== null && lifetimeCost < 0)) throw new QuotaError('schema');
  return { currency: unit, ...(todayCost !== null ? { today: todayCost } : {}),
    ...(lifetimeCost !== null ? { lifetime: lifetimeCost } : {}) };
}

function percentFromAmounts(remaining: number, limit: number): number {
  return percent(remaining / limit * 100);
}

function rateWindow(data: Record<string, unknown>, index: number, unit: string): QuotaWindow {
  const label = typeof data.window === 'string' && data.window !== '' ? data.window : `window-${index + 1}`;
  const limits = allowance(data, unit);
  const durationSeconds = label === '5h' ? 18000 : label === '1d' ? 86400 : label === '7d' ? 604800 : 86400;
  return { id: `rate-${index}`, label, durationSeconds, remainingPercent: percentFromAmounts(limits.remaining, limits.limit),
    resetAt: timestamp(data.reset_at), amounts: limits };
}

function subscriptionWindows(data: Record<string, unknown>, unit: string): QuotaWindow[] {
  const specs = [
    ['daily', '1d', 'daily_usage_usd', 'daily_limit_usd', 86400],
    ['weekly', '1w', 'weekly_usage_usd', 'weekly_limit_usd', 604800],
    ['monthly', '30d', 'monthly_usage_usd', 'monthly_limit_usd', 2592000],
  ] as const;
  return specs.flatMap(([id, label, usedKey, limitKey, durationSeconds]) => {
    const used = numeric(data[usedKey]);
    const limit = numeric(data[limitKey]);
    if (used === null && limit === null) return [];
    if (used === null || limit === null || used < 0 || limit <= 0) throw new QuotaError('schema');
    const amounts: QuotaAllowance = { currency: unit, limit, used, remaining: Math.max(0, limit - used) };
    const start = id === 'weekly' ? timestamp(data.weekly_window_start) : null;
    return [{ id, label, durationSeconds, remainingPercent: percentFromAmounts(amounts.remaining, limit),
      resetAt: start === null ? null : start + durationSeconds * 1000, amounts }];
  });
}

export function parseSub2ApiUsage(payload: unknown): QuotaSnapshot {
  const body = object(payload);
  if (body.isValid !== true || (body.mode !== 'quota_limited' && body.mode !== 'unrestricted')) {
    throw new QuotaError('schema');
  }
  const unit = currency(body.unit);
  const windows: QuotaWindow[] = [];
  let balance: AccountBalance | undefined;
  let finiteQuota: QuotaAllowance | undefined;
  if (body.mode === 'quota_limited') {
    const quota = body.quota === undefined ? undefined : allowance(object(body.quota), unit);
    finiteQuota = quota;
    const rates = body.rate_limits;
    if (rates !== undefined) {
      if (!Array.isArray(rates)) throw new QuotaError('schema');
      rates.forEach((entry, index) => windows.push(rateWindow(object(entry), index, unit)));
    }
  } else if (body.subscription !== undefined) {
    windows.push(...subscriptionWindows(object(body.subscription), unit));
  } else {
    const remaining = amount(body.remaining ?? body.balance);
    balance = { currency: unit, remaining };
  }
  const usage = spend(object(body.usage), unit);
  if (windows.length === 0 && !balance && !finiteQuota && !usage) throw new QuotaError('schema');
  return { windows, ...(balance ? { balance } : {}), ...(finiteQuota ? { allowance: finiteQuota } : {}),
    ...(usage ? { spend: usage } : {}), fetchedAt: 0 };
}

export function createSub2ApiAdapter(provider: string): QuotaAdapter {
  return {
    provider, label: provider,
    async query(context) {
      let auth: ProviderAuth | undefined;
      try { auth = await context.getAuth(context.provider); } catch { throw new QuotaError('auth'); }
      context.signal.throwIfAborted();
      if (!auth) throw new QuotaError('auth');
      const payload = await context.getJson(usageUrl(auth.baseUrl),
        { Authorization: `Bearer ${bearer(auth)}` }, context.signal);
      return { ...parseSub2ApiUsage(payload), fetchedAt: context.now() };
    },
  };
}

export { usageUrl as sub2ApiUsageUrl };
