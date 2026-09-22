import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createQuotaExtension } from './extension.ts';
import { loadQuotaAdaptersFromSettings, QuotaConfigError } from './config.ts';
import type { QuotaAdapter } from './query/types.ts';

export default function (pi: ExtensionAPI): void {
  let adapters: QuotaAdapter[] = [];
  try {
    // Quota provider bindings belong to the user's global Pi settings. Project
    // settings are intentionally not read here: a project must not redirect a
    // globally authenticated provider's credential to an account endpoint.
    const settings = SettingsManager.create(process.cwd(), getAgentDir(), {
      projectTrusted: false,
    }).getGlobalSettings() as unknown;
    adapters = loadQuotaAdaptersFromSettings(settings);
  } catch {
    pi.on('session_start', (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(new QuotaConfigError().message, 'warning');
    });
  }
  // Invalid optional settings never disable the built-in Codex/Kimi/OpenCode Go adapters.
  createQuotaExtension({ adapters })(pi);
}
