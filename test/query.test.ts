import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexAccountId, codexAdapter, parseCodex } from '../src/query/codex.ts';
import { kimiAdapter, parseKimi } from '../src/query/kimi.ts';
import { createJsonClient } from '../src/query/http.ts';
import { AdapterRegistry, validateSnapshot } from '../src/query/registry.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QueryContext } from '../src/query/types.ts';

const now = Date.parse('2026-09-07T04:00:00Z');
const jwt = (id: string) => `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: id },
})).toString('base64url')}.signature`;
const codexPayload = { rate_limit: {
  primary_window: { used_percent: 28, limit_window_seconds: 18000, reset_at: now / 1000 + 8100 },
  secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 442800 },
} };
const kimiPayload = {
  usage: { limit: '100', used: '15', resetTime: new Date(now + 442800000).toISOString() },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { limit: '100', remaining: '72', resetTime: new Date(now + 8100000).toISOString() } }],
};
const context = (overrides: Partial<QueryContext> = {}): QueryContext => ({
  provider: 'kimi-coding', signal: new AbortController().signal, now: () => now,
  getAuth: async () => ({ apiKey: 'secret' }), getJson: async () => kimiPayload,
  ...overrides,
});

test('Codex parses shared windows, timestamp units and model domains independently', () => {
  const windows = parseCodex({ ...codexPayload, additional_rate_limits: [{
    limit_name: 'GPT-X', rate_limit: { primary_window: {
      remaining_percent: 40, limit_window_seconds: 3600, reset_time_ms: now + 100000,
    } },
  }] }, now);
  assert.deepEqual(windows.map(w => [w.label, w.remainingPercent]), [['5h', 72], ['1w', 85], ['1h', 40]]);
  assert.equal(windows[0].resetAt, now + 8100000);
  assert.equal(windows[1].resetAt, now + 442800000);
  assert.equal(windows[2].scope, 'GPT-X');
  assert.equal(windows[2].resetAt, now + 100000);
});

test('Codex absent percentages are unknown, malformed payloads do not imply 100%', () => {
  assert.equal(parseCodex({ rate_limit: { primary_window: {} } }, now)[0].remainingPercent, null);
  for (const payload of [null, {}, { error: 'denied' }, { credits: { balance: 99 } }]) {
    assert.throws(() => parseCodex(payload, now), QuotaError);
  }
  assert.equal(parseCodex({ rate_limit: { primary_window: { used_percent: 150 } } }, now)[0].remainingPercent, 0);
});

test('Kimi supports string counts, remaining-only counts, all durations and sort order', () => {
  const windows = parseKimi({ ...kimiPayload, limits: [...kimiPayload.limits,
    { window: { duration: '1', timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 50, used: 50 } },
  ] });
  assert.deepEqual(windows.map(w => [w.label, w.remainingPercent]), [['1h', 0], ['5h', 72], ['1w', 85]]);
  assert.equal(windows[1].resetAt, now + 8100000);
});

test('Kimi missing or invalid counts and reset timestamps stay unknown', () => {
  for (const usage of [{ limit: 100 }, { limit: 0, used: 0 }, { limit: true, used: 0 },
    { limit: 100, used: '' }, { limit: 100, used: null }, { limit: 100, used: -1 }]) {
    const window = parseKimi({ usage })[0];
    assert.equal(window.remainingPercent, null);
    assert.equal(window.resetAt, null);
  }
  assert.equal(parseKimi({ usage: { limit: 100, used: 0 } })[0].remainingPercent, 100);
  assert.throws(() => parseKimi({}), QuotaError);
});

test('Codex account is derived from the same runtime token, not another auth file', async () => {
  assert.equal(codexAccountId(jwt('account-A')), 'account-A');
  assert.equal(codexAccountId('sk-api-key'), undefined);
  let requested = false;
  await codexAdapter.query(context({ provider: 'openai-codex',
    getAuth: async () => ({ apiKey: jwt('account-A') }),
    getJson: async (url, headers) => {
      requested = true;
      assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
      assert.equal(headers['ChatGPT-Account-Id'], 'account-A');
      return codexPayload;
    },
  }));
  assert.equal(requested, true);
});

test('runtime Authorization and account headers take precedence', async () => {
  await codexAdapter.query(context({ provider: 'openai-codex', getAuth: async () => ({
    apiKey: jwt('old'), headers: { authorization: `Bearer ${jwt('new')}`, 'chatgpt-account-id': 'selected' },
  }), getJson: async (_url, headers) => {
    assert.equal(headers.Authorization, `Bearer ${jwt('new')}`);
    assert.equal(headers['ChatGPT-Account-Id'], 'selected');
    return codexPayload;
  } }));
});

test('Kimi uses the official endpoint and its own resolved credentials', async () => {
  const result = await kimiAdapter.query(context({ getAuth: async provider => {
    assert.equal(provider, 'kimi-coding');
    return { apiKey: 'kimi-secret', baseUrl: 'https://api.kimi.com/coding' };
  }, getJson: async (url, headers) => {
    assert.equal(url, 'https://api.kimi.com/coding/v1/usages');
    assert.equal(headers.Authorization, 'Bearer kimi-secret');
    return kimiPayload;
  } }));
  assert.equal(result.fetchedAt, now);
});

test('custom origins, missing auth and non-Codex API keys fail before HTTP', async () => {
  const getJson = async () => { assert.fail('Must not send credentials'); };
  for (const auth of [undefined, { apiKey: 'secret', baseUrl: 'https://proxy.invalid' },
    { apiKey: 'secret', baseUrl: 'https://user@api.kimi.com/coding' }]) {
    await assert.rejects(kimiAdapter.query(context({ getAuth: async () => auth, getJson })), QuotaError);
  }
  await assert.rejects(codexAdapter.query(context({ provider: 'openai-codex', getJson })), QuotaError);
});

test('HTTP requests are GET-only, abort-aware and do not follow redirects', async () => {
  const signal = new AbortController().signal;
  const client = createJsonClient((async (_url, init) => {
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.signal, signal);
    return new Response('{"ok":true}');
  }) as typeof fetch);
  assert.deepEqual(await client('https://example.test', {}, signal), { ok: true });
});

test('HTTP errors redact response bodies, support Retry-After, and reject oversized JSON', async () => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [500, 'http']] as const) {
    const client = createJsonClient((async () => new Response('SECRET-BODY', {
      status, headers: { 'retry-after': '120' },
    })) as typeof fetch);
    await assert.rejects(client('https://example.test', {}, new AbortController().signal), error => {
      assert.ok(error instanceof QuotaError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes('SECRET'), false);
      if (status === 429) assert.equal(error.retryAfterMs, 120000);
      return true;
    });
  }
  for (const body of ['<html>secret</html>', 'x'.repeat(300000)]) {
    const client = createJsonClient((async () => new Response(body)) as typeof fetch);
    await assert.rejects(client('https://example.test', {}, new AbortController().signal), QuotaError);
  }
});

test('custom adapters register explicitly; output is validated and labels sanitized', () => {
  const adapter = { provider: 'custom', label: 'Custom', query: async () => ({ windows: [], fetchedAt: now }) };
  const registry = new AdapterRegistry([adapter]);
  assert.equal(registry.get('custom')?.provider, 'custom');
  assert.equal(registry.get('unregistered'), undefined);
  assert.throws(() => registry.register(adapter));
  assert.throws(() => validateSnapshot({ fetchedAt: now, windows: [] }), QuotaError);
  const window = parseKimi(kimiPayload)[0];
  assert.throws(() => validateSnapshot({ fetchedAt: now, windows: [{ ...window, remainingPercent: NaN }] }), QuotaError);
  assert.throws(() => validateSnapshot({ fetchedAt: now, windows: [window, window] }), QuotaError);
  assert.equal(validateSnapshot({ fetchedAt: now, windows: [{ ...window, label: '5h\n\x1b' }] }).windows[0].label, '5h');
});
