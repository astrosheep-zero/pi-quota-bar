import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleWidth } from '@earendil-works/pi-tui';
import { formatPercent, horizontalBar, remainingTone, renderBar, verticalBar } from '../src/bar/bar.ts';
import { quotaElement, renderFooter, renderUsage } from '../src/bar/quota.ts';
import type { QuotaState } from '../src/query/types.ts';

const now = Date.parse('2026-09-07T04:00:00Z');
const state: QuotaState = { kind: 'ready', provider: 'openai-codex', label: 'Codex', snapshot: {
  fetchedAt: now, windows: [
    { id: '5h', label: '5h', durationSeconds: 18000, remainingPercent: 72, resetAt: now + 8100000 },
    { id: 'weekly', label: '1w', durationSeconds: 604800, remainingPercent: 85, resetAt: now + 442800000 },
  ],
} };

test('exact requested footer: English, brackets, arrow spacing, no provider/remaining, trailing space', () => {
  const text = renderFooter(state, undefined, now);
  assert.equal(text, '5h [▆] 72% ↺ 2h15m · 1w [▇] 85% ↺ 5d3h ');
  assert.ok(text.endsWith(' '));
  assert.equal(text.includes('Codex'), false);
  assert.equal(text.includes('Remaining'), false);
});

test('/usage uses horizontal bars and includes provider and meaning', () => {
  const lines = renderUsage(state, undefined, now);
  assert.equal(lines[0], 'Codex · Remaining quota');
  assert.equal(lines[2], '5h  [██████████████░░░░░░]  72% ↺ 2h15m');
  assert.equal(lines[3], '1w  [█████████████████░░░]  85% ↺ 5d3h');
  assert.equal(lines.length, 4);
});

test('detail columns align for long labels, wide characters, decimals and unknown values', () => {
  const labels = ['1w', 'gpt-reserve/1w', '界/5h', 'other/1w'];
  const values = [100, 8, 99.9, null];
  const varied: QuotaState = { ...state, snapshot: { ...state.snapshot,
    windows: labels.map((label, i) => ({ ...state.snapshot.windows[0],
      id: String(i), label, remainingPercent: values[i],
    })),
  } };
  const lines = renderUsage(varied, undefined, now).slice(2);
  for (const marker of ['[', ']', '↺']) {
    const columns = lines.map(line => visibleWidth(line.slice(0, line.indexOf(marker))));
    assert.equal(new Set(columns).size, 1, `${marker} column must align`);
  }
  assert.ok(lines[0].includes('  100% ↺ '));
  assert.ok(lines[1].includes('    8% ↺ '));
  assert.equal(renderUsage(varied, undefined, now).length, 6);
});

test('bar and percent use colors; labels and reset times remain dim', () => {
  const calls: [string, string][] = [];
  renderFooter(state, (tone, text) => { calls.push([tone, text]); return text; }, now);
  assert.ok(calls.some(([tone, text]) => tone === 'success' && text === '[▆] 72%'));
  assert.ok(calls.some(([tone, text]) => tone === 'dim' && text === ' ↺ 2h15m'));
  assert.equal(remainingTone(30.1), 'success');
  assert.equal(remainingTone(30), 'warning');
  assert.equal(remainingTone(10), 'error');
  assert.equal(remainingTone(null), 'dim');
});

test('unknown, empty and full are distinct; rounding cannot suggest false empty/full', () => {
  assert.equal(verticalBar(null), '[?]');
  assert.equal(verticalBar(0), '[·]');
  assert.equal(verticalBar(1), '[▁]');
  assert.equal(verticalBar(100), '[█]');
  assert.notEqual(verticalBar(99.99), '[█]');
  assert.equal(formatPercent(0.01), '0.1%');
  assert.equal(formatPercent(99.99), '99.9%');
  assert.equal(formatPercent(null), '?');
  assert.equal(horizontalBar(0, 5), '[░░░░░]');
  assert.equal(horizontalBar(100, 5), '[█████]');
  assert.notEqual(horizontalBar(99.99, 5), '[█████]');
});

test('expired reset becomes unknown/due, never fabricates 100%', () => {
  const text = renderFooter(state, undefined, now + 8100001);
  assert.ok(text.includes('5h [?] ? ↺ due'));
  assert.equal(text.includes('100%'), false);
});

test('hidden/loading/error do not masquerade as measured zero', () => {
  assert.equal(renderFooter({ kind: 'hidden' }), '');
  assert.equal(renderFooter({ kind: 'loading', provider: 'a', label: 'A' }), 'Quota … ');
  const text = renderFooter({ kind: 'error', provider: 'a', label: 'A', code: 'timeout' });
  assert.equal(text, 'Quota ! Request timed out ');
  assert.equal(text.includes('0%'), false);
});

test('quota composes as one element of a larger bar, independently of query implementation', () => {
  assert.equal(renderBar([
    { id: 'context', spans: [{ text: 'ctx [▃] 32%' }] },
    quotaElement(state, now),
    { id: 'git', spans: [{ text: 'main' }] },
  ]), 'ctx [▃] 32% │ 5h [▆] 72% ↺ 2h15m · 1w [▇] 85% ↺ 5d3h │ main ');
});

test('footer bounds window count, details retain model-specific windows', () => {
  const extra: QuotaState = { ...state, snapshot: { ...state.snapshot, windows: [
    ...state.snapshot.windows,
    { ...state.snapshot.windows[0], id: 'model', scope: 'GPT-X', remainingPercent: 5 },
  ] } };
  assert.ok(renderFooter(extra, undefined, now).endsWith(' +1 '));
  assert.ok(renderUsage(extra, undefined, now).some(line => line.startsWith('GPT-X/5h ')));
});
