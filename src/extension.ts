import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { renderFooter, renderUsage } from './bar/quota.ts';
import { captureUsage, USAGE_ENTRY, usageCardComponent } from './bar/card.ts';
import type { UsageCard } from './bar/card.ts';
import { codexAdapter } from './query/codex.ts';
import { kimiAdapter } from './query/kimi.ts';
import { QuotaController } from './query/controller.ts';
import { createJsonClient } from './query/http.ts';
import { AdapterRegistry } from './query/registry.ts';
import type { ProviderAuth, QuotaAdapter } from './query/types.ts';

export const STATUS_EVENT = 'quota-bar:state:v1';
const STATUS_KEY = 'quota-bar';
const USAGE_WIDGET = 'quota-bar:usage';

export interface QuotaExtensionOptions {
  adapters?: readonly QuotaAdapter[]; // Extra adapters; duplicate IDs are rejected.
  footer?: boolean; // false: query + /usage + structured events only
  intervalMs?: number;
  timeoutMs?: number;
}

export function createQuotaExtension(options: QuotaExtensionOptions = {}) {
  return (pi: ExtensionAPI): void => {
    const registry = new AdapterRegistry([codexAdapter, kimiAdapter, ...(options.adapters ?? [])]);
    let current: ExtensionContext | undefined;
    let selectedProvider: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastStatus: string | undefined;
    // Invalidates pending commands on model/session replacement or another /usage.
    let commandGeneration = 0;

    pi.registerEntryRenderer<UsageCard>(USAGE_ENTRY, (entry, _options, theme) => {
      const paint = process.env.NO_COLOR !== undefined ? undefined
        : (tone: Parameters<typeof theme.fg>[0], text: string) => theme.fg(tone, text);
      return usageCardComponent(entry.data, paint);
    });

    const paintFooter = () => {
      if (!current?.hasUI || options.footer === false) return;
      try {
        const ctx = current;
        const paint = process.env.NO_COLOR !== undefined ? undefined
          : (tone: Parameters<typeof ctx.ui.theme.fg>[0], text: string) => ctx.ui.theme.fg(tone, text);
        const text = renderFooter(controller.state, paint) || undefined;
        if (text !== lastStatus) {
          ctx.ui.setStatus(STATUS_KEY, text);
          lastStatus = text;
        }
      } catch {
        // Stale session contexts must not keep a background polling loop alive.
        current = undefined;
        commandGeneration++;
        if (timer) clearInterval(timer);
        timer = undefined;
        controller.stop();
      }
    };

    const controller = new QuotaController({
      registry, getJson: createJsonClient(), intervalMs: options.intervalMs, timeoutMs: options.timeoutMs,
      onState(state) {
        paintFooter();
        pi.events.emit(STATUS_EVENT, state); // Structured data, no credentials or ANSI.
      },
    });

    const refresh = (force = false): Promise<void> => {
      const ctx = current;
      if (!ctx?.hasUI) return Promise.resolve();
      return controller.refresh(async provider => {
        const resolved = await ctx.modelRegistry.getProviderAuth(provider);
        if (!resolved) return undefined;
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
          if (typeof value === 'string') headers[name] = value;
        }
        const auth: ProviderAuth = { ...resolved.auth, headers };
        // A model-level custom endpoint must not be mistaken for an official account.
        if (ctx.model?.provider === provider && ctx.model.baseUrl) auth.baseUrl = ctx.model.baseUrl;
        return auth;
      }, force);
    };

    const bind = (ctx: ExtensionContext, select = false, provider = ctx.model?.provider) => {
      current = ctx;
      if (!ctx.hasUI) return;
      if (select || provider !== selectedProvider) {
        commandGeneration++;
        if (ctx.mode === 'tui') ctx.ui.setWidget(USAGE_WIDGET, undefined);
        selectedProvider = provider;
        controller.select(provider);
      }
      void refresh();
    };

    pi.on('session_start', (_event, ctx) => {
      lastStatus = undefined;
      bind(ctx, true);
      if (timer) clearInterval(timer);
      if (ctx.hasUI) {
        timer = setInterval(() => {
          paintFooter(); // Local countdown/theme refresh, no extra HTTP request.
          void refresh(); // Controller throttles queries and applies error backoff.
        }, 10000);
        timer.unref?.();
      }
    });
    pi.on('model_select', (event, ctx) => bind(ctx, true, event.model.provider));
    pi.on('turn_end', (_event, ctx) => bind(ctx));
    pi.on('session_shutdown', (_event, ctx) => {
      if (timer) clearInterval(timer);
      timer = undefined;
      current = undefined;
      selectedProvider = undefined;
      lastStatus = undefined;
      commandGeneration++;
      controller.stop();
      if (ctx.hasUI && ctx.mode === 'tui') ctx.ui.setWidget(USAGE_WIDGET, undefined);
      if (ctx.hasUI && options.footer !== false) ctx.ui.setStatus(STATUS_KEY, undefined);
    });

    pi.registerCommand('usage', {
      description: 'Query current provider quota and add a snapshot to the chat history',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;
        bind(ctx);
        const generation = ++commandGeneration;
        if (ctx.mode === 'tui') ctx.ui.setWidget(USAGE_WIDGET, ['Loading…']);
        try {
          await refresh(true);
          // Never append via a stale Pi runtime, or label a replacement model's data
          // as the result of the original command. A newer command owns its result.
          if (!current || generation !== commandGeneration) return;
          const card = captureUsage(controller.state);
          if (!card) return;
          pi.appendEntry<UsageCard>(USAGE_ENTRY, card);
          // Custom entry renderers are TUI-only; RPC clients still get readable output.
          if (ctx.mode !== 'tui') {
            ctx.ui.notify(renderUsage(card.state, undefined, card.capturedAt).join('\n'), 'info');
          }
        } finally {
          // An older request must not clear a newer command's loading indicator.
          if (current && generation === commandGeneration && ctx.mode === 'tui') {
            ctx.ui.setWidget(USAGE_WIDGET, undefined);
          }
        }
      },
    });
  };
}
