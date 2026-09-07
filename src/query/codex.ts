import { bearer, header, officialAuth } from './http.ts';
import { numeric, object, percent, safeLabel, timestamp, windowLabel } from './parse.ts';
import { QuotaError } from './types.ts';
import type { QuotaAdapter, QuotaWindow } from './types.ts';

// Decode only to obtain routing metadata from the same resolved token.
// This does not verify a JWT; the official server verifies authentication.
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = object(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
    const id = object(payload['https://api.openai.com/auth']).chatgpt_account_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}

export function parseCodex(payload: unknown, now: number): QuotaWindow[] {
  const data = object(payload);
  const windows: QuotaWindow[] = [];
  const addDomain = (raw: unknown, domain: string, scope?: string) => {
    const rate = object(raw);
    for (const [key, fallback] of [['primary_window', 18000], ['secondary_window', 604800]] as const) {
      if (rate[key] == null) continue;
      const window = object(rate[key]);
      const duration = numeric(window.limit_window_seconds) ?? fallback;
      if (duration <= 0) throw new QuotaError('schema');
      const remaining = numeric(window.remaining_percent) ?? numeric(window.percent_left);
      const used = numeric(window.used_percent);
      const resetAfter = numeric(window.reset_after_seconds);
      const resetAt = timestamp(window.reset_at ?? window.reset_time_ms)
        ?? (resetAfter !== null && resetAfter >= 0 ? now + resetAfter * 1000 : null);
      windows.push({
        id: `${domain}/${key}`, label: windowLabel(duration), durationSeconds: duration,
        remainingPercent: remaining !== null ? percent(remaining) : used !== null ? percent(100 - used) : null,
        resetAt, ...(scope ? { scope } : {}),
      });
    }
  };
  addDomain(data.rate_limit, 'shared');
  if (Array.isArray(data.additional_rate_limits)) {
    for (const [index, entry] of data.additional_rate_limits.entries()) {
      const item = object(entry);
      const name = item.limit_name ?? item.metered_feature;
      const scope = typeof name === 'string' ? safeLabel(name) : `Model ${index + 1}`;
      addDomain(item.rate_limit, `additional-${index}`, scope);
    }
  }
  if (windows.length === 0) throw new QuotaError('schema');
  return windows;
}

export const codexAdapter: QuotaAdapter = {
  provider: 'openai-codex', label: 'Codex',
  async query(context) {
    const auth = await officialAuth(context, 'https://chatgpt.com');
    const token = bearer(auth);
    const account = header(auth, 'chatgpt-account-id') ?? codexAccountId(token);
    if (!account) throw new QuotaError('unsupported-auth');
    const data = await context.getJson('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': account,
      Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/',
    }, context.signal);
    const now = context.now();
    return { windows: parseCodex(data, now), fetchedAt: now };
  },
};
