import { createDeepSeekAdapter } from './query/deepseek.ts';
import { createNewApiAdapter, validateNewApiOptions } from './query/new-api.ts';
import { createSub2ApiAdapter } from './query/sub2api.ts';
import type { NewApiOptions } from './query/new-api.ts';
import type { QuotaAdapter } from './query/types.ts';

export interface ProviderQuotaConfig extends NewApiOptions { adapter: 'new-api' | 'deepseek' | 'sub2api' }
export interface QuotaConfig { providers: Record<string, ProviderQuotaConfig> }

const DASHBOARD_KEYS = ['dashboardAccessToken', 'dashboardUserId'] as const;

function parseDashboardOptions(item: Record<string, unknown>): Pick<NewApiOptions, 'dashboardAccessToken' | 'dashboardUserId'> {
  const result: Pick<NewApiOptions, 'dashboardAccessToken' | 'dashboardUserId'> = {};
  if (item.dashboardAccessToken !== undefined) {
    if (typeof item.dashboardAccessToken !== 'string' || item.dashboardAccessToken.trim() === '') throw new QuotaConfigError();
    result.dashboardAccessToken = item.dashboardAccessToken;
  }
  if (item.dashboardUserId !== undefined) {
    if (typeof item.dashboardUserId !== 'number'
      || !Number.isSafeInteger(item.dashboardUserId) || item.dashboardUserId <= 0) throw new QuotaConfigError();
    result.dashboardUserId = item.dashboardUserId;
  }
  return result;
}

export class QuotaConfigError extends Error {
  constructor() {
    // Settings may accidentally contain secrets. Never echo content/values.
    super('Invalid settings.json quotaUsage. Use providers with adapter "new-api", "deepseek" or "sub2api".');
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
      || ['openai-codex', 'kimi-coding', 'opencode-go'].includes(provider)
      || !record(item)) throw new QuotaConfigError();
    if (item.adapter === 'deepseek') {
      if (Object.keys(item).some(key => key !== 'adapter')) throw new QuotaConfigError();
      providers[provider] = { adapter: 'deepseek', quotaPerUnit: 500000, currency: 'USD' };
      continue;
    }
    if (item.adapter === 'sub2api') {
      if (Object.keys(item).length !== 1) throw new QuotaConfigError();
      providers[provider] = { adapter: 'sub2api' };
      continue;
    }
    if (item.adapter !== 'new-api'
      || Object.keys(item).some(key => !['adapter', 'quotaPerUnit', 'currency', ...DASHBOARD_KEYS].includes(key))
      || (item.quotaPerUnit !== undefined && typeof item.quotaPerUnit !== 'number')
      || (item.currency !== undefined && typeof item.currency !== 'string')) throw new QuotaConfigError();
    try {
      const settings = validateNewApiOptions({ quotaPerUnit: item.quotaPerUnit, currency: item.currency });
      providers[provider] = { adapter: 'new-api', ...settings, ...parseDashboardOptions(item) };
    } catch { throw new QuotaConfigError(); }
  }
  return { providers };
}

export function loadQuotaAdaptersFromSettings(settings: unknown): QuotaAdapter[] {
  if (!record(settings) || settings.quotaUsage === undefined) return [];
  const config = parseQuotaConfig(settings.quotaUsage);
  return Object.entries(config.providers).map(([provider, options]) => options.adapter === 'deepseek'
    ? createDeepSeekAdapter(provider)
    : options.adapter === 'sub2api' ? createSub2ApiAdapter(provider)
    : createNewApiAdapter(provider, options));
}
