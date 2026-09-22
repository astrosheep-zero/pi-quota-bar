import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSub2ApiAdapter, parseSub2ApiUsage, sub2ApiUsageUrl } from '../src/query/sub2api.ts';
import { validateSnapshot } from '../src/query/registry.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext, QuotaState } from '../src/query/types.ts';
import { renderFooter, renderUsage } from '../src/bar/quota.ts';

const now = Date.parse('2026-09-07T04:00:00Z');
const wallet = { mode: 'unrestricted', isValid: true, unit: 'USD', planName: '钱包余额',
  balance: 940, remaining: 940, usage: { today: { actual_cost: 2.5 }, total: { actual_cost: 80 } } };
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'gateway', signal: new AbortController().signal, now: () => now,
  getAuth: async () => ({ apiKey: 'SECRET', baseUrl: 'https://host.test/gateway/v1' }),
  getJson: async () => wallet, ...overrides,
});

function state(payload: unknown): QuotaState {
  return { kind: 'ready', provider: 'gateway', label: 'gateway', snapshot: validateSnapshot({
    ...parseSub2ApiUsage(payload), fetchedAt: now,
  }) };
}

test('wallet balance and API-key spend have different labels; spend stays out of footer', () => {
  const result = state(wallet);
  assert.deepEqual(result.kind === 'ready' && result.snapshot, {
    windows: [], balance: { currency: 'USD', remaining: 940 },
    spend: { currency: 'USD', today: 2.5, lifetime: 80 }, fetchedAt: now,
  });
  assert.equal(renderFooter(result), 'Bal $940.00 ');
  assert.deepEqual(renderUsage(result), [
    'gateway · Account', '', 'Balance   $940.00', '', 'Today     $2.50', 'Lifetime  $80.00',
  ]);
});

test('finite key quota and rate windows stay separate; no invented reset for fixed quota', () => {
  const result = state({ mode: 'quota_limited', isValid: true, unit: 'USD',
    quota: { limit: 100, used: 15, remaining: 85, unit: 'USD' },
    rate_limits: [{ window: '5h', limit: 40, used: 10, remaining: 30, reset_at: '2026-09-07T08:00:00Z' }],
  });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.deepEqual(result.snapshot.allowance, { currency: 'USD', limit: 100, used: 15, remaining: 85 });
  assert.deepEqual(result.snapshot.windows.map(w => [w.id, w.durationSeconds, w.remainingPercent]), [['rate-5h', 18000, 75]]);
  assert.equal(renderFooter(result, undefined, now), 'Quota [▇] $85.00 · 5h [▆] 75% ↺ 4h ');
  assert.ok(renderUsage(result, undefined, now).some(line => line.includes('$30.00/$40.00')));
});

test('rate-only key needs no top-level unit; subscription zero caps are not fabricated windows', () => {
  const rateOnly = state({ mode: 'quota_limited', isValid: true,
    rate_limits: [{ window: '7d', limit: 100, used: 20, remaining: 80 }],
  });
  assert.equal(rateOnly.kind, 'ready');
  if (rateOnly.kind !== 'ready') return;
  assert.equal(rateOnly.snapshot.windows[0].amounts?.currency, 'USD');
  assert.equal(rateOnly.snapshot.windows[0].resetAt, null);
  const subscription = state({ mode: 'unrestricted', isValid: true, unit: 'USD',
    subscription: { daily_usage_usd: 2, daily_limit_usd: 10, weekly_usage_usd: 5, weekly_limit_usd: 20,
      monthly_usage_usd: 0, monthly_limit_usd: null, weekly_window_start: '2026-09-01T00:00:00Z' },
  });
  assert.equal(subscription.kind, 'ready');
  if (subscription.kind !== 'ready') return;
  assert.deepEqual(subscription.snapshot.windows.map(w => [w.label, w.remainingPercent]), [['1d', 80], ['1w', 75]]);
});

test('malformed limits and unknown windows never become a made-up daily quota', () => {
  for (const payload of [
    {}, { mode: 'quota_limited', isValid: true, rate_limits: [{ window: '9h', limit: 10, used: 1, remaining: 9 }] },
    { mode: 'quota_limited', isValid: true, rate_limits: [{ window: '5h', limit: 0, used: 0, remaining: 0 }] },
    { mode: 'quota_limited', isValid: true, usage: { total: { actual_cost: 10 } } },
    { mode: 'unrestricted', isValid: true, unit: 'USD', subscription: { daily_limit_usd: 10 } },
  ]) assert.throws(() => parseSub2ApiUsage(payload), QuotaError);
});

test('adapter uses the selected provider auth and derived URL, never returns credentials', async () => {
  const result = await createSub2ApiAdapter('gateway').query(context({
    getAuth: async provider => {
      assert.equal(provider, 'gateway');
      return { apiKey: 'OLD', baseUrl: 'https://host.test/gateway/v1', headers: { authorization: 'Bearer SECRET' } };
    },
    getJson: async (url, headers) => {
      assert.equal(url, 'https://host.test/gateway/v1/usage');
      assert.deepEqual(headers, { Authorization: 'Bearer SECRET' });
      return wallet;
    },
  }));
  assert.equal(result.fetchedAt, now);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  await assert.rejects(createSub2ApiAdapter('gateway').query(context({
    getAuth: async () => ({ apiKey: 'SECRET', baseUrl: 'https://user:pass@host.test/v1' }),
    getJson: async () => assert.fail('Must not send credentials'),
  })), QuotaError);
});

test('usage URL preserves subpath, accepts loopback, rejects unsafe origins and URL secrets', () => {
  assert.equal(sub2ApiUsageUrl('https://host.test/v1'), 'https://host.test/v1/usage');
  assert.equal(sub2ApiUsageUrl('https://host.test/gateway/v1/'), 'https://host.test/gateway/v1/usage');
  assert.equal(sub2ApiUsageUrl('http://127.0.0.1:3000/v1'), 'http://127.0.0.1:3000/v1/usage');
  for (const url of [undefined, 'http://remote.test/v1', 'https://user:pass@host.test/v1',
    'https://host.test/v1?x=secret', 'https://host.test/v1#secret']) {
    assert.throws(() => sub2ApiUsageUrl(url), QuotaError);
  }
});
