import { QuotaError } from './types.ts';
import type { ProviderAuth, QueryContext } from './types.ts';

export function createJsonClient(fetcher: typeof fetch = globalThis.fetch): QueryContext['getJson'] {
  return async (url, headers, signal) => {
    try {
      const response = await fetcher(url, {
        method: 'GET', headers: { Accept: 'application/json', ...headers },
        signal, redirect: 'error', // Never forward credentials to a redirected endpoint.
      });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) : NaN;
        const delay = Number.isFinite(seconds) ? seconds * 1000
          : retry ? Date.parse(retry) - Date.now() : NaN;
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new QuotaError('auth');
        if (response.status === 429) {
          throw new QuotaError('rate-limit', Number.isFinite(delay) ? Math.max(0, delay) : undefined);
        }
        throw new QuotaError('http');
      }
      // Quota responses are small. Bound memory and reject unexpected HTML/proxy pages.
      const reader = response.body?.getReader();
      if (!reader) throw new QuotaError('schema');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 256 * 1024) {
            await reader.cancel();
            throw new QuotaError('schema');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch {
        throw new QuotaError('schema');
      }
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      if (signal.aborted) throw signal.reason;
      throw new QuotaError('network');
    }
  };
}

export function header(auth: ProviderAuth, name: string): string | undefined {
  return Object.entries(auth.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export async function officialAuth(context: QueryContext, origin: string): Promise<ProviderAuth> {
  let auth: ProviderAuth | undefined;
  try {
    auth = await context.getAuth(context.provider);
  } catch {
    throw new QuotaError('auth');
  }
  context.signal.throwIfAborted();
  if (!auth) throw new QuotaError('auth');
  if (auth.baseUrl) {
    let actual: URL;
    try { actual = new URL(auth.baseUrl); } catch { throw new QuotaError('unsupported-auth'); }
    if (actual.origin !== origin || actual.username || actual.password) throw new QuotaError('unsupported-auth');
  }
  return auth;
}

export function bearer(auth: ProviderAuth): string {
  const authorization = header(auth, 'authorization');
  // A runtime Authorization header overrides apiKey, just as it does for requests.
  if (authorization !== undefined) {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    if (!token) throw new QuotaError('unsupported-auth');
    return token;
  }
  if (!auth.apiKey) throw new QuotaError('auth');
  return auth.apiKey;
}
