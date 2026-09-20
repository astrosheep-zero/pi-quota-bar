import { createDeepSeekAdapter } from './query/deepseek.ts';
import { createNewApiAdapter, validateNewApiOptions } from './query/new-api.ts';
import type { NewApiOptions } from './query/new-api.ts';
import type { QuotaAdapter } from './query/types.ts';

export interface ProviderQuotaConfig extends NewApiOptions { adapter: 'new-api' | 'deepseek' }
export interface QuotaConfig { providers: Record<string, ProviderQuotaConfig> }

export class QuotaConfigError extends Error {
  constructor() {
    // Settings may accidentally contain secrets. Never echo content/values.
    super('Invalid settings.json quotaUsage. Use providers with adapter "new-api" (positive quotaPerUnit, uppercase currency) or "deepseek" (no options).');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseQuotaConfig(value: unknown): QuotaConfig {
  if (!record(value) || Object.keys(value).some(key => key !== 'providers')
    || !record(value.providers) || Object.keys(value.providers).length > 64) throw new QuotaConfigError();
  const providers: Record<string, ProviderQuotaConfig> = Object.create(null);
  for (const [provider, item] of Object.entries(value.providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(provider)
      || ['openai-codex', 'kimi-coding'].includes(provider)
      || !record(item)) throw new QuotaConfigError();
    if (item.adapter === 'deepseek') {
      if (Object.keys(item).some(key => key !== 'adapter')) throw new QuotaConfigError();
      providers[provider] = { adapter: 'deepseek', quotaPerUnit: 500000, currency: 'USD' };
      continue;
    }
    if (item.adapter !== 'new-api'
      || Object.keys(item).some(key => !['adapter', 'quotaPerUnit', 'currency'].includes(key))
      || (item.quotaPerUnit !== undefined && typeof item.quotaPerUnit !== 'number')
      || (item.currency !== undefined && typeof item.currency !== 'string')) throw new QuotaConfigError();
    try {
      const settings = validateNewApiOptions({ quotaPerUnit: item.quotaPerUnit, currency: item.currency });
      providers[provider] = { adapter: 'new-api', ...settings };
    } catch { throw new QuotaConfigError(); }
  }
  return { providers };
}

export function loadQuotaAdaptersFromSettings(settings: unknown): QuotaAdapter[] {
  if (!record(settings) || settings.quotaUsage === undefined) return [];
  const config = parseQuotaConfig(settings.quotaUsage);
  return Object.entries(config.providers).map(([provider, options]) => options.adapter === 'deepseek'
    ? createDeepSeekAdapter(provider)
    : createNewApiAdapter(provider, options));
}
