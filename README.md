# @astrosheep/pi-quota

Compact quota status for Pi: Codex, Kimi and OpenCode Go work out of the box; new-api, DeepSeek and Sub2API use explicit provider bindings.

```bash
pi install npm:@astrosheep/pi-quota
```

Reload Pi after installing or changing settings. Use `/usage` for a persistent, context-free snapshot in the chat history. Automatic footer polling never adds chat items.

## What it shows

| Kind | Footer | `/usage` |
|---|---|---|
| Renewable window | `5h [▆] 72% ↺ 2h15m` | Horizontal bar, remaining percentage, reset, exact amounts if available |
| Wallet | `Bal $12.34` | Balance; optional Today/Lifetime spend |
| Fixed quota | `Quota [▇] $85.00` | Remaining bar plus used and limit |

A percentage always means **remaining**, not used. Unknown is `[?] ?`; an expired reset is `↺ due` with the stale percentage hidden until the next successful query. A wallet balance never becomes a percentage. Historical spend is not a quota.

The footer shows at most two windows and `+N` for additional ones. `/usage` includes all windows; it does not open a modal or send messages to the model. Snapshots remain frozen at capture time. Errors replace stale values.

## Configure providers

Add bindings in global `~/.pi/agent/settings.json` under `quotaUsage` (not project settings):

```json
{
  "quotaUsage": {
    "providers": {
      "my-sub2api": { "adapter": "sub2api" },
      "my-new-api": { "adapter": "new-api", "quotaPerUnit": 500000, "currency": "USD" },
      "deepseek": { "adapter": "deepseek" }
    }
  }
}
```

Use the **exact Pi provider ID**. Only selected, explicitly bound providers are queried; built-in `openai-codex`, `kimi-coding` and `opencode-go` cannot be overridden. Unknown keys or adapter options are rejected. The API key and model `baseUrl` come from Pi's active provider auth; do not put model API keys in `quotaUsage`.

| Adapter | Endpoint | Result |
|---|---|---|
| `sub2api` | `{baseUrl}/usage` | Wallet, key quota, rate windows or subscription day/week/month windows; API-key Today/Lifetime actual spend |
| `new-api` | Account PAT `/api/user/self`, falling back to key-native billing/token endpoints | Account balance + lifetime spend; finite key quota when explicitly granted; **not** a renewable window |
| `deepseek` | Official `/user/balance` | Balance only; no invented spend |

Sub2API accepts no extra settings; it preserves deployment subpaths. Rate-only keys need not expose a top-level currency (rates are USD). Unknown rate-window durations and invalid limits fail rather than inventing a 1d window. Subscription periods without a cap are omitted. Its dashboard `/api/v1/usage` is a separate, JWT-authenticated paginated request log; the adapter uses the API-key `/v1/usage` instead.

For new-api, `quotaPerUnit` defaults to `500000`, `currency` to `USD`. Optionally add `dashboardAccessToken` (console system access token) and `dashboardUserId` (positive numeric ID required by some old forks) to that provider. This PAT is the **only** optional secret kept in settings. The account endpoint takes precedence; failures fall back to the key-native billing and token usage paths. Without a PAT, an API key cannot read the dashboard account quota. A finite key reports a quota bar only when `total_granted` is present and consistent with used plus remaining; otherwise it shows a balance and lifetime spend, without inventing a limit. Values in settings and server error bodies are never logged.

Authenticated quota URLs must use HTTPS, except HTTP loopback for local deployments. URL userinfo, query strings, fragments and HTTP redirects are rejected; credentials never follow redirects. Fixed official endpoints reject custom origins. No browser cookie scraping or credential discovery.

## Architecture

```text
Pi model/auth → adapter → QuotaSnapshot → controller → footer / /usage / state event
```

- `src/query/`: protocol-specific parsing, credential resolution, safe URLs, bounded GET client, state validation and controller. No Pi/TUI imports.
- `src/config.ts`: strict global provider bindings.
- `src/bar/`: pure compact rendering and persistent chat card.
- `src/extension.ts` and `src/index.ts`: Pi lifecycle and auth bridge.

`QuotaSnapshot` separates `balance` (wallet), `allowance` (finite key quota), `windows` (renewable limits), and optional `spend` (Today/Lifetime actual charge). This prevents unrelated amounts from sharing an ambiguous `Used` label. Custom adapters can be passed to `createQuotaExtension({ adapters: [...] })`; see `examples/custom-provider.ts`. Provider aliases are never inferred.

The extension publishes structured state on `quota-bar:state:v1`. Use `createQuotaExtension({ footer: false })` to consume it without this extension's footer. Normal queries are throttled, cancellable, timeout-bounded and backed off after errors. `/usage` forces a fresh query. Switching provider discards old values immediately.

## Development

Requires Node ≥22.18 and a compatible Pi installation.

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run demo
```
