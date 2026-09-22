import { QuotaError } from './types.ts';

// Validate a model endpoint before deriving any authenticated quota URL.
// Never accept redirects (see http.ts) or move credentials to another origin.
export function safeBaseUrl(baseUrl: string | undefined): URL {
  if (!baseUrl) throw new QuotaError('unsupported-auth');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new QuotaError('unsupported-auth'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw new QuotaError('unsupported-auth');
  return url;
}
