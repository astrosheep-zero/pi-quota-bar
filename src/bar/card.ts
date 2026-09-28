import { Text } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { Paint } from './bar.ts';
import { renderUsage } from './quota.ts';
import type { QuotaState } from '../query/types.ts';

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

export function usageLines(card: UsageCard, paint?: Paint, barWidth = 20): string[] {
  if (card.version === 1) return renderUsage(card.state, paint, card.capturedAt, barWidth);
  if (card.states.length === 0) return ['No supported quota providers available.'];
  return card.states.flatMap((state, index) => [
    ...(index ? ['', ''] : []), ...renderUsage(state, paint, card.capturedAt, barWidth),
  ]);
}

export function usageCardComponent(card: UsageCard | undefined, paint?: Paint): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      if (!card || (card.version !== 1 && card.version !== 2) || !Number.isFinite(card.capturedAt)) {
        return new Text('Usage snapshot unavailable.', 0, 0).render(width);
      }
      // Rebuild on every render for theme/width changes, but freeze time at capture.
      const lines = usageLines(card, paint, width < 55 ? 10 : 18);
      // Wrapping, not clipping: long quota names remain readable in narrow terminals.
      return new Text(lines.join('\n'), 0, 0).render(width);
    },
    invalidate() {},
  };
}
