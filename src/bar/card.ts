import { Text } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { Paint } from './bar.ts';
import { renderUsage } from './quota.ts';
import type { QuotaState } from '../query/types.ts';

export const USAGE_ENTRY = 'quota-bar:usage:v1';

export interface UsageCard {
  version: 1;
  capturedAt: number;
  state: Exclude<QuotaState, { kind: 'loading' }>;
}

export function captureUsage(state: QuotaState, now = Date.now()): UsageCard | undefined {
  if (state.kind === 'loading') return undefined;
  // Separate the persistent entry from the live controller's state/objects.
  return { version: 1, capturedAt: now, state: structuredClone(state) };
}

export function usageCardComponent(card: UsageCard | undefined, paint?: Paint): Component {
  return {
    render(width: number): string[] {
      if (width <= 0) return [];
      if (!card || card.version !== 1 || !Number.isFinite(card.capturedAt)) {
        return new Text('Usage snapshot unavailable.', 0, 0).render(width);
      }
      // Rebuild on every render for theme/width changes, but freeze time at capture.
      const lines = renderUsage(card.state, paint, card.capturedAt, width < 55 ? 10 : 20);
      // Wrapping, not clipping: long quota names remain readable in narrow terminals.
      return new Text(lines.join('\n'), 0, 0).render(width);
    },
    invalidate() {},
  };
}
