// Template only. Replace the provider ID, fixed URL and schema for your service.
// Load this entry INSTEAD OF src/index.ts, not alongside it.
import { createQuotaExtension } from '../src/extension.ts';
import { numeric, object, percent, timestamp } from '../src/query/parse.ts';
import { QuotaError } from '../src/query/types.ts';
import type { QuotaAdapter } from '../src/query/types.ts';

const customAdapter: QuotaAdapter = {
  provider: 'my-gateway',
  label: 'My Gateway',
  async query(context) {
    // Resolve ONLY this provider's credentials. Never reuse Codex/Kimi credentials.
    const auth = await context.getAuth(context.provider);
    context.signal.throwIfAborted();
    if (!auth?.apiKey) throw new QuotaError('auth');
    // This deliberately nonfunctional domain must be replaced explicitly.
    const data = object(await context.getJson('https://quota.example.invalid/v1/usage', {
      Authorization: `Bearer ${auth.apiKey}`,
    }, context.signal));
    const remaining = numeric(data.remaining_percent);
    if (remaining === null) throw new QuotaError('schema');
    return {
      fetchedAt: context.now(),
      windows: [{ id: 'daily', label: '1d', durationSeconds: 86400,
        remainingPercent: percent(remaining), resetAt: timestamp(data.reset_at) }],
    };
  },
};

export default createQuotaExtension({ adapters: [customAdapter] });
