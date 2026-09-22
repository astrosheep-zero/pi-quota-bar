import { horizontalBar, remainingTone, verticalBar } from './bar.ts';
import type { AccountBalance, QuotaAllowance, SpendSummary } from '../query/types.ts';
import type { Paint, Span } from './bar.ts';

export function money(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  const prefix = currency === 'USD' ? '$' : `${currency} `;
  const absolute = Math.abs(amount);
  if (absolute > 0 && absolute < 0.01) return `${sign}<${prefix}0.01`;
  return `${sign}${prefix}${absolute.toFixed(2)}`;
}

export function remainingMoney(balance: AccountBalance): string {
  if (balance.unlimited === true) return balance.currency === 'USD' ? '$∞' : `${balance.currency} ∞`;
  return money(balance.remaining, balance.currency);
}

export function balanceSpans(balance: AccountBalance): Span[] {
  return [
    { text: 'Bal ', tone: 'dim' },
    { text: remainingMoney(balance), tone: !balance.unlimited && balance.remaining <= 0 ? 'error' : 'text' },
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
    { text: `${verticalBar(remaining)} ${money(allowance.remaining, allowance.currency)}`, tone: remainingTone(remaining) },
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
  if (spend.lifetime !== undefined) lines.push(paint('dim', `Lifetime  ${money(spend.lifetime, spend.currency)}`));
  return lines;
}
