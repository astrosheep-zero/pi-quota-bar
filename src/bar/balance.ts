import type { AccountBalance } from '../query/types.ts';
import type { Paint, Span } from './bar.ts';

export function money(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const prefix = currency === 'USD' ? '$' : `${currency} `;
  const absolute = Math.abs(amount);
  if (absolute > 0 && absolute < 0.01) return `${sign}<${prefix}0.01`;
  return `${sign}${prefix}${absolute.toFixed(2)}`;
}

export function balanceSpans(balance: AccountBalance): Span[] {
  return [
    { text: 'Bal ', tone: 'dim' },
    { text: money(balance.remaining, balance.currency), tone: balance.remaining <= 0 ? 'error' : 'text' },
  ];
}

export function balanceLines(balance: AccountBalance, paint: Paint): string[] {
  const remaining = money(balance.remaining, balance.currency);
  const used = money(balance.used, balance.currency);
  const width = Math.max(remaining.length, used.length);
  return [
    paint('dim', 'Balance  ') + paint(balance.remaining <= 0 ? 'error' : 'text', remaining.padStart(width)),
    paint('dim', 'Used     ') + paint('dim', used.padStart(width)),
  ];
}
