import { bearer, officialAuth } from './http.ts';
import { numeric, object, percent, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { QuotaAdapter, QuotaWindow } from './types.ts';

const units: Record<string, number> = {
  TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400,
};

export function parseKimi(payload: unknown): QuotaWindow[] {
  const data = object(payload);
  const windows: QuotaWindow[] = [];
  const add = (raw: unknown, duration: number, id: string) => {
    const detail = object(raw);
    const limit = numeric(detail.limit);
    const used = numeric(detail.used);
    const remaining = numeric(detail.remaining);
    // No default for omitted counts: absence is not proof of zero usage.
    const fraction = limit !== null && limit > 0
      ? remaining !== null && remaining >= 0 ? remaining / limit
        : used !== null && used >= 0 ? 1 - used / limit : null
      : null;
    windows.push({
      id, label: windowLabel(duration), durationSeconds: duration,
      remainingPercent: fraction === null ? null : percent(fraction * 100),
      resetAt: timestamp(detail.resetTime ?? detail.reset_at),
    });
  };
  if (data.usage != null && typeof data.usage === 'object') add(data.usage, 604800, 'weekly');
  if (Array.isArray(data.limits)) {
    for (const [index, raw] of data.limits.entries()) {
      const entry = object(raw);
      const window = object(entry.window);
      const multiplier = typeof window.timeUnit === 'string' ? units[window.timeUnit] : undefined;
      const duration = numeric(window.duration);
      if (!entry.detail || !multiplier || duration === null || duration <= 0) continue;
      add(entry.detail, duration * multiplier, `limit-${index}`);
    }
  }
  if (windows.length === 0) throw new QuotaError('schema');
  return windows.sort((a, b) => a.durationSeconds - b.durationSeconds);
}

export const kimiAdapter: QuotaAdapter = {
  provider: 'kimi-coding', label: 'Kimi',
  async query(context) {
    const auth = await officialAuth(context, 'https://api.kimi.com');
    const data = await context.getJson('https://api.kimi.com/coding/v1/usages', {
      Authorization: `Bearer ${bearer(auth)}`,
    }, context.signal);
    return { windows: parseKimi(data), fetchedAt: context.now() };
  },
};
