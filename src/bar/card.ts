import { Text, visibleWidth } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import { duration, formatPercent, horizontalBar, remainingTone } from './bar.ts';
import type { Paint, Tone } from './bar.ts';
import { money, remainingMoney } from './balance.ts';
import { renderUsage } from './quota.ts';
import type { QuotaErrorCode, QuotaState } from '../query/types.ts';

export const USAGE_ENTRY = 'quota-bar:usage:v1';

export type UsageCard =
  | { version: 1; capturedAt: number; state: Exclude<QuotaState, { kind: 'loading' }> }
  | { version: 2; capturedAt: number; states: Exclude<QuotaState, { kind: 'loading' }>[] };

export function captureUsage(state: QuotaState, now = Date.now()): UsageCard | undefined {
  if (state.kind === 'loading') return undefined;
  // Preserve v1 rendering for cards already saved in sessions.
  return { version: 1, capturedAt: now, state: structuredClone(state) };
}

export function captureAllUsage(states: readonly QuotaState[], now = Date.now()): UsageCard {
  return { version: 2, capturedAt: now, states: structuredClone(states.filter(
    (state): state is Exclude<QuotaState, { kind: 'loading' }> => state.kind !== 'loading',
  )) };
}

const errorText: Record<QuotaErrorCode, string> = {
  auth: 'Sign in with /login',
  'unsupported-auth': 'Unsupported credentials or endpoint',
  'account-access': 'Account quota access denied',
  network: 'Network error', timeout: 'Request timed out',
  'rate-limit': 'Rate limited', http: 'Service unavailable', schema: 'Unrecognized quota response',
};

interface UsageRow {
  group: number;
  kind: 'quota' | 'balance' | 'error';
  provider: string;
  metric: string;
  value: string;
  secondary: string;
  valueTone: Tone;
  metricTone: Tone;
  secondaryTone: Tone;
}

function padEndVisible(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

function padStartVisible(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleWidth(text))) + text;
}

function gridRows(states: readonly Exclude<QuotaState, { kind: 'loading' }>[], now: number, barWidth: number): UsageRow[] {
  const rows: UsageRow[] = [];
  states.forEach((state, group) => {
    if (state.kind === 'ready') {
      const windows = state.snapshot.windows;
      if (windows.length > 0) {
        windows.forEach((window, index) => {
          const expired = window.resetAt !== null && window.resetAt <= now;
          const remaining = expired ? null : window.remainingPercent;
          rows.push({
            group, kind: 'quota',
            provider: index === 0 ? state.label : '',
            metric: `${window.scope ? `${window.scope}/` : ''}${window.label}`,
            value: `${horizontalBar(remaining, barWidth)} ${padStartVisible(formatPercent(remaining), 4)}`,
            secondary: `↺ ${window.resetAt === null ? '?' : duration(window.resetAt - now)}`,
            valueTone: remainingTone(remaining), metricTone: 'dim', secondaryTone: 'dim',
          });
        });
        return;
      }
      if (state.snapshot.balance) {
        const balance = state.snapshot.balance;
        rows.push({
          group, kind: 'balance', provider: state.label, metric: '',
          value: remainingMoney(balance),
          secondary: state.snapshot.spend?.today !== undefined
            ? `today ${money(state.snapshot.spend.today, state.snapshot.spend.currency)}` : '',
          valueTone: !balance.unlimited && balance.remaining <= 0 ? 'error' : 'text',
          metricTone: 'dim', secondaryTone: 'dim',
        });
        return;
      }
      if (state.snapshot.allowance) {
        const allowance = state.snapshot.allowance;
        const remaining = Math.max(0, Math.min(100, allowance.remaining / allowance.limit * 100));
        rows.push({
          group, kind: 'balance', provider: state.label, metric: '',
          value: `${horizontalBar(remaining, barWidth)} ${formatPercent(remaining)}`,
          secondary: `${money(allowance.used, allowance.currency)} used`,
          valueTone: remainingTone(remaining), metricTone: 'dim', secondaryTone: 'dim',
        });
        return;
      }
    }
    if (state.kind === 'error') {
      rows.push({ group, kind: 'error', provider: state.label, metric: '', value: errorText[state.code], secondary: '',
        valueTone: 'warning', metricTone: 'dim', secondaryTone: 'dim' });
    }
  });
  return rows;
}

export function aggregateUsageLines(
  states: readonly Exclude<QuotaState, { kind: 'loading' }>[],
  paint: Paint = (_tone, text) => text,
  now = Date.now(),
  barWidth = 12,
): string[] {
  const rows = gridRows(states, now, barWidth);
  if (rows.length === 0) return ['No quota data available. Run /usage --all for details.'];
  const quotaRows = rows.filter(row => row.kind === 'quota');
  const otherRows = rows.filter(row => row.kind !== 'quota');
  const providerWidth = Math.max(...quotaRows.map(row => visibleWidth(row.provider)), ...otherRows.map(row => visibleWidth(row.provider)));
  const metricWidth = Math.max(0, ...quotaRows.map(row => visibleWidth(row.metric)));
  const quotaValueWidth = Math.max(0, ...quotaRows.map(row => visibleWidth(row.value)));
  const otherValueWidth = Math.max(0, ...otherRows.map(row => visibleWidth(row.value)));
  const result: string[] = [];
  let previousGroup: number | undefined;
  for (const row of rows) {
    if (previousGroup !== undefined && row.group !== previousGroup && (row.kind === 'quota' || rows.some(other => other.group === previousGroup && other.kind === 'quota'))) result.push('');
    previousGroup = row.group;
    const provider = padEndVisible(row.provider, providerWidth);
    const metric = row.kind === 'quota' ? padEndVisible(row.metric, metricWidth) : '';
    const value = padEndVisible(row.value, row.kind === 'quota' ? quotaValueWidth : otherValueWidth);
    const line = paint('text', provider)
      + (metric ? paint(row.metricTone, `  ${metric}`) : '')
      + paint(row.valueTone, `  ${value}`)
      + (row.secondary ? paint(row.secondaryTone, `  ${row.secondary}`) : '');
    result.push(line.replace(/\s+$/u, ''));
  }
  return result;
}

export function usageLines(card: UsageCard, paint?: Paint, barWidth = 12): string[] {
  if (card.version === 1) return renderUsage(card.state, paint, card.capturedAt, barWidth);
  return aggregateUsageLines(card.states, paint, card.capturedAt, barWidth);
}

export function usageCardComponent(card: UsageCard | undefined, paint?: Paint): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      if (!card || (card.version !== 1 && card.version !== 2) || !Number.isFinite(card.capturedAt)) {
        return new Text('Usage snapshot unavailable.', 0, 0).render(width);
      }
      // Rebuild on every render for theme/width changes, but freeze time at capture.
      const lines = usageLines(card, paint, width < 55 ? 6 : 12);
      // Wrapping, not clipping: long quota names remain readable in narrow terminals.
      return new Text(lines.join('\n'), 0, 0).render(width);
    },
    invalidate() {},
  };
}
