import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaController } from '../src/query/controller.ts';
import { AdapterRegistry } from '../src/query/registry.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QuotaAdapter, QuotaSnapshot, QuotaState } from '../src/query/types.ts';

const snapshot = (remainingPercent = 72): QuotaSnapshot => ({ fetchedAt: 100000,
  windows: [{ id: '5h', label: '5h', remainingPercent, resetAt: null, durationSeconds: 18000 }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const auth = async () => ({ apiKey: 'secret' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(adapters: QuotaAdapter[], extra: { now?: () => number; timeoutMs?: number } = {}) {
  const states: QuotaState[] = [];
  const controller = new QuotaController({ registry: new AdapterRegistry(adapters),
    getJson: async () => ({}), onState: state => states.push(state), ...extra });
  return { controller, states };
}

test('switch clears old values synchronously; slow old success cannot overwrite new provider', async () => {
  const slow = deferred<QuotaSnapshot>();
  let oldSignal: AbortSignal | undefined;
  const { controller } = setup([
    { provider: 'a', label: 'A', query: ctx => { oldSignal = ctx.signal; return slow.promise; } },
    { provider: 'b', label: 'B', query: async () => snapshot(85) },
  ]);
  controller.select('a');
  const old = controller.refresh(auth);
  await flush();
  controller.select('b');
  assert.deepEqual(controller.state, { kind: 'loading', provider: 'b', label: 'B' });
  assert.equal(oldSignal?.aborted, true);
  await controller.refresh(auth);
  slow.resolve(snapshot(1));
  await old;
  assert.equal(controller.state.kind, 'ready');
  if (controller.state.kind === 'ready') {
    assert.equal(controller.state.provider, 'b');
    assert.equal(controller.state.snapshot.windows[0].remainingPercent, 85);
  }
});

test('old rejection after switch/stop is ignored and handled', async () => {
  const slow = deferred<QuotaSnapshot>();
  const { controller, states } = setup([{ provider: 'a', label: 'A', query: () => slow.promise }]);
  controller.select('a');
  const pending = controller.refresh(auth);
  await flush();
  controller.stop();
  const count = states.length;
  slow.reject(new Error('secret'));
  await pending;
  assert.deepEqual(controller.state, { kind: 'hidden' });
  assert.equal(states.length, count);
});

test('coalesces concurrent refreshes, throttles turns, and allows manual refresh', async () => {
  let clock = 100000;
  let calls = 0;
  const { controller } = setup([{ provider: 'a', label: 'A', query: async () => {
    calls++; return snapshot();
  } }], { now: () => clock });
  controller.select('a');
  const first = controller.refresh(auth);
  assert.equal(controller.refresh(auth), first);
  await first;
  await controller.refresh(auth);
  assert.equal(calls, 1);
  clock += 60000;
  await controller.refresh(auth);
  assert.equal(calls, 2);
  await controller.refresh(auth, true);
  assert.equal(calls, 3);
});

test('manual refresh supersedes a hanging request instead of reporting false success', async () => {
  const slow = deferred<QuotaSnapshot>();
  let calls = 0;
  const { controller } = setup([{ provider: 'a', label: 'A', query: async () => {
    return ++calls === 1 ? slow.promise : snapshot(91);
  } }]);
  controller.select('a');
  const old = controller.refresh(auth);
  await flush();
  await controller.refresh(auth, true);
  await old;
  assert.equal(calls, 2);
  slow.resolve(snapshot(2));
  await flush();
  assert.equal(controller.state.kind, 'ready');
  if (controller.state.kind === 'ready') assert.equal(controller.state.snapshot.windows[0].remainingPercent, 91);
});

test('timeout also bounds non-cooperative auth/adapters', async () => {
  const { controller } = setup([{ provider: 'a', label: 'A', query: () => new Promise(() => {}) }], { timeoutMs: 10 });
  controller.select('a');
  await controller.refresh(auth);
  assert.deepEqual(controller.state, { kind: 'error', provider: 'a', label: 'A', code: 'timeout' });
});

test('error drops stale values, redacts arbitrary exceptions, and backs off', async () => {
  let clock = 100000;
  let fail = false;
  let calls = 0;
  const { controller } = setup([{ provider: 'a', label: 'A', query: async () => {
    calls++;
    if (fail) throw new Error('Bearer TOP-SECRET');
    return snapshot();
  } }], { now: () => clock });
  controller.select('a');
  await controller.refresh(auth);
  fail = true;
  await controller.refresh(auth, true);
  assert.deepEqual(controller.state, { kind: 'error', provider: 'a', label: 'A', code: 'network' });
  await controller.refresh(auth);
  assert.equal(calls, 2);
  clock += 60000;
  await controller.refresh(auth);
  assert.equal(calls, 3);
  clock += 60000;
  await controller.refresh(auth);
  assert.equal(calls, 3); // second error -> 120-second backoff
});

test('honors Retry-After; unsupported provider has no queries', async () => {
  let clock = 100000;
  let calls = 0;
  const { controller } = setup([{ provider: 'a', label: 'A', query: async () => {
    calls++;
    throw new QuotaError('rate-limit', 300000);
  } }], { now: () => clock });
  controller.select('unsupported');
  await controller.refresh(auth);
  assert.equal(calls, 0);
  controller.select('a');
  await controller.refresh(auth);
  clock += 60000;
  await controller.refresh(auth);
  assert.equal(calls, 1);
  clock += 240000;
  await controller.refresh(auth);
  assert.equal(calls, 2);
});

test('reselecting same provider clears cache, permits account changes and validates custom data', async () => {
  let calls = 0;
  const { controller } = setup([{ provider: 'a', label: 'A', query: async () => {
    return ++calls === 1 ? snapshot() : { fetchedAt: 0, windows: [] };
  } }]);
  controller.select('a');
  await controller.refresh(auth);
  controller.select('a');
  assert.equal(controller.state.kind, 'loading');
  await controller.refresh(auth);
  assert.deepEqual(controller.state, { kind: 'error', provider: 'a', label: 'A', code: 'schema' });
});
