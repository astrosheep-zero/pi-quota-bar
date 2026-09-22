import { bearer, officialAuth } from './http.ts';
import { numeric, object, percent, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { QuotaAdapter, QuotaWindow } from './types.ts';

// OpenCode Go (opencode.ai Zen Go plan) is a single official deployment, so the
// window keys are fixed and undecorated: percent is already "used", and there is
// no dollar balance — only the console shows money.
const WINDOWS = [
  { key: 'rolling', duration: 18000 }, // 5 hours
  { key: 'weekly', duration: 604800 }, // 7 days
  { key: 'monthly', duration: 2592000 }, // 30 days
] as const;

export function parseOpenCodeGo(payload: unknown): QuotaWindow[] {
  const usage = object(object(payload).usage);
  const windows: QuotaWindow[] = [];
  for (const { key, duration } of WINDOWS) {
    if (usage[key] === undefined) continue;
    const detail = object(usage[key]);
    const used = numeric(detail.percent);
    windows.push({
      id: key, label: windowLabel(duration), durationSeconds: duration,
      // Absent or malformed percent stays unknown; never fabricate a window.
      remainingPercent: used === null ? null : percent(100 - used),
      resetAt: timestamp(detail.resetsAt),
    });
  }
  if (windows.length === 0) throw new QuotaError('schema');
  return windows;
}

export const openCodeGoAdapter: QuotaAdapter = {
  provider: 'opencode-go', label: 'OpenCode Go',
  async query(context) {
    const auth = await officialAuth(context, 'https://opencode.ai');
    const data = await context.getJson('https://opencode.ai/zen/go/v1/usage', {
      Authorization: `Bearer ${bearer(auth)}`,
    }, context.signal);
    return { windows: parseOpenCodeGo(data), fetchedAt: context.now() };
  },
};
