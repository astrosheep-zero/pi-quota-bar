import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createQuotaExtension, SPINNER_INTERVAL_MS } from '../src/extension.ts';
import type { FooterWindows } from '../src/bar/quota.ts';
import { USAGE_ENTRY, usageCardComponent } from '../src/bar/card.ts';
import type { UsageCard } from '../src/bar/card.ts';
import { createNewApiAdapter } from '../src/query/new-api.ts';
import type { QuotaAdapter } from '../src/query/types.ts';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(mode = 'tui', adapters: QuotaAdapter[] = [], footerWindows?: FooterWindows) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const statuses: (string | undefined)[] = [];
  const emitted: unknown[] = [];
  const entries: { type: string; data: UsageCard }[] = [];
  const renderers = new Map<string, unknown>();
  const widgets: unknown[] = [];
  let requests = 0;
  let lastUrl = '';
  const originalFetch = globalThis.fetch;
  let respond: (url: string) => Promise<Response> = async () => new Response(JSON.stringify({
    usage: { limit: 100, used: 15, resetTime: '2099-01-01T00:00:00Z' },
    limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 28 } }],
  }));
  globalThis.fetch = async (input: unknown) => { requests++; lastUrl = String(input); return respond(lastUrl); };
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    events: { emit: (_name: string, state: unknown) => emitted.push(state) },
    registerEntryRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
    appendEntry: (type: string, data: UsageCard) => entries.push({ type, data }),
    sendMessage: () => assert.fail('Quota cards must not enter model context'),
  } as unknown as ExtensionAPI;
  const ui = {
    theme: { fg: (_tone: string, text: string) => text },
    setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    notify: () => {},
    setWidget: (_key: string, content: unknown) => { widgets.push(content); },
    custom: async (): Promise<void> => { assert.fail('No modal or input replacement allowed'); },
  };
  const ctx = {
    mode, hasUI: mode === 'tui' || mode === 'rpc', model: { provider: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding' },
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: 'TEST-SECRET' } }),
      getAll: () => ctx.model ? [ctx.model] : [],
    }, ui,
  } as unknown as ExtensionContext;
  createQuotaExtension({ adapters, footerWindows })(pi);
  return {
    ctx, ui, statuses, commands, emitted, entries, renderers, widgets,
    requests: () => requests,
    lastUrl: () => lastUrl,
    respondWith: (responder: (url: string) => Promise<Response>) => { respond = responder; },
    emit: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
    cleanup: () => {
      handlers.get('session_shutdown')?.({}, ctx);
      globalThis.fetch = originalFetch;
    },
  };
}

test('factory is idle; session start queries current provider and shutdown clears status', async t => {
  const h = harness();
  t.after(h.cleanup);
  assert.equal(h.requests(), 0);
  h.emit('session_start');
  assert.equal(h.statuses.at(-1), 'Quota … ');
  await tick();
  assert.equal(h.requests(), 1);
  assert.match(h.statuses.at(-1) ?? '', /^5h \[▆\] 72% ↺ \? · 1w \[▇\] 85%/);
  assert.equal(JSON.stringify(h.emitted).includes('TEST-SECRET'), false);
  h.emit('session_shutdown');
  assert.equal(h.statuses.at(-1), undefined);
});

test('model select hides unsupported quota immediately; turn end is throttled', async t => {
  const h = harness();
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  h.emit('turn_end');
  await tick();
  assert.equal(h.requests(), 1);
  h.emit('model_select', { model: { provider: 'not-supported' } });
  assert.equal(h.statuses.at(-1), undefined);
});

test('an explicit adapter overrides a matching built-in provider', async t => {
  const adapter: QuotaAdapter = {
    provider: 'deepseek', label: 'Configured DeepSeek',
    async query({ now }) {
      return { fetchedAt: now(), windows: [], balance: { currency: 'CNY', remaining: 88 } };
    },
  };
  const h = harness('tui', [adapter]);
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  await h.commands.get('usage')!.handler('', h.ctx);
  const text = usageCardComponent(h.entries[0]!.data).render(100).join('\n');
  assert.ok(text.includes('Configured DeepSeek'), text);
  assert.ok(text.includes('¥88.00'));
});

test('footerWindows: "all" shows every window of the current provider', async t => {
  const h = harness('tui', [], 'all');
  t.after(h.cleanup);
  h.respondWith(async () => new Response(JSON.stringify({
    usage: { limit: 100, used: 15, resetTime: '2099-01-01T00:00:00Z' },
    limits: [
      { window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 28 } },
      { window: { duration: 30, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: 100, used: 42 } },
    ],
  })));
  h.emit('session_start');
  await tick();
  const footer = h.statuses.at(-1) ?? '';
  assert.ok(footer.includes('5h ') && footer.includes('1w ') && footer.includes('30d '), footer);
  assert.equal(footer.includes('+'), false);
});

test('noninteractive mode never queries or starts visible status work', async t => {
  const h = harness('print');
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  assert.equal(h.requests(), 0);
  assert.equal(h.statuses.length, 0);
});

test('/usage appends durable horizontal-bar items without opening UI or sending model messages', async t => {
  const h = harness();
  t.after(h.cleanup);
  assert.ok(h.renderers.has(USAGE_ENTRY));
  h.emit('session_start');
  await tick();
  assert.equal(h.entries.length, 0); // automatic footer polling does not fill chat history
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].type, USAGE_ENTRY);
  assert.equal(JSON.stringify(h.entries).includes('TEST-SECRET'), false);
  const card = usageCardComponent(h.entries[0].data);
  const lines = card.render(80);
  assert.ok(lines.some(line => line.includes('Kimi')));
  assert.ok(lines.some(line => /\[█+░+\]\s+72%/.test(line)), lines.join('\n'));
  assert.ok(lines.every(line => !/Snapshot |Updated |Time until reset|Run \/usage/.test(line)));
  for (const width of [0, 1, 10, 30, 50, 80]) {
    assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
  }
  const original = JSON.stringify(h.entries[0]);
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 2);
  assert.equal(JSON.stringify(h.entries[0]), original);
  // Session persistence round trip: renderer does not need live controller state.
  assert.deepEqual(usageCardComponent(JSON.parse(original).data).render(80), lines);
});

test('/usage shows successful quota providers and --all reveals query errors', async t => {
  const adapter: QuotaAdapter = {
    provider: 'my-gateway', label: 'Gateway',
    async query({ now }) {
      return { fetchedAt: now(), windows: [], balance: { currency: 'USD', remaining: 12.34 } };
    },
  };
  const h = harness('tui', [adapter]);
  t.after(h.cleanup);
  const registry = h.ctx.modelRegistry as unknown as { getAll: () => unknown[] };
  registry.getAll = () => [
    h.ctx.model,
    { provider: 'my-gateway', id: 'gateway-model' },
    { provider: 'codex-for', id: 'codex-for-model' },
    { provider: 'unsupported', id: 'unsupported-model' },
  ];
  h.emit('session_start');
  await tick();
  const footer = h.statuses.at(-1);
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.version, 2);
  const card = usageCardComponent(h.entries[0].data);
  const lines = card.render(100);
  const text = lines.join('\n');
  assert.ok(text.includes('Kimi'));
  assert.ok(text.includes('Gateway'));
  assert.ok(text.includes('$12.34'));
  assert.equal(text.includes('DeepSeek'), false);
  assert.equal(text.includes('Unsupported credentials or endpoint'), false);
  assert.equal(text.includes('codex-for'), false);
  assert.equal(text.includes('unsupported'), false);
  for (const width of [0, 1, 10, 30, 50, 100]) {
    assert.ok(card.render(width).every(line => visibleWidth(line) <= width));
  }
  assert.equal(h.statuses.at(-1), footer); // aggregate view must not hijack the current-provider footer
  await h.commands.get('usage')!.handler('--all', h.ctx);
  const diagnostic = usageCardComponent(h.entries[1].data).render(100).join('\n');
  assert.ok(diagnostic.includes('DeepSeek'));
  assert.ok(diagnostic.includes('Unsupported credentials or endpoint'));
  assert.equal(diagnostic.includes('codex-for'), false);
});

test('/usage pins the current provider first and marks it with a star', async t => {
  const adapter: QuotaAdapter = {
    provider: 'my-gateway', label: 'Gateway',
    async query({ now }) {
      return { fetchedAt: now(), windows: [
        { id: '1w', label: '1w', remainingPercent: 50, resetAt: now() + 3_600_000, durationSeconds: 604800 },
      ] };
    },
  };
  const h = harness('tui', [adapter]);
  t.after(h.cleanup);
  const registry = h.ctx.modelRegistry as unknown as { getAll: () => unknown[] };
  registry.getAll = () => [h.ctx.model, { provider: 'my-gateway', id: 'gateway-model' }];
  h.emit('session_start');
  await tick();
  // The current provider degrades to an error while the gateway stays healthy:
  // rank ordering alone would bury it under the gateway and the other errors.
  h.respondWith(async () => new Response('{}'));
  await h.commands.get('usage')!.handler('--all', h.ctx);
  const card = usageCardComponent(h.entries[0].data);
  const lines = card.render(100);
  const first = lines.find(line => line.trim().length > 0)!;
  assert.ok(first.startsWith('★ Kimi'), lines.join('\n'));
  assert.ok(first.includes('Unrecognized quota response'), first);
  assert.ok(lines.findIndex(line => line.includes('Gateway')) > 0);
  // The marker survives the session persistence round trip.
  const restored = usageCardComponent(JSON.parse(JSON.stringify(h.entries[0])).data);
  assert.ok(restored.render(100).some(line => line.startsWith('★ Kimi')));
});

for (const event of ['session_shutdown', 'model_select']) {
  test(`/usage does not append after ${event} during a query`, async t => {
    const h = harness();
    t.after(h.cleanup);
    h.emit('session_start');
    await tick();
    let resolve!: (response: Response) => void;
    h.respondWith(async () => new Promise<Response>(yes => { resolve = yes; }));
    const command = h.commands.get('usage')!.handler('', h.ctx);
    await tick();
    h.emit(event, { model: { provider: 'unsupported' } });
    await command;
    assert.equal(h.entries.length, 0);
    resolve(new Response('{}'));
    await tick();
    assert.equal(h.entries.length, 0);
  });
}

test('new-api works through Pi auth, controller, footer and persistent /usage item', async t => {
  const h = harness('tui', [createNewApiAdapter('my-gateway')]);
  t.after(h.cleanup);
  const model = h.ctx.model! as { provider: string; baseUrl: string };
  model.provider = 'my-gateway';
  model.baseUrl = 'https://gateway.test/v1';
  h.respondWith(async () => new Response(JSON.stringify(h.lastUrl().endsWith('/subscription')
    ? { object: 'billing_subscription', hard_limit_usd: 69.12 }
    : { object: 'list', total_usage: 5678 })));
  h.emit('session_start');
  await tick();
  assert.equal(h.statuses.at(-1), 'Bal $12.34 ');
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  assert.deepEqual(usageCardComponent(h.entries[0].data).render(100).map(line => line.trimEnd()), [
    '★ my-gateway  $12.34', // current provider leads and carries the star
  ]);
});

test('/usage resolves a non-selected provider endpoint from its registered model', async t => {
  const h = harness('tui', [createNewApiAdapter('micu-ant')]);
  t.after(h.cleanup);
  const registry = h.ctx.modelRegistry as unknown as { getAll: () => unknown[] };
  registry.getAll = () => [h.ctx.model, {
    provider: 'micu-ant', id: 'claude-test', baseUrl: 'https://gateway.test/v1',
  }];
  const urls: string[] = [];
  h.respondWith(async url => {
    urls.push(url);
    return new Response(JSON.stringify(url.endsWith('/subscription')
      ? { hard_limit_usd: 69.12 } : { total_usage: 5678 }));
  });
  h.emit('session_start');
  await tick();
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.ok(urls.includes('https://gateway.test/v1/dashboard/billing/subscription'));
  assert.ok(usageCardComponent(h.entries[0]!.data).render(100).join('\n').includes('micu-ant'));
});

test('when all queries fail, /usage is compact and --all shows honest errors', async t => {
  const h = harness();
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  h.respondWith(async () => new Response('SECRET', { status: 401 }));
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  const entry = h.entries[0].data;
  assert.equal(entry.version, 2);
  if (entry.version !== 2) assert.fail('expected aggregate card');
  assert.deepEqual(entry.states, []);
  assert.ok(usageCardComponent(entry).render(80).join('\n').includes('No quota data available'));
  await h.commands.get('usage')!.handler('--all', h.ctx);
  const text = usageCardComponent(h.entries[1].data).render(80).join('\n');
  assert.ok(text.includes('Sign in with /login'));
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('0%'), false);
});

test('/usage spinner never duplicates the previous transcript card during refresh', async t => {
  const h = harness();
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  await tick();
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  const originalEntry = JSON.stringify(h.entries[0]);
  const renderWidget = (factory: unknown, width = 100): string[] => {
    assert.equal(typeof factory, 'function');
    return (factory as (tui: unknown, theme: { fg: (tone: string, text: string) => string }) => { render: (width: number) => string[] })({}, { fg: (_tone, text) => text }).render(width);
  };
  const firstLines = renderWidget(h.widgets[1]);
  assert.equal(firstLines.length, 1);
  assert.ok(firstLines.at(-1)!.includes('Fetching quota…'));
  assert.ok(/^\p{Other_Symbol}|^\S/u.test(firstLines.at(-1)!));
  assert.equal(firstLines.some(line => line.includes('Kimi')), false, 'first run has no previous grid');

  let resolve!: (response: Response) => void;
  h.respondWith(async url => url.startsWith('https://api.kimi.com/')
    ? new Promise<Response>(yes => { resolve = yes; })
    : new Response('', { status: 401 }));
  const pending = h.commands.get('usage')!.handler('', h.ctx);
  await tick();
  const lines = renderWidget(h.widgets.at(-1));
  assert.equal(lines.length, 1, 'loading widget contains only the spinner');
  assert.ok(lines[0].includes('Refreshing…'));
  assert.deepEqual(renderWidget(h.widgets.at(-1), 0), []);
  assert.equal(h.entries.length, 1, 'no new snapshot until the query completes');
  assert.equal(JSON.stringify(h.entries[0]), originalEntry, 'previous snapshot remains intact');
  const screen = [...usageCardComponent(h.entries[0].data).render(100), ...lines];
  assert.equal(screen.filter(line => line.includes('Kimi')).length, 1, 'previous grid is displayed only once');
  assert.ok(lines.every(line => visibleWidth(line) <= 100));

  await new Promise(done => setTimeout(done, SPINNER_INTERVAL_MS * 2 + 40));
  const animated = renderWidget(h.widgets.at(-1));
  assert.notEqual(animated.at(-1), lines.at(-1), 'spinner frame advances while waiting');

  resolve(new Response(JSON.stringify({
    usage: { limit: 100, used: 15, resetTime: '2099-01-01T00:00:00Z' },
    limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 28 } }],
  })));
  await pending;
  await tick();
  assert.equal(h.entries.length, 2);
  assert.ok(usageCardComponent(h.entries[1].data).render(100).some(line => line.includes('Kimi')));
  assert.equal(h.widgets.at(-1), undefined); // widget cleared after the refresh lands
});
