import { AdapterRegistry, validateSnapshot } from './registry.ts';
import { QuotaError } from './types.ts';
import type { QueryContext, QuotaState } from './types.ts';

type AuthResolver = QueryContext['getAuth'];
interface ControllerOptions {
  registry: AdapterRegistry;
  getJson: QueryContext['getJson'];
  onState(state: QuotaState): void;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

// Waiting is bounded even if a custom adapter or auth resolver ignores abort.
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', rejectAbort); }
}

export class QuotaController {
  state: QuotaState = { kind: 'hidden' };
  private provider?: string;
  private generation = 0;
  private request?: { abort: AbortController; promise: Promise<void> };
  private nextAttempt = 0;
  private failures = 0;
  private readonly options: ControllerOptions;
  private readonly now: () => number;
  private readonly interval: number;
  private readonly timeout: number;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.interval = options.intervalMs ?? 60000;
    this.timeout = options.timeoutMs ?? 10000;
    if (!Number.isFinite(this.interval) || this.interval <= 0
      || !Number.isFinite(this.timeout) || this.timeout <= 0) throw new Error('Invalid quota timing');
  }

  private publish(state: QuotaState): void {
    this.state = state;
    this.options.onState(state);
  }

  select(provider: string | undefined): void {
    this.generation++;
    this.request?.abort.abort();
    this.request = undefined;
    this.provider = provider;
    this.nextAttempt = 0;
    this.failures = 0;
    const adapter = this.options.registry.get(provider);
    // Clear old values synchronously, before auth resolution or any network I/O.
    this.publish(adapter
      ? { kind: 'loading', provider: adapter.provider, label: adapter.label }
      : { kind: 'hidden' });
  }

  stop(): void { this.select(undefined); }

  refresh(getAuth: AuthResolver, force = false): Promise<void> {
    const adapter = this.options.registry.get(this.provider);
    if (!adapter) return Promise.resolve();
    if (this.request && !force) return this.request.promise;
    if (!force && this.now() < this.nextAttempt) return Promise.resolve();
    if (force) {
      this.generation++;
      this.request?.abort.abort();
      this.request = undefined;
    }
    const generation = this.generation;
    const abort = new AbortController();
    const active = () => this.generation === generation && this.request?.abort === abort;
    // Keep the last result visible during refresh; selection already clears it.
    if (this.state.kind !== 'ready' && this.state.kind !== 'loading') {
      this.publish({ kind: 'loading', provider: adapter.provider, label: adapter.label });
    }
    const deadline = setTimeout(() => abort.abort(new QuotaError('timeout')), this.timeout);
    const promise = Promise.resolve().then(async () => {
      try {
        abort.signal.throwIfAborted();
        const result = await abortable(adapter.query({
          provider: adapter.provider, signal: abort.signal, now: this.now,
          getAuth, getJson: this.options.getJson,
        }), abort.signal);
        if (!active()) return;
        const snapshot = validateSnapshot(result);
        this.failures = 0;
        this.nextAttempt = this.now() + this.interval;
        this.publish({ kind: 'ready', provider: adapter.provider, label: adapter.label, snapshot });
      } catch (error) {
        if (!active()) return;
        const safe = error instanceof QuotaError ? error : new QuotaError('network');
        this.failures++;
        const backoff = Math.min(900000, this.interval * 2 ** Math.min(this.failures - 1, 4));
        this.nextAttempt = this.now() + Math.max(backoff, safe.retryAfterMs ?? 0);
        // Do not retain a prior account's cached quota after auth changes/errors.
        this.publish({ kind: 'error', provider: adapter.provider, label: adapter.label, code: safe.code });
      } finally {
        clearTimeout(deadline);
        if (active()) this.request = undefined;
      }
    });
    this.request = { abort, promise };
    return promise;
  }
}
