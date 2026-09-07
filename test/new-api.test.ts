import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNewApiAdapter, newApiUsageUrl, parseNewApi } from '../src/query/new-api.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext, QuotaState } from '../src/query/types.ts';
import { validateSnapshot } from '../src/query/registry.ts';
import { loadQuotaAdaptersFromSettings, parseQuotaConfig, QuotaConfigError } from '../src/config.ts';
import { renderFooter, renderUsage } from '../src/bar/quota.ts';
import { captureUsage, usageCardComponent } from '../src/bar/card.ts';

const payload = { success: true, data: { quota: 6170000, used_quota: 28390000, group: 'private', email: 'private' } };
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'my-gateway', signal: new AbortController().signal, now: () => 100000,
  getAuth: async () => ({ apiKey: 'GATEWAY-SECRET', baseUrl: 'https://gateway.test/v1' }),
  getJson: async () => payload, ...overrides,
});

test('new-api maps raw quota into separate amounts, never inventing a periodic percentage', () => {
  assert.deepEqual(parseNewApi(payload), { currency: 'USD', remaining: 12.34, used: 56.78 });
  assert.deepEqual(parseNewApi({ success: true, data: { quota: '2000', used_quota: '500' } }, {
    quotaPerUnit: 100, currency: 'CNY',
  }), { currency: 'CNY', remaining: 20, used: 5 });
  assert.deepEqual(parseNewApi({ success: true, data: { quota: 0, used_quota: 0 } }), {
    currency: 'USD', remaining: 0, used: 0,
  });
  assert.equal(parseNewApi({ success: true, data: { quota: -500000, used_quota: 500000 } }).remaining, -1);
});

test('new-api rejects missing, invalid, unsafe quota fields and false-success responses', () => {
  for (const value of [null, {}, { success: true }, { success: false, message: 'SECRET' },
    { success: 'true', data: payload.data },
    ...[{ quota: 1 }, { quota: null, used_quota: 1 }, { quota: '', used_quota: 1 },
      { quota: true, used_quota: 1 }, { quota: 1, used_quota: -1 },
      { quota: 1.5, used_quota: 0 }, { quota: 1e30, used_quota: 0 }].map(data => ({ success: true, data }))]) {
    assert.throws(() => parseNewApi(value), error => {
      assert.ok(error instanceof QuotaError);
      assert.equal(error.message.includes('SECRET'), false);
      return true;
    });
  }
  for (const quotaPerUnit of [0, -1, Infinity, NaN]) {
    assert.throws(() => createNewApiAdapter('a', { quotaPerUnit }));
  }
});

test('URL derivation stays on the configured origin, handles /v1 and subpath installs', () => {
  for (const [base, expected] of [
    ['https://host.test', 'https://host.test/api/user/self'],
    ['https://host.test/v1/', 'https://host.test/api/user/self'],
    ['https://host.test/new-api/v1', 'https://host.test/new-api/api/user/self'],
    ['https://host.test/new-api/', 'https://host.test/new-api/api/user/self'],
    ['http://127.0.0.1:3000/v1', 'http://127.0.0.1:3000/api/user/self'],
    ['http://[::1]:3000', 'http://[::1]:3000/api/user/self'],
  ]) assert.equal(newApiUsageUrl(base), expected);
  for (const base of [undefined, '', 'invalid', 'http://remote.test/v1', 'file:///tmp/key',
    'https://user:pass@host.test', 'https://host.test?key=secret', 'https://host.test/#fragment']) {
    assert.throws(() => newApiUsageUrl(base), QuotaError);
  }
});

test('new-api uses only the selected provider auth and makes exactly one /api/user/self request', async () => {
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
      assert.equal(url, 'https://gateway.test/api/user/self');
      assert.deepEqual(headers, { Authorization: 'Bearer runtime-key' });
      assert.equal(passedSignal, signal);
      return payload;
    },
  }));
  assert.equal(authCalls, 1);
  assert.equal(calls, 1);
  assert.deepEqual(result, { windows: [], balance: { currency: 'USD', remaining: 12.34, used: 56.78 }, fetchedAt: 100000 });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('runtime-key'), false);
});

test('account access denied never falls back to billing, browser cookies or another key', async () => {
  let calls = 0;
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ getJson: async url => {
    calls++;
    assert.ok(url.endsWith('/api/user/self'));
    throw new QuotaError('auth');
  } })), error => error instanceof QuotaError && error.code === 'account-access');
  assert.equal(calls, 1);
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ getAuth: async () => undefined,
    getJson: async () => assert.fail('No HTTP without auth'),
  })), QuotaError);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(createNewApiAdapter('my-gateway').query(context({ signal: abort.signal,
    getJson: async () => assert.fail('No HTTP after abort'),
  })));
});

test('snapshots may contain amounts without windows; malformed balances are rejected', () => {
  const snapshot = { windows: [], fetchedAt: 100000, balance: parseNewApi(payload) };
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
  assert.throws(() => validateSnapshot({ windows: [], fetchedAt: 100000 }), QuotaError);
  for (const balance of [{ currency: 'USD', remaining: NaN, used: 0 },
    { currency: 'USD', remaining: 0, used: -1 }, { currency: 'USD\n', remaining: 1, used: 0 }]) {
    assert.throws(() => validateSnapshot({ ...snapshot, balance }), QuotaError);
  }
});

test('balance display is compact, aligned, without fabricated bars, percentages or reset timers', () => {
  const state: QuotaState = { kind: 'ready', provider: 'my-gateway', label: 'my-gateway',
    snapshot: { windows: [], balance: parseNewApi(payload), fetchedAt: 100000 } };
  assert.equal(renderFooter(state), 'Bal $12.34 ');
  assert.deepEqual(renderUsage(state), [
    'my-gateway · Balance', '', 'Balance  $12.34', 'Used     $56.78',
  ]);
  const card = captureUsage(state, 100001)!;
  assert.deepEqual(usageCardComponent(JSON.parse(JSON.stringify(card))).render(80).map(line => line.trimEnd()), renderUsage(state));
  const text = renderUsage(state).join('\n');
  assert.equal(/[↺%█]/u.test(text), false);
  const zero: QuotaState = { ...state, snapshot: { ...state.snapshot,
    balance: { currency: 'USD', remaining: 0, used: 1234.56 } } };
  assert.deepEqual(renderUsage(zero).slice(2), ['Balance     $0.00', 'Used     $1234.56']);
  const calls: string[] = [];
  renderFooter(zero, (tone, text) => { if (text === '$0.00') calls.push(tone); return text; });
  assert.deepEqual(calls, ['error']);
});

test('config binds explicit provider IDs and validates optional unit/currency settings', () => {
  const config = parseQuotaConfig({ providers: {
    micucode: { adapter: 'new-api' }, other: { adapter: 'new-api', quotaPerUnit: 1000, currency: 'CNY' },
  } });
  assert.deepEqual(config.providers.micucode, { adapter: 'new-api', quotaPerUnit: 500000, currency: 'USD' });
  assert.equal(config.providers.other.quotaPerUnit, 1000);
  for (const value of [null, {}, { providers: [] }, { providers: {}, apiKey: 'SECRET' },
    ...[{ adapter: 'billing' }, { adapter: 'new-api', quotaPerUnit: 0 },
      { adapter: 'new-api', quotaPerUnit: null }, { adapter: 'new-api', quotaPerUnit: '500000' },
      { adapter: 'new-api', currency: 'usd' }, { adapter: 'new-api', apiKey: 'SECRET' }]
      .map(item => ({ providers: { gateway: item } })),
    { providers: { 'openai-codex': { adapter: 'new-api' } } },
    { providers: { 'kimi-coding': { adapter: 'new-api' } } },
  ]) {
    assert.throws(() => parseQuotaConfig(value), error => {
      assert.ok(error instanceof QuotaConfigError);
      assert.equal(error.message.includes('SECRET'), false);
      return true;
    });
  }
});

test('settings loading is optional, namespaced, deterministic, and never exposes unrelated values', () => {
  assert.deepEqual(loadQuotaAdaptersFromSettings({ theme: 'dark' }), []);
  const adapters = loadQuotaAdaptersFromSettings({
    theme: 'dark', quotaUsage: { providers: { ctn: { adapter: 'new-api' }, micu: { adapter: 'new-api' } } },
  });
  assert.deepEqual(adapters.map(adapter => adapter.provider), ['ctn', 'micu']);
  assert.throws(() => loadQuotaAdaptersFromSettings({
    quotaUsage: { providers: { gateway: { adapter: 'new-api', apiKey: 'SECRET' } } },
  }), error => {
    assert.ok(error instanceof QuotaConfigError);
    assert.equal(error.message.includes('SECRET'), false);
    return true;
  });
});
