import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewApiAdapter, newApiRootUrl, parseNewApiBilling, parseNewApiTokenUsage, parseNewApiUserSelf } from '../src/query/new-api.ts';
import { parseDeepSeekBalance } from '../src/query/deepseek.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext, QuotaState } from '../src/query/types.ts';
import { validateSnapshot } from '../src/query/registry.ts';
import { loadQuotaAdaptersFromSettings, parseQuotaConfig, QuotaConfigError } from '../src/config.ts';
import { renderFooter, renderUsage } from '../src/bar/quota.ts';
import { captureUsage, usageCardComponent } from '../src/bar/card.ts';

const payload = { code: true, message: 'ok', data: { object: 'token_usage', name: 't', total_granted: 34560000,
  total_used: 28390000, total_available: 6170000, unlimited_quota: false, model_limits_enabled: false, expires_at: 0 } };
const balance = { currency: 'USD', remaining: 12.34 };
const keyAllowance = { currency: 'USD', limit: 69.12, used: 56.78, remaining: 12.34 };
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'my-gateway', signal: new AbortController().signal, now: () => 100000,
  getAuth: async () => ({ apiKey: 'GATEWAY-SECRET', baseUrl: 'https://gateway.test/v1' }),
  getJson: async () => payload, ...overrides,
});

test('new-api finite key uses its explicit granted/used/remaining, not a periodic window', () => {
  assert.deepEqual(parseNewApiTokenUsage(payload), { allowance: keyAllowance });
  assert.deepEqual(parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', total_granted: 2500,
    total_used: '500', total_available: '2000' } }, { quotaPerUnit: 100, currency: 'CNY' }),
  { allowance: { currency: 'CNY', limit: 25, used: 5, remaining: 20 } });
  assert.deepEqual(parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', total_granted: 0,
    total_used: 0, total_available: 0 } }),
  { balance: { currency: 'USD', remaining: 0 }, spend: { currency: 'USD', lifetime: 0 } });
  assert.deepEqual(parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', total_used: 500000,
    total_available: -500000 } }),
  { balance: { currency: 'USD', remaining: -1 }, spend: { currency: 'USD', lifetime: 1 } });
  assert.deepEqual(parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', total_granted: 500000,
    total_used: 600000, total_available: -100000 } }),
  { allowance: { currency: 'USD', limit: 1, used: 1.2, remaining: -0.2 } });
  assert.deepEqual(parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', total_used: 500,
    unlimited_quota: true } }),
  { balance: { currency: 'USD', remaining: 0, unlimited: true }, spend: { currency: 'USD', lifetime: 0.001 } });
});

test('legacy billing reports account balance and lifetime spend; 1e8 limit means unlimited', () => {
  assert.deepEqual(parseNewApiBilling({ object: 'billing_subscription', hard_limit_usd: 100 },
    { object: 'list', total_usage: 1525.53 }),
  { balance: { currency: 'USD', remaining: 84.7447 }, spend: { currency: 'USD', lifetime: 15.2553 } });
  assert.deepEqual(parseNewApiBilling({ hard_limit_usd: 100000000 }, { total_usage: 6292511.12 }),
  { balance: { currency: 'USD', remaining: 0, unlimited: true }, spend: { currency: 'USD', lifetime: 62925.1112 } });
  for (const pair of [[{}, {}], [{ hard_limit_usd: 100 }, {}], [{ hard_limit_usd: -1 }, { total_usage: 0 }],
    [{ hard_limit_usd: 100 }, { total_usage: -1 }]] as const) {
    assert.throws(() => parseNewApiBilling(pair[0], pair[1]), QuotaError);
  }
});

test('deepseek balance: string amounts in yuan, first valid currency wins, no fabricated usage', () => {
  assert.deepEqual(parseDeepSeekBalance({ is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '98.07', granted_balance: '0.00', topped_up_balance: '98.07' }] }),
    { currency: 'CNY', remaining: 98.07 });
  assert.throws(() => parseDeepSeekBalance({ is_available: false, balance_infos: [] }), QuotaError);
  assert.throws(() => parseDeepSeekBalance({ balance_infos: [{ currency: 'cny', total_balance: '1' }] }), QuotaError);
});

test('new-api rejects missing, invalid, unsafe quota fields and non-token-usage responses', () => {
  // Wrong shell or wrong object type: not a token-usage response → null (caller falls back).
  for (const value of [null, {}, { code: false }, { code: true, data: { object: 'other' } }]) {
    assert.equal(parseNewApiTokenUsage(value), null);
  }
  // Valid shell but corrupt amounts must not become a made-up zero balance.
  for (const data of [{ total_used: 1 }, { total_used: null, total_available: 1 },
    { total_used: '', total_available: 1 }, { total_used: true, total_available: 1 },
    { total_used: 1.5, total_available: 0 }, { total_used: 1e30, total_available: 0 },
    { total_used: 1, total_available: 2, total_granted: 4 },
    { total_used: 1, total_available: 2, total_granted: -1 }]) {
    assert.throws(() => parseNewApiTokenUsage({ code: true, data: { object: 'token_usage', ...data } }), QuotaError);
  }
  for (const quotaPerUnit of [0, -1, Infinity, NaN]) {
    assert.throws(() => createNewApiAdapter('a', { quotaPerUnit }));
  }
});

test('URL derivation stays on the configured origin, handles /v1 and subpath installs', () => {
  for (const [base, expected] of [
    ['https://host.test', 'https://host.test'],
    ['https://host.test/v1/', 'https://host.test'],
    ['https://host.test/v1beta', 'https://host.test'],
    ['https://host.test/new-api/v1', 'https://host.test/new-api'],
    ['https://host.test/new-api/', 'https://host.test/new-api'],
    ['http://127.0.0.1:3000/v1', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ]) assert.equal(newApiRootUrl(base), expected);
  for (const base of [undefined, '', 'invalid', 'http://remote.test/v1', 'file:///tmp/key',
    'https://user:pass@host.test', 'https://host.test?key=secret', 'https://host.test/#fragment']) {
    assert.throws(() => newApiRootUrl(base), QuotaError);
  }
});

test('dashboard /api/user/self separates account balance from lifetime spend', () => {
  assert.deepEqual(parseNewApiUserSelf({ success: true, data: { quota: 27151218, used_quota: 1788848782 } }),
  { balance: { currency: 'USD', remaining: 54.302436 },
    spend: { currency: 'USD', lifetime: 3577.697564 } });
  assert.deepEqual(parseNewApiUserSelf({ success: true, data: { quota: '5000', used_quota: '200' } },
    { quotaPerUnit: 100, currency: 'CNY' }),
  { balance: { currency: 'CNY', remaining: 50 }, spend: { currency: 'CNY', lifetime: 2 } });
  assert.deepEqual(parseNewApiUserSelf({ success: true, data: { quota: 0, used_quota: 0 } }),
  { balance: { currency: 'USD', remaining: 0 }, spend: { currency: 'USD', lifetime: 0 } });
  for (const payload of [{}, { success: false }, { success: true, data: { quota: 1 } },
    { success: true, data: { quota: -1, used_quota: 0 } }, { success: true, data: { quota: 1.5, used_quota: 0 } },
    { success: true, data: { quota: 1e30, used_quota: 0 } }, { success: true, data: { quota: 0, used_quota: null } }]) {
    assert.throws(() => parseNewApiUserSelf(payload), QuotaError);
  }
});

test('new-api queries billing first and a finite hard limit wins without token lookup', async () => {
  let authCalls = 0;
  let calls = 0;
  const signal = new AbortController().signal;
  const result = await createNewApiAdapter('my-gateway').query(context({
    signal, getAuth: async provider => {
      authCalls++;
      assert.equal(provider, 'my-gateway');
      return { apiKey: 'unused', baseUrl: 'https://gateway.test/v1', headers: { Authorization: 'Bearer runtime-key' } };
    },
    getJson: async (url, headers, passedSignal) => {
      calls++;
      assert.ok(url === 'https://gateway.test/v1/dashboard/billing/subscription'
        || url.startsWith('https://gateway.test/v1/dashboard/billing/usage?'));
      assert.deepEqual(headers, { Authorization: 'Bearer runtime-key' });
      assert.equal(passedSignal, signal);
      return url.endsWith('/subscription') ? { hard_limit_usd: 100 } : { total_usage: 5678 };
    },
  }));
  assert.equal(authCalls, 1);
  assert.equal(calls, 2); // subscription + usage in parallel, no token request
  assert.deepEqual(result, { windows: [], balance: { currency: 'USD', remaining: 43.22 },
    spend: { currency: 'USD', lifetime: 56.78 }, fetchedAt: 100000 });
  assert.equal(JSON.stringify(result).includes('runtime-key'), false);
});

test('billing 404/absent falls through to the token endpoint; auth denial maps to account-access', async () => {
  let calls = 0;
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ getJson: async url => {
    calls++;
    if (url.includes('/dashboard/billing/')) throw new QuotaError('auth');
    assert.ok(url.endsWith('/api/usage/token/'));
    throw new QuotaError('auth');
  } })), error => error instanceof QuotaError && error.code === 'account-access');
  assert.equal(calls, 3); // 2 billing + 1 token
  calls = 0;
  const result = await createNewApiAdapter('my-gateway').query(context({ getJson: async url => {
    calls++;
    if (url.includes('/dashboard/billing/')) throw new QuotaError('http'); // billing absent
    assert.ok(url.endsWith('/api/usage/token/'));
    return payload;
  } }));
  assert.equal(calls, 3);
  assert.deepEqual(result.allowance, keyAllowance);
  assert.deepEqual(validateSnapshot(result).allowance, keyAllowance);
  calls = 0;
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ getJson: async () => {
    calls++;
    throw new QuotaError('http');
  } })), error => error instanceof QuotaError && error.code === 'http');
  assert.equal(calls, 3);
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ getAuth: async () => undefined,
    getJson: async () => assert.fail('No HTTP without auth'),
  })), QuotaError);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ signal: abort.signal,
    getJson: async () => assert.fail('No HTTP after abort'),
  })));
});

test('unlimited billing falls through to a finite key quota', async () => {
  let calls = 0;
  const result = await createNewApiAdapter('my-gateway').query(context({ getJson: async url => {
    calls++;
    if (url.endsWith('/subscription')) return { hard_limit_usd: 100000000 };
    if (url.includes('/dashboard/billing/usage')) return { total_usage: 152.553 };
    assert.ok(url.endsWith('/api/usage/token/'));
    return payload;
  } }));
  assert.equal(calls, 3);
  assert.deepEqual(result.allowance, keyAllowance);
});

test('snapshots may contain amounts without windows; malformed balances are rejected', () => {
  const snapshot = { windows: [], fetchedAt: 100000, balance };
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  assert.throws(() => validateSnapshot({ windows: [], fetchedAt: 100000 }), QuotaError);
  for (const balance of [{ currency: 'USD', remaining: NaN },
    { currency: 'usd', remaining: 0 }, { currency: 'USD\n', remaining: 1 }]) {
    assert.throws(() => validateSnapshot({ ...snapshot, balance }), QuotaError);
  }
});

test('balance display is compact, aligned, without fabricated bars, percentages or reset timers', () => {
  const state: QuotaState = { kind: 'ready', provider: 'my-gateway', label: 'my-gateway',
    snapshot: { windows: [], balance, fetchedAt: 100000 } };
  assert.equal(renderFooter(state), 'Bal $12.34 ');
  assert.deepEqual(renderUsage(state), [
    'my-gateway · Balance', '', 'Balance   $12.34',
  ]);
  const card = captureUsage(state, 100001)!;
  assert.deepEqual(usageCardComponent(JSON.parse(JSON.stringify(card))).render(80).map(line => line.trimEnd()), renderUsage(state));
  const text = renderUsage(state).join('\n');
  assert.equal(/[↺%█]/u.test(text), false);
  const unlimited: QuotaState = { ...state, snapshot: { ...state.snapshot,
    balance: { currency: 'USD', remaining: 0, unlimited: true } } };
  assert.equal(renderFooter(unlimited), 'Bal $∞ ');
  assert.deepEqual(renderUsage(unlimited).slice(2), ['Balance   $∞']);
  const zero: QuotaState = { ...state, snapshot: { ...state.snapshot,
    balance: { currency: 'USD', remaining: 0 } } };
  assert.deepEqual(renderUsage(zero).slice(2), ['Balance   $0.00']);
  const calls: string[] = [];
  renderFooter(zero, (tone, text) => { if (text === '$0.00') calls.push(tone); return text; });
  assert.deepEqual(calls, ['error']);
});

test('key allowance shows a finite bar, while account spend never appears in the footer', () => {
  const key: QuotaState = { kind: 'ready', provider: 'key', label: 'key',
    snapshot: { windows: [], allowance: keyAllowance, fetchedAt: 100000 } };
  assert.equal(renderFooter(key), 'Quota [▁] $12.34 ');
  assert.deepEqual(renderUsage(key), ['key · Remaining quota', '',
    '[████░░░░░░░░░░░░░░░░]  $12.34 left', 'Used      $56.78', 'Limit     $69.12']);
  assert.equal(renderUsage(key).join('\n').includes('↺'), false);
  const account: QuotaState = { kind: 'ready', provider: 'account', label: 'account',
    snapshot: { windows: [], balance, spend: { currency: 'USD', lifetime: 56.78 }, fetchedAt: 100000 } };
  assert.equal(renderFooter(account), 'Bal $12.34 ');
  assert.deepEqual(renderUsage(account), ['account · Account', '', 'Balance   $12.34', '', 'Lifetime  $56.78']);
});

test('config binds explicit provider IDs and validates optional unit/currency settings', () => {
  const config = parseQuotaConfig({ providers: {
    micucode: { adapter: 'new-api' }, other: { adapter: 'new-api', quotaPerUnit: 1000, currency: 'CNY' },
    deepseek: { adapter: 'deepseek' }, sub2: { adapter: 'sub2api' },
  } });
  assert.deepEqual(config.providers.micucode, { adapter: 'new-api', quotaPerUnit: 500000, currency: 'USD' });
  assert.equal(config.providers.other.adapter, 'new-api');
  if (config.providers.other.adapter === 'new-api') assert.equal(config.providers.other.quotaPerUnit, 1000);
  assert.equal(config.providers.deepseek.adapter, 'deepseek');
  assert.equal(config.providers.sub2.adapter, 'sub2api');
  for (const value of [null, {}, { providers: [] }, { providers: {}, apiKey: 'SECRET' },
    ...[{ adapter: 'billing' }, { adapter: 'new-api', quotaPerUnit: 0 },
      { adapter: 'new-api', quotaPerUnit: null }, { adapter: 'new-api', quotaPerUnit: '500000' },
      { adapter: 'new-api', currency: 'usd' }, { adapter: 'new-api', apiKey: 'SECRET' },
      { adapter: 'deepseek', quotaPerUnit: 500000 }, { adapter: 'deepseek', currency: 'CNY' },
      { adapter: 'sub2api', currency: 'USD' }]
      .map(item => ({ providers: { gateway: item } })),
    { providers: { 'openai-codex': { adapter: 'new-api' } } },
    { providers: { 'kimi-coding': { adapter: 'new-api' } } },
    { providers: { 'opencode-go': { adapter: 'new-api' } } },
  ]) {
    assert.throws(() => parseQuotaConfig(value), error => {
      assert.ok(error instanceof QuotaConfigError);
      assert.equal(error.message.includes('SECRET'), false);
      return true;
    });
  }
});

test('dashboard PAT is queried first and wins without billing or token lookups', async () => {
  const seen: string[] = [];
  const result = await createNewApiAdapter('my-gateway', {
    dashboardAccessToken: 'PAT-SECRET', dashboardUserId: 42684,
  }).query(context({ getJson: async (url, headers) => {
    seen.push(url);
    assert.equal(url, 'https://gateway.test/api/user/self');
    assert.deepEqual(headers, { Authorization: 'Bearer PAT-SECRET', 'New-Api-User': '42684' });
    return { success: true, data: { quota: 27151218, used_quota: 1788848782 } };
  } }));
  assert.deepEqual(seen, ['https://gateway.test/api/user/self']);
  assert.deepEqual(result.balance, { currency: 'USD', remaining: 54.302436 });
  assert.deepEqual(result.spend, { currency: 'USD', lifetime: 3577.697564 });
  assert.equal(JSON.stringify(result).includes('PAT-SECRET'), false);
  // No dashboardUserId: no legacy header on new deployments.
  await createNewApiAdapter('my-gateway', { dashboardAccessToken: 'PAT-SECRET' }).query(context({
    getJson: async (_url, headers) => {
      assert.deepEqual(headers, { Authorization: 'Bearer PAT-SECRET' });
      return { success: true, data: { quota: 0, used_quota: 0 } };
    },
  }));
});

test('dashboard /api/user/self failure falls through to the billing/token chain', async () => {
  let calls = 0;
  const query = createNewApiAdapter('my-gateway', { dashboardAccessToken: 'PAT-SECRET' });
  const result = await query.query(context({ getJson: async url => {
    calls++;
    if (url.endsWith('/api/user/self')) throw new QuotaError('auth'); // PAT expired
    if (url.endsWith('/subscription')) return { hard_limit_usd: 100 };
    if (url.includes('/dashboard/billing/usage')) return { total_usage: 5678 };
    return payload;
  } }));
  assert.equal(calls, 3); // user/self + 2 billing; finite hard limit wins without token lookup
  assert.deepEqual(result.balance, { currency: 'USD', remaining: 43.22 });
  assert.deepEqual(result.spend, { currency: 'USD', lifetime: 56.78 });
  calls = 0;
  await assert.rejects(query.query(context({ getJson: async url => {
    calls++;
    if (url.endsWith('/api/user/self')) return { success: false, message: 'nope' }; // old fork shell
    throw new QuotaError('http');
  } })), error => error instanceof QuotaError && error.code === 'http');
  assert.equal(calls, 4);
});

test('config accepts dashboard PAT options, rejects malformed ones without echoing secrets', () => {
  const config = parseQuotaConfig({ providers: {
    micu: { adapter: 'new-api', dashboardAccessToken: 'PAT-SECRET', dashboardUserId: 42684 },
    plain: { adapter: 'new-api' },
  } });
  assert.deepEqual(config.providers.micu, { adapter: 'new-api', quotaPerUnit: 500000, currency: 'USD',
    dashboardAccessToken: 'PAT-SECRET', dashboardUserId: 42684 });
  assert.equal(config.providers.plain.adapter, 'new-api');
  if (config.providers.plain.adapter === 'new-api') assert.equal(config.providers.plain.dashboardAccessToken, undefined);
  for (const item of [{ adapter: 'new-api', dashboardAccessToken: '' },
    { adapter: 'new-api', dashboardAccessToken: 42 },
    { adapter: 'new-api', dashboardUserId: 0 },
    { adapter: 'new-api', dashboardUserId: 1.5 },
    { adapter: 'new-api', dashboardUserId: '42684' },
    { adapter: 'deepseek', dashboardAccessToken: 'PAT-SECRET' }]) {
    assert.throws(() => parseQuotaConfig({ providers: { gateway: item } }), error => {
      assert.ok(error instanceof QuotaConfigError);
      assert.equal(error.message.includes('PAT-SECRET'), false);
      return true;
    });
  }
  for (const options of [{ dashboardAccessToken: ' ' }, { dashboardUserId: -1 }, { dashboardUserId: NaN }]) {
    assert.throws(() => createNewApiAdapter('a', options));
  }
});

test('settings loading is optional, namespaced, deterministic, and never exposes unrelated values', () => {
  assert.deepEqual(loadQuotaAdaptersFromSettings({ theme: 'dark' }), []);
  const adapters = loadQuotaAdaptersFromSettings({
    theme: 'dark', quotaUsage: { providers: { ctn: { adapter: 'new-api' }, micu: { adapter: 'new-api' }, sub: { adapter: 'sub2api' } } },
  });
  assert.deepEqual(adapters.map(adapter => adapter.provider), ['ctn', 'micu', 'sub']);
  assert.throws(() => loadQuotaAdaptersFromSettings({
    quotaUsage: { providers: { gateway: { adapter: 'new-api', apiKey: 'SECRET' } } },
  }), error => {
    assert.ok(error instanceof QuotaConfigError);
    assert.equal(error.message.includes('SECRET'), false);
    return true;
  });
});
