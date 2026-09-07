import { visibleWidth } from '@earendil-works/pi-tui';
import { duration, formatPercent, horizontalBar, plain, remainingTone, renderBar, verticalBar } from './bar.ts';
import type { BarElement, Paint, Span } from './bar.ts';
import { balanceLines, balanceSpans } from './balance.ts';
import type { QuotaErrorCode, QuotaState, QuotaWindow } from '../query/types.ts';

const errorText: Record<QuotaErrorCode, string> = {
  auth: 'Sign in with /login',
  'unsupported-auth': 'Unsupported credentials or endpoint',
  'account-access': 'Account quota access denied',
  network: 'Network error', timeout: 'Request timed out',
  'rate-limit': 'Rate limited', http: 'Service unavailable', schema: 'Unrecognized quota response',
};

function windowSpans(window: QuotaWindow, now: number): Span[] {
  const expired = window.resetAt !== null && window.resetAt <= now;
  // Reaching the reset deadline is not proof the provider granted a fresh quota.
  const remaining = expired ? null : window.remainingPercent;
  const glyph = verticalBar(remaining);
  return [
    { text: `${window.scope ? `${window.scope}/` : ''}${window.label} `, tone: 'dim' },
    { text: `${glyph} ${formatPercent(remaining)}`, tone: remainingTone(remaining) },
    { text: ` ↺ ${window.resetAt === null ? '?' : duration(window.resetAt - now)}`, tone: 'dim' },
  ];
}

export function quotaElement(state: QuotaState, now = Date.now()): BarElement {
  const element: BarElement = { id: 'quota', spans: [] };
  if (state.kind === 'hidden') return element;
  if (state.kind === 'loading') return { ...element, spans: [{ text: 'Quota …', tone: 'dim' }] };
  if (state.kind === 'error') return { ...element, spans: [{ text: `Quota ! ${errorText[state.code]}`, tone: 'warning' }] };
  const windows = state.snapshot.windows;
  const shared = windows.filter(window => !window.scope);
  const shown = (shared.length ? shared : windows).slice(0, 2);
  const spans: Span[] = state.snapshot.balance ? balanceSpans(state.snapshot.balance) : [];
  for (const window of shown) {
    if (spans.length) spans.push({ text: ' · ', tone: 'dim' });
    spans.push(...windowSpans(window, now));
  }
  if (windows.length > shown.length) spans.push({ text: ` +${windows.length - shown.length}`, tone: 'dim' });
  return { ...element, spans };
}

export function renderFooter(state: QuotaState, paint: Paint = plain, now = Date.now()): string {
  return renderBar([quotaElement(state, now)], paint);
}

export function renderUsage(state: QuotaState, paint: Paint = plain, now = Date.now(), barWidth = 20): string[] {
  if (state.kind === 'hidden') return ['No quota adapter for the current provider.'];
  const balanceOnly = state.kind === 'ready' && state.snapshot.balance && state.snapshot.windows.length === 0;
  const title = `${state.label} · ${balanceOnly ? 'Balance' : 'Remaining quota'}`;
  if (state.kind === 'loading') return [title, '', 'Loading…'];
  if (state.kind === 'error') return [title, '', errorText[state.code]];
  const rows = state.snapshot.windows.map(window => {
    const remaining = window.resetAt !== null && window.resetAt <= now ? null : window.remainingPercent;
    return {
      label: `${window.scope ? `${window.scope}/` : ''}${window.label}`,
      remaining,
      value: formatPercent(remaining),
      reset: window.resetAt === null ? '?' : duration(window.resetAt - now),
    };
  });
  const labelWidth = Math.max(0, ...rows.map(row => visibleWidth(row.label)));
  const valueWidth = Math.max(4, ...rows.map(row => visibleWidth(row.value)));
  const lines = [title, '', ...rows.map(row => {
    const label = row.label + ' '.repeat(labelWidth - visibleWidth(row.label));
    const value = ' '.repeat(valueWidth - visibleWidth(row.value)) + row.value;
    const tone = remainingTone(row.remaining);
    return paint('dim', `${label}  `)
      + paint(tone, `${horizontalBar(row.remaining, barWidth)} ${value}`)
      + paint('dim', ` ↺ ${row.reset}`);
  })];
  if (state.snapshot.balance) {
    if (rows.length) lines.push('');
    lines.push(...balanceLines(state.snapshot.balance, paint));
  }
  return lines;
}
