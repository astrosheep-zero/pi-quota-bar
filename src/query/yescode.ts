import { officialAuth } from './http.ts';
import { numeric, object, percent, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { PostJsonResult, QuotaAdapter, QuotaSnapshot, QuotaWindow } from './types.ts';

export const YESCODE_ORIGIN = 'https://co.yes.vg';

// co.yes.vg rejects API keys on account endpoints ("requires a user session or
// JWT"). Login is the only way in; the issued cookie/JWT lives ~24h, so cache
// it in memory and re-login on auth failure. The model cr_ key is never sent
// to account endpoints — officialAuth only pins the origin and proves the
// provider exists in Pi auth.
export interface YesCodeOptions {
  username: string; // Login takes the account username (email also works).
  password: string;
}

interface YesCodeSession {
  headers: Record<string, string>;
  expiresAt: number;
}

const SESSION_TTL_MS = 23 * 3600 * 1000; // observed cookie Max-Age is 24h

export function validateYesCodeOptions(options: YesCodeOptions): YesCodeOptions {
  const { username, password } = options;
  if (typeof username !== 'string' || username.trim() === '') {
    throw new Error('username must be a non-empty string');
  }
  if (typeof password !== 'string' || password === '') throw new Error('password must be a non-empty string');
  return { username, password };
}

function cookieValue(setCookie: readonly string[], name: string): string | undefined {
  for (const entry of setCookie) {
    if (!entry.startsWith(`${name}=`)) continue;
    const value = entry.slice(name.length + 1).split(';', 1)[0]!;
    if (value !== '' && !/[\s;]/.test(value)) return value;
  }
  return undefined;
}

// POST /api/v1/auth/login returns {token} and sets yescode_auth/yescode_csrf.
// The cookie pair is what the web app itself uses; the bare JWT is the
// documented UserToken fallback (Authorization: Bearer).
export function parseYesCodeLogin(result: PostJsonResult, now: number): YesCodeSession {
  const auth = cookieValue(result.setCookie, 'yescode_auth');
  if (auth) {
    const csrf = cookieValue(result.setCookie, 'yescode_csrf');
    return { headers: { Cookie: csrf ? `yescode_auth=${auth}; yescode_csrf=${csrf}` : `yescode_auth=${auth}` },
      expiresAt: now + SESSION_TTL_MS };
  }
  const token = object(result.body).token;
  if (typeof token !== 'string' || token.trim() === '' || /[\s;]/.test(token)) throw new QuotaError('schema');
  return { headers: { Authorization: `Bearer ${token}` }, expiresAt: now + SESSION_TTL_MS };
}

// Balances may legitimately be negative (debt); limits/spends may not.
function optionalAmount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const result = numeric(value);
  if (result === null) throw new QuotaError('schema');
  return result;
}

function nonNegative(value: unknown): number | undefined {
  const result = optionalAmount(value);
  if (result !== undefined && result < 0) throw new QuotaError('schema');
  return result;
}

function limitWindow(id: string, label: string, durationSeconds: number,
  limitRaw: unknown, usedRaw: unknown, resetAt: number | null): QuotaWindow[] {
  const used = nonNegative(usedRaw); // validate present-but-corrupt spends even without a cap
  const limit = nonNegative(limitRaw);
  if (limit === undefined || limit === 0) return []; // no configured cap: nothing to draw
  if (used === undefined) {
    return [{ id, label, durationSeconds, remainingPercent: null, resetAt }];
  }
  const remaining = Math.max(0, limit - used);
  return [{ id, label, durationSeconds, remainingPercent: percent(remaining / limit * 100), resetAt,
    amounts: { currency: 'USD', limit, used, remaining } }];
}

// GET /api/v1/user/balance (optional; some accounts may lack it) merged with
// GET /api/v1/auth/profile (required). The live response carries a generic
// spending_limits array (scope/spent/limit/remaining/resets_at/window_seconds)
// plus top-level weekly_* and monthly_* fields; profile is the last fallback.
function spendingLimitWindows(balanceData: Record<string, unknown>): QuotaWindow[] | null {
  if (balanceData.spending_limits === undefined) return null;
  if (!Array.isArray(balanceData.spending_limits)) throw new QuotaError('schema');
  const windows = balanceData.spending_limits.flatMap((entry): QuotaWindow[] => {
    const item = object(entry);
    const limit = nonNegative(item.limit);
    const spent = nonNegative(item.spent);
    const remaining = nonNegative(item.remaining);
    const windowSeconds = numeric(item.window_seconds);
    const resetAt = timestamp(item.resets_at);
    if (typeof item.key !== 'string' || item.key === ''
      || windowSeconds === null || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) {
      throw new QuotaError('schema');
    }
    if (limit === undefined || limit === 0) return []; // uncapped: nothing to draw
    if (spent === undefined) {
      return [{ id: `spending:${item.key}`, label: windowLabel(windowSeconds), durationSeconds: windowSeconds,
        remainingPercent: null, resetAt }];
    }
    const left = remaining ?? Math.max(0, limit - spent);
    return [{ id: `spending:${item.key}`, label: windowLabel(windowSeconds), durationSeconds: windowSeconds,
      remainingPercent: percent(left / limit * 100), resetAt,
      amounts: { currency: 'USD', limit, used: spent, remaining: left } }];
  });
  // Footer/detail convention is ascending duration (5h → 1w → 30d).
  return windows.sort((a, b) => a.durationSeconds - b.durationSeconds);
}

export function parseYesCodeAccount(balancePayload: unknown, profilePayload: unknown): Omit<QuotaSnapshot, 'fetchedAt'> {
  const balanceData = object(balancePayload);
  const profile = object(profilePayload);
  const plan = object(profile.subscription_plan);
  const subscription = optionalAmount(balanceData.subscription_balance ?? profile.subscription_balance);
  const paygo = optionalAmount(balanceData.pay_as_you_go_balance ?? profile.pay_as_you_go_balance);
  if (subscription === undefined && paygo === undefined) throw new QuotaError('schema');

  const weekStart = timestamp(profile.last_week_reset);
  const monthStart = timestamp(profile.last_month_reset);
  const windows = spendingLimitWindows(balanceData) ?? [
    ...limitWindow('daily', '1d', 86400, balanceData.daily_limit, balanceData.daily_spent,
      timestamp(balanceData.daily_resets_at ?? balanceData.daily_reset_at)),
    ...limitWindow('weekly', '1w', 604800, balanceData.weekly_limit ?? plan.weekly_limit,
      balanceData.weekly_spent_balance ?? balanceData.weekly_spent ?? profile.current_week_spend,
      timestamp(balanceData.weekly_resets_at ?? balanceData.weekly_reset_at)
        ?? (weekStart === null ? null : weekStart + 604800000)),
    ...limitWindow('monthly', '30d', 2592000, balanceData.monthly_spend_limit ?? plan.monthly_spend_limit,
      balanceData.monthly_spent_balance ?? balanceData.monthly_spent ?? profile.current_month_spend,
      timestamp(balanceData.monthly_resets_at ?? balanceData.monthly_reset_at)
        ?? (monthStart === null ? null : monthStart + 2592000000)),
  ];
  return { windows, balance: { currency: 'USD', remaining: (subscription ?? 0) + (paygo ?? 0) } };
}

export function createYesCodeAdapter(provider: string, options: YesCodeOptions): QuotaAdapter {
  const credentials = validateYesCodeOptions(options);
  let session: YesCodeSession | undefined;
  return {
    provider, label: provider,
    async query(context) {
      await officialAuth(context, YESCODE_ORIGIN);
      const login = async (): Promise<YesCodeSession> => parseYesCodeLogin(await context.postJson(
        `${YESCODE_ORIGIN}/api/v1/auth/login`,
        { username: credentials.username, password: credentials.password },
        { Origin: YESCODE_ORIGIN, Referer: `${YESCODE_ORIGIN}/login` }, context.signal), context.now());
      const fetchAccount = async (current: YesCodeSession): Promise<Omit<QuotaSnapshot, 'fetchedAt'>> => {
        const [profile, balance] = await Promise.all([
          context.getJson(`${YESCODE_ORIGIN}/api/v1/auth/profile`, current.headers, context.signal),
          // Optional endpoint: a plain 404 must not fail the whole query.
          context.getJson(`${YESCODE_ORIGIN}/api/v1/user/balance`, current.headers, context.signal)
            .catch((error: unknown) => {
              if (error instanceof QuotaError && error.code === 'http') return undefined;
              throw error;
            }),
        ]);
        return parseYesCodeAccount(balance, profile);
      };
      if (!session || context.now() >= session.expiresAt) session = await login();
      try {
        return { ...await fetchAccount(session), fetchedAt: context.now() };
      } catch (error) {
        // Session died early (24h cookie or revocation): re-login once, then give up.
        if (!(error instanceof QuotaError) || error.code !== 'auth') throw error;
        session = await login();
        return { ...await fetchAccount(session), fetchedAt: context.now() };
      }
    },
  };
}
