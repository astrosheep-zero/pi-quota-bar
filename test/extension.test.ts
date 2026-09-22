import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createQuotaExtension } from '../src/extension.ts';
import { USAGE_ENTRY, usageCardComponent } from '../src/bar/card.ts';
import type { UsageCard } from '../src/bar/card.ts';
import { createNewApiAdapter } from '../src/query/new-api.ts';
import type { QuotaAdapter } from '../src/query/types.ts';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(mode = 'tui', adapters: QuotaAdapter[] = []) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const statuses: (string | undefined)[] = [];
  const emitted: unknown[] = [];
  const entries: { type: string; data: UsageCard }[] = [];
  const renderers = new Map<string, unknown>();
  let requests = 0;
  let lastUrl = '';
  const originalFetch = globalThis.fetch;
  let respond: () => Promise<Response> = async () => new Response(JSON.stringify({
    usage: { limit: 100, used: 15, resetTime: '2099-01-01T00:00:00Z' },
    limits: [{ window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' }, detail: { limit: 100, used: 28 } }],
  }));
  globalThis.fetch = async (input: unknown) => { requests++; lastUrl = String(input); return respond(); };
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
    setWidget: () => {},
    custom: async (): Promise<void> => { assert.fail('No modal or input replacement allowed'); },
  };
  const ctx = {
    mode, hasUI: mode === 'tui' || mode === 'rpc', model: { provider: 'kimi-coding', baseUrl: 'https://api.kimi.com/coding' },
    modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: 'TEST-SECRET' } }) }, ui,
  } as unknown as ExtensionContext;
  createQuotaExtension({ adapters })(pi);
  return {
    ctx, ui, statuses, commands, emitted, entries, renderers,
    requests: () => requests,
    lastUrl: () => lastUrl,
    respondWith: (responder: () => Promise<Response>) => { respond = responder; },
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

test('noninteractive mode never queries or starts visible status work', async t => {
  const h = harness('print');
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  assert.equal(h.requests(), 0);
  assert.equal(h.statuses.length, 0);
});

test('/usage appends a durable horizontal-bar item without opening UI or sending model messages', async t => {
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
  assert.ok(lines.some(line => line.includes('Kimi · Remaining quota')));
  assert.ok(lines.some(line => line.includes('[██████████████░░░░░░]  72%')));
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
  assert.deepEqual(usageCardComponent(h.entries[0].data).render(80).map(line => line.trimEnd()), [
    'my-gateway · Balance', '', 'Balance   $12.34',
  ]);
});

test('a failed /usage query appends an honest error snapshot, not fake quota', async t => {
  const h = harness();
  t.after(h.cleanup);
  h.emit('session_start');
  await tick();
  h.respondWith(async () => new Response('SECRET', { status: 401 }));
  await h.commands.get('usage')!.handler('', h.ctx);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].data.state.kind, 'error');
  const text = usageCardComponent(h.entries[0].data).render(80).join('\n');
  assert.ok(text.includes('Sign in with /login'));
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('0%'), false);
});
