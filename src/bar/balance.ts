import { horizontalBar, remainingTone, verticalBar } from './bar.ts';
import type { AccountBalance, QuotaAllowance, SpendSummary } from '../query/types.ts';
import type { Paint, Span } from './bar.ts';

export function money(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  const absolute = Math.abs(amount);
  if (absolute > 0 && absolute < 0.01) return `${sign}<${symbol}0.01`;
  return `${sign}${symbol}${absolute.toFixed(2)}`;
}

export function remainingMoney(balance: AccountBalance): string {
  if (balance.unlimited === true) return balance.currency === 'CNY' ? '¥∞' : balance.currency === 'USD' ? '$∞' : `${balance.currency} ∞`;
  return money(balance.remaining, balance.currency);
}

export function compactMoney(amount: number, currency: string): string {
  return money(amount, currency);
}

export function compactRemainingMoney(balance: AccountBalance): string {
  return remainingMoney(balance);
}

export function balanceSpans(balance: AccountBalance): Span[] {
  return [
    { text: 'Bal ', tone: 'dim' },
    { text: compactRemainingMoney(balance), tone: !balance.unlimited && balance.remaining <= 0 ? 'error' : 'text' },
  ];
}

export function balanceLines(balance: AccountBalance, paint: Paint): string[] {
  const remaining = remainingMoney(balance);
  return [paint('dim', 'Balance   ') + paint(!balance.unlimited && balance.remaining <= 0 ? 'error' : 'text', remaining)];
}

export function allowancePercent(allowance: QuotaAllowance): number {
  return Math.max(0, Math.min(100, allowance.remaining / allowance.limit * 100));
}

export function allowanceSpans(allowance: QuotaAllowance): Span[] {
  const remaining = allowancePercent(allowance);
  return [
    { text: 'Quota ', tone: 'dim' },
    { text: `${verticalBar(remaining)} ${compactMoney(allowance.remaining, allowance.currency)}`, tone: remainingTone(remaining) },
  ];
}

export function allowanceLines(allowance: QuotaAllowance, paint: Paint, barWidth: number): string[] {
  const remaining = allowancePercent(allowance);
  return [
    paint(remainingTone(remaining), horizontalBar(remaining, barWidth))
      + paint('dim', `  ${money(allowance.remaining, allowance.currency)} left`),
    paint('dim', `Used      ${money(allowance.used, allowance.currency)}`),
    paint('dim', `Limit     ${money(allowance.limit, allowance.currency)}`),
  ];
}

export function spendLines(spend: SpendSummary, paint: Paint): string[] {
  const lines: string[] = [];
  if (spend.today !== undefined) lines.push(paint('dim', `Today     ${money(spend.today, spend.currency)}`));
  return lines;
}
