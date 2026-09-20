import { bearer, officialAuth } from './http.ts';
import { numeric, object } from './parse.ts';
import { QuotaError } from './types.ts';
import type { AccountBalance, QuotaAdapter } from './types.ts';

export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com';

// https://api-docs.deepseek.com/api/get-user-balance
// GET /user/balance (also mounted under /v1/). The sk- key works directly.
// Amounts arrive as strings in yuan; balance_infos may list several currencies.
export function parseDeepSeekBalance(payload: unknown): AccountBalance {
  const body = object(payload);
  if (!Array.isArray(body.balance_infos) || body.balance_infos.length === 0) throw new QuotaError('schema');
  for (const entry of body.balance_infos) {
    const info = object(entry);
    const remaining = numeric(info.total_balance);
    if (typeof info.currency !== 'string' || !/^[A-Z]{3}$/.test(info.currency)
      || remaining === null || remaining < 0) continue;
    // The endpoint exposes no usage total; used stays 0 rather than fabricated.
    return { currency: info.currency, remaining, used: 0 };
  }
  throw new QuotaError('schema');
}

export function createDeepSeekAdapter(provider: string): QuotaAdapter {
  return {
    provider, label: provider,
    async query(context) {
      const auth = await officialAuth(context, DEEPSEEK_ORIGIN);
      const payload = await context.getJson(`${DEEPSEEK_ORIGIN}/user/balance`,
        { Authorization: `Bearer ${bearer(auth)}` }, context.signal);
      return { windows: [], balance: parseDeepSeekBalance(payload), fetchedAt: context.now() };
    },
  };
}
