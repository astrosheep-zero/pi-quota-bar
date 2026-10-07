import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYesCodeAdapter, parseYesCodeAccount, parseYesCodeLogin } from '../src/query/yescode.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext } from '../src/query/types.ts';
import { validateSnapshot } from '../src/query/registry.ts';
import { loadQuotaAdaptersFromSettings, parseQuotaConfig, QuotaConfigError } from '../src/config.ts';

const now = Date.parse('2026-10-07T12:00:00Z');
const credentials = { username: 'user@example.com', password: 'PASSWORD-SECRET' };
const setCookie = [
  'yescode_auth=JWT-SECRET; Path=/; HttpOnly; Max-Age=86400',
  'yescode_csrf=CSRF-SECRET; Path=/; Max-Age=86400',
];
const profilePayload = {
  subscription_balance: 95.88, pay_as_you_go_balance: 21.86,
  current_week_spend: 4.12, last_week_reset: '2026-10-05T00:00:00+00:00',
  subscription_plan: { weekly_limit: 100 },
};
const balancePayload = {
  subscription_balance: '95.88', pay_as_you_go_balance: '21.86',
  spending_limits: [
    { key: 'subscription_monthly', scope: 'subscription', spent: 4.12, limit: 430,
      remaining: 425.88, period_started_at: '2026-10-07T00:00:00Z',
      resets_at: '2026-11-06T00:00:00Z', window_seconds: 2592000 },
    { key: 'subscription_weekly', scope: 'subscription', spent: 4.12, limit: 100,
      remaining: 95.88, period_started_at: '2026-10-05T00:00:00Z',
      resets_at: '2026-10-12T00:00:00Z', window_seconds: 604800 },
  ],
  weekly_limit: 100, weekly_spent_balance: 4.12, weekly_reset_at: '2026-10-12T00:00:00Z',
  monthly_spend_limit: 430, monthly_spent_balance: 4.12, monthly_reset_at: '2026-11-06T00:00:00Z',
};
// Legacy shape without spending_limits (top-level fields only).
const flatBalancePayload = {
  subscription_balance: '95.88', pay_as_you_go_balance: '21.86',
  daily_limit: 20, daily_spent: 3, daily_resets_at: '2026-10-08T00:00:00Z',
  weekly_limit: 100, weekly_spent_balance: 4.12, weekly_reset_at: '2026-10-12T00:00:00Z',
  monthly_spend_limit: 430, monthly_spent_balance: 4.12, monthly_reset_at: '2026-11-06T00:00:00Z',
};

const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'yes-vg', signal: new AbortController().signal, now: () => now,
  getAuth: async () => ({ apiKey: 'cr_MODEL_KEY', baseUrl: 'https://co.yes.vg' }),
  getJson: async () => profilePayload,
  postJson: async () => ({ body: { token: 'JWT-SECRET' }, setCookie }),
  ...overrides,
});

test('login prefers the cookie pair; bare JWT is the fallback', () => {
  const cookie = parseYesCodeLogin({ body: { token: 'JWT-SECRET' }, setCookie }, now);
  assert.deepEqual(cookie.headers, { Cookie: 'yescode_auth=JWT-SECRET; yescode_csrf=CSRF-SECRET' });
  assert.equal(cookie.expiresAt, now + 23 * 3600 * 1000);
  const jwt = parseYesCodeLogin({ body: { token: 'JWT-SECRET' }, setCookie: [] }, now);
  assert.deepEqual(jwt.headers, { Authorization: 'Bearer JWT-SECRET' });
  // An empty cookie value falls back to the JWT, not to an error.
  assert.deepEqual(parseYesCodeLogin({ body: { token: 'ok' }, setCookie: ['yescode_auth=; Path=/'] }, now).headers,
    { Authorization: 'Bearer ok' });
  for (const result of [{ body: {}, setCookie: [] }, { body: { token: '' }, setCookie: [] },
    { body: { token: 'has space' }, setCookie: [] }, { body: null, setCookie: [] }]) {
    assert.throws(() => parseYesCodeLogin(result, now), QuotaError);
  }
});

test('account parse: wallet is subscription + paygo; spending_limits drive monthly/weekly windows', () => {
  const parsed = parseYesCodeAccount(balancePayload, profilePayload);
  assert.deepEqual(parsed.balance, { currency: 'USD', remaining: 117.74 });
  const [weekly, monthly] = parsed.windows;
  assert.deepEqual(weekly, { id: 'spending:subscription_weekly', label: '1w', durationSeconds: 604800,
    remainingPercent: 95.88, resetAt: Date.parse('2026-10-12T00:00:00Z'),
    amounts: { currency: 'USD', limit: 100, used: 4.12, remaining: 95.88 } });
  assert.deepEqual(monthly, { id: 'spending:subscription_monthly', label: '30d', durationSeconds: 2592000,
    remainingPercent: 425.88 / 430 * 100, resetAt: Date.parse('2026-11-06T00:00:00Z'),
    amounts: { currency: 'USD', limit: 430, used: 4.12, remaining: 425.88 } });
  validateSnapshot({ ...parsed, fetchedAt: now });
});

test('flat top-level fields are the fallback when spending_limits is absent', () => {
  const parsed = parseYesCodeAccount(flatBalancePayload, profilePayload);
  const [daily, weekly, monthly] = parsed.windows;
  assert.deepEqual(daily, { id: 'daily', label: '1d', durationSeconds: 86400,
    remainingPercent: 85, resetAt: Date.parse('2026-10-08T00:00:00Z'),
    amounts: { currency: 'USD', limit: 20, used: 3, remaining: 17 } });
  assert.equal(weekly?.id, 'weekly');
  assert.equal(weekly?.resetAt, Date.parse('2026-10-12T00:00:00Z'));
  assert.equal(monthly?.id, 'monthly');
  assert.equal(monthly?.label, '30d');
  assert.equal(monthly?.resetAt, Date.parse('2026-11-06T00:00:00Z'));
  assert.equal(monthly?.remainingPercent, 425.88 / 430 * 100);
  validateSnapshot({ ...parsed, fetchedAt: now });
});

test('profile-only fallback derives resets from last_*_reset; absent caps yield no windows', () => {
  const parsed = parseYesCodeAccount(undefined, { ...profilePayload,
    current_month_spend: 4.12, last_month_reset: '2026-10-07T00:00:00+00:00',
    subscription_plan: { weekly_limit: 100, monthly_spend_limit: 430 } });
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.windows[0]?.resetAt, Date.parse('2026-10-05T00:00:00Z') + 604800000);
  assert.equal(parsed.windows[0]?.remainingPercent, 95.88);
  assert.equal(parsed.windows[1]?.id, 'monthly');
  assert.equal(parsed.windows[1]?.resetAt, Date.parse('2026-10-07T00:00:00Z') + 2592000000);
  const uncapped = parseYesCodeAccount({ subscription_balance: 5 },
    { pay_as_you_go_balance: 2, subscription_plan: { weekly_limit: 0, monthly_spend_limit: 0 } });
  assert.deepEqual(uncapped.windows, []);
  assert.deepEqual(uncapped.balance, { currency: 'USD', remaining: 7 });
  // A limit without a known spend is a window with unknown percent, not a fake 100%.
  const unknownUse = parseYesCodeAccount({ subscription_balance: 5, weekly_limit: 100 }, {});
  assert.equal(unknownUse.windows[0]?.remainingPercent, null);
  assert.equal(unknownUse.windows[0]?.amounts, undefined);
});

test('account parse rejects missing balances and corrupt amounts', () => {
  assert.throws(() => parseYesCodeAccount({}, {}), QuotaError);
  assert.throws(() => parseYesCodeAccount(undefined, {}), QuotaError);
  for (const payload of [{ subscription_balance: 'x' },
    { subscription_balance: 1, weekly_limit: -5 }, { subscription_balance: 1, weekly_spent_balance: -1 },
    { subscription_balance: 1, spending_limits: 'nope' },
    { subscription_balance: 1, spending_limits: [{ spent: 1, limit: 2, window_seconds: 604800 }] },
    { subscription_balance: 1, spending_limits: [{ key: 'k', spent: 1, limit: -2, window_seconds: 604800 }] },
    { subscription_balance: 1, spending_limits: [{ key: 'k', spent: 1, limit: 2, window_seconds: 0 }] }]) {
    assert.throws(() => parseYesCodeAccount(payload, {}), QuotaError);
  }
});

test('uncapped spending_limits entries are skipped; missing spend stays an honest unknown', () => {
  const sparse = parseYesCodeAccount({ subscription_balance: 5, spending_limits: [
    { key: 'a', spent: 1, limit: 0, window_seconds: 604800 },
    { key: 'b', limit: 50, window_seconds: 86400, resets_at: '2026-10-08T00:00:00Z' },
  ] }, {});
  assert.equal(sparse.windows.length, 1);
  assert.equal(sparse.windows[0]?.id, 'spending:b');
  assert.equal(sparse.windows[0]?.remainingPercent, null);
  assert.equal(sparse.windows[0]?.amounts, undefined);
});

test('query logs in once, sends the session cookie to both endpoints, and never leaks secrets', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const adapter = createYesCodeAdapter('yes-vg', credentials);
  const result = await adapter.query(context({
    getJson: async (url, headers) => {
      calls.push({ url, headers });
      return url.endsWith('/user/balance') ? balancePayload : profilePayload;
    },
    postJson: async (url, body, headers) => {
      calls.push({ url, headers });
      assert.equal(url, 'https://co.yes.vg/api/v1/auth/login');
      assert.deepEqual(body, credentials);
      return { body: { token: 'JWT-SECRET' }, setCookie };
    },
  }));
  assert.equal(calls[0]?.url, 'https://co.yes.vg/api/v1/auth/login');
  assert.deepEqual(calls.slice(1).map(call => call.url).sort(), [
    'https://co.yes.vg/api/v1/auth/profile', 'https://co.yes.vg/api/v1/user/balance']);
  assert.deepEqual(calls[1]?.headers, { Cookie: 'yescode_auth=JWT-SECRET; yescode_csrf=CSRF-SECRET' });
  // The model key must never reach account endpoints.
  assert.equal(calls.some(call => JSON.stringify(call.headers).includes('cr_MODEL_KEY')), false);
  assert.deepEqual(result.balance, { currency: 'USD', remaining: 117.74 });
  const serialized = JSON.stringify(result);
  for (const secret of ['PASSWORD-SECRET', 'JWT-SECRET', 'CSRF-SECRET', 'user@example.com']) {
    assert.equal(serialized.includes(secret), false);
  }
  // Second query reuses the cached session: no second login.
  await adapter.query(context());
  assert.equal(calls.filter(call => call.url.endsWith('/auth/login')).length, 1);
});

test('a 401 invalidates the session, triggers exactly one re-login, then succeeds', async () => {
  let logins = 0;
  let profileCalls = 0;
  const adapter = createYesCodeAdapter('yes-vg', credentials);
  const result = await adapter.query(context({
    postJson: async () => { logins++; return { body: { token: 'JWT-SECRET' }, setCookie }; },
    getJson: async url => {
      if (url.endsWith('/user/balance')) throw new QuotaError('http'); // optional endpoint absent
      profileCalls++;
      if (profileCalls === 1) throw new QuotaError('auth'); // expired session
      return profilePayload;
    },
  }));
  assert.equal(logins, 2);
  assert.equal(result.windows[0]?.id, 'weekly');
  // Persistent auth failure surfaces as auth, not an infinite login loop.
  await assert.rejects(adapter.query(context({
    postJson: async () => { logins++; return { body: { token: 'JWT-SECRET' }, setCookie }; },
    getJson: async () => { throw new QuotaError('auth'); },
  })), (error: unknown) => error instanceof QuotaError && error.code === 'auth');
});

test('foreign origins are rejected before any credential is sent', async () => {
  const adapter = createYesCodeAdapter('yes-vg', credentials);
  await assert.rejects(adapter.query(context({
    getAuth: async () => ({ apiKey: 'cr_MODEL_KEY', baseUrl: 'https://evil.test' }),
    postJson: async () => assert.fail('Must not log in against a foreign origin'),
    getJson: async () => assert.fail('Must not send credentials'),
  })), QuotaError);
});

test('config binds yescode with username/password and never echoes secrets', () => {
  const config = parseQuotaConfig({ providers: { 'yes-vg': { adapter: 'yescode', ...credentials } } });
  assert.deepEqual(config.providers['yes-vg'], { adapter: 'yescode', ...credentials });
  const adapters = loadQuotaAdaptersFromSettings({ quotaUsage: { providers: {
    'yes-vg': { adapter: 'yescode', ...credentials } } } });
  assert.deepEqual(adapters.map(adapter => adapter.provider), ['yes-vg']);
  for (const item of [{ adapter: 'yescode', username: 'user@example.com' },
    { adapter: 'yescode', password: 'PASSWORD-SECRET' },
    { adapter: 'yescode', username: '   ', password: 'PASSWORD-SECRET' },
    { adapter: 'yescode', username: 'user@example.com', password: '' },
    { adapter: 'yescode', ...credentials, cookie: 'SESSION-SECRET' }]) {
    assert.throws(() => parseQuotaConfig({ providers: { 'yes-vg': item } }), (error: unknown) => {
      assert.ok(error instanceof QuotaConfigError);
      assert.equal(error.message.includes('PASSWORD-SECRET'), false);
      assert.equal(error.message.includes('SESSION-SECRET'), false);
      return true;
    });
  }
  assert.throws(() => createYesCodeAdapter('yes-vg', { username: '', password: 'y' }));
});
