import { createNewApiAdapter, validateNewApiOptions } from './query/new-api.ts';
import type { NewApiOptions } from './query/new-api.ts';
import type { QuotaAdapter } from './query/types.ts';

export interface ProviderQuotaConfig extends NewApiOptions { adapter: 'new-api' }
export interface QuotaConfig { providers: Record<string, ProviderQuotaConfig> }

export class QuotaConfigError extends Error {
  constructor() {
    // Settings may accidentally contain secrets. Never echo content/values.
    super('Invalid settings.json quotaUsage. Use providers with adapter "new-api", a positive quotaPerUnit and an uppercase currency code.');
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
      || !record(item) || item.adapter !== 'new-api'
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
  return Object.entries(config.providers).map(([provider, options]) => createNewApiAdapter(provider, options));
}
