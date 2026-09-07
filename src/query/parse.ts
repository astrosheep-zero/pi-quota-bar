export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function percent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function timestamp(value: unknown): number | null {
  const number = numeric(value);
  const parsed = number !== null
    ? (number < 1e12 ? number * 1000 : number)
    : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8.64e15 ? parsed : null;
}

export function windowLabel(seconds: number): string {
  if (seconds === 604800) return '1w';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// API-controlled labels may not inject terminal controls, ANSI, or newlines.
export function safeLabel(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').slice(0, 64);
}
