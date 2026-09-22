# pi-quota-bar

A small Pi extension for **Codex** (`openai-codex`), **Kimi** (`kimi-coding`), **OpenCode Go** (`opencode-go`), and explicitly configured **new-api** providers.
All UI text is English. All quota percentages mean **remaining**, not used.

## Display

Footer — one vertical Unicode bar per quota window, no provider name or “remaining” prefix:

```text
5h [▆] 72% ↺ 2h15m · 1w [▇] 85% ↺ 5d3h 
```

The space after `↺` and the final trailing space are intentional and tested.

`/usage` — a horizontal-bar snapshot inserted as an item in the **chat history**, for the currently selected provider:

```text
Codex · Remaining quota

5h  [██████████████░░░░░░]  72% ↺ 2h15m
1w  [█████████████████░░░]  85% ↺ 5d3h
```

- Each `/usage` starts immediately, including during streaming, and shows `Loading…` above the editor while fetching. The indicator is removed when the query finishes or the model/session changes. Each command forces a fresh query and inserts a new snapshot. Labels, bars, percentages and reset times are column-aligned. The capture timestamp is stored as metadata only; no timestamp, legend or instruction footer is displayed. No overlay, no input replacement, no focus capture.
- Snapshots persist with the session but are custom entries, **not LLM messages**. They do not consume model context. Amounts and countdowns stay frozen at capture time; run `/usage` again for a new snapshot. The footer keeps refreshing independently.
- Failed queries produce an explicit error snapshot, not stale percentages. Model/session switches cancel pending card insertion.
- Bar + percentage use Pi's theme tokens: `success` above 30%, `warning` above 10% through 30%, `error` at or below 10%. Default themes render these green/yellow/red; custom themes can change them.
- Labels and countdowns are dim. `NO_COLOR=1` disables color.
- `[·] 0%` means exhausted; `[?] ?` means unknown, not exhausted.
- Unknown reset time is `↺ ?`. A passed reset deadline is `↺ due`, with the old percentage suppressed until a new query confirms it. It never invents a full allowance.
- Footer shows at most two windows (shared quota preferred), with `+N` when more exist. `/usage` includes model-specific Codex quota domains.
- Unsupported providers produce no footer. Errors/loading never display old provider values.

## Try without installing

```bash
pi -e /Users/astrosheep/Developer/pi-quota-usage/src/index.ts
```

For an isolated test without other extensions:

```bash
pi --no-extensions -e /Users/astrosheep/Developer/pi-quota-usage/src/index.ts
```

Select Codex, Kimi or OpenCode Go with `/model`. Authentication is resolved through Pi's current public `getProviderAuth()` API; login/refresh remain Pi's responsibility.

To install from npm:

```bash
pi install npm:pi-quota-bar
```

For local development:

```bash
pi install /Users/astrosheep/Developer/pi-quota-usage
```

Then `/reload` in Pi. Disable other quota extensions if you do not want duplicate footer elements or suffixed `/usage` commands.

Requires the current `@earendil-works` Pi API (tested against Pi 0.85.1). Older `@mariozechner` distributions are not a tested target.

## Configure a new-api provider

Add `quotaUsage` to the global **`~/.pi/agent/settings.json`** (under `PI_CODING_AGENT_DIR` if overridden):

```json
{
  "providers": {
    "my-new-api": {
      "adapter": "new-api",
      "quotaPerUnit": 500000,
      "currency": "USD",
      "dashboardAccessToken": "<console PAT>",
      "dashboardUserId": 42684
    }
  }
}
```

Replace `my-new-api` with the **exact provider ID in Pi**, then run `/reload`. Multiple provider entries are supported. See `examples/settings.fragment.json`. No site is queried unless it is explicitly configured and selected. Codex/Kimi/OpenCode Go need no config and cannot be overridden here.

Only the global settings namespace is used. Project-local settings are deliberately ignored so a repository cannot redirect globally authenticated credentials to a quota endpoint.

- `adapter`: `new-api` (any new-api/one-api deployment) or `deepseek` (official DeepSeek API, no options).
- `quotaPerUnit` (new-api only): quota units per currency unit; default `500000`. Must be a positive number. Set it to match your site's accounting.
- `currency` (new-api only): uppercase three-letter display currency; default `USD`. This labels the converted units, **not an exchange-rate conversion**.
- `dashboardAccessToken` (new-api only, optional): a console **system access token** (个人设置 → 安全设置 → 系统访问令牌), not an `sk-` API key. When set, `GET {root}/api/user/self` is queried first for the real **account** balance (quota and used_quota), which `sk-` keys cannot read. The token is a secret: this file is local-only and its values are never echoed in errors or logs. Treat it like an API key and rotate it if exposed.
- `dashboardUserId` (new-api only, optional): your numeric user ID, sent as the `New-Api-User` header. Only old new-api forks require it; modern deployments work without it. Never inferred from the API key.
- API key and Base URL come from the selected provider's resolved Pi auth/model config. The optional `dashboardAccessToken` above is the one credential that lives in this file.
- Config is global, strict and read on extension load/reload. Unknown fields, invalid units, unsupported adapters and attempts to override Codex/Kimi/OpenCode Go are rejected. A warning is shown and built-in adapters still work.

The adapter queries with the provider's own API key:

1. **GET `{root}/api/user/self`** (only with `dashboardAccessToken`) — the console's own account quota. Sent with `Authorization: Bearer <PAT>` and, when `dashboardUserId` is set, `New-Api-User: <id>`. Returns `data.quota` (remaining) and `data.used_quota`, both divided by `quotaPerUnit`. Any failure falls through to the key-native paths below, so an expired PAT degrades instead of breaking the bar.

2. **GET `{root}/v1/dashboard/billing/subscription` + `/usage`** (one-api legacy) — `hard_limit_usd - total_usage/100` is the account balance; `total_usage` is in cents. A `hard_limit_usd` of 1e8 means an unlimited quota; then the key quota below may still be finite.

3. **GET `{root}/api/usage/token/`** (new-api ≥ v0.9.0-alpha.8) — designed for API keys: returns the key's own granted/used/remaining quota, used when billing is absent (404), rejects the key (401) or reports an unlimited account. `root` is the base URL without a trailing `/v1`/`/v1beta`:

```text
https://host/v1          -> https://host/api/usage/token/
https://host/gateway/v1  -> https://host/gateway/api/usage/token/
```

`/api/user/self` only accepts a console access token (PAT); an `sk-` API key is rejected with 401 on every tested deployment. Without `dashboardAccessToken` the account balance is not readable and the bar shows the key quota instead.

HTTPS is required, except HTTP loopback (`localhost`, `127.0.0.1`, `::1`) for local deployments. Credentials stay on the configured origin; redirects are rejected. There is no alternate-host setting, cookie scraping, or account-token discovery.

Expected response (step 1):

```json
{"code": true, "data": {"object": "token_usage", "total_used": 28390000, "total_available": 6170000, "unlimited_quota": false}}
```

`total_available / quotaPerUnit` is the balance; `total_used / quotaPerUnit` is the used amount. Raw quota fields must be valid integers. `unlimited_quota: true` shows an unlimited balance with the used amount still listed. These are **key-level amounts** for step 1 and account-level for step 2, not renewable quota limits, so no percentage, bar or reset time is fabricated.

Footer:

```text
Bal $12.34 
```

`/usage` chat item:

```text
my-new-api · Balance

Balance  $12.34
Used     $56.78
```

Positive balances use neutral text, not an arbitrary low-balance threshold; zero/debt is red; unlimited shows `∞`. If the API key cannot read any quota endpoint, HTTP 401/403 is shown as **Account quota access denied**; the extension does not try another credential.

## DeepSeek

With `"adapter": "deepseek"` the official endpoint **GET `https://api.deepseek.com/user/balance`** is queried with the provider's own key. Response amounts are strings in the account currency (e.g. CNY): `total_balance` is shown as the balance. The endpoint exposes no usage total, so `Used` shows 0.00. The provider's base URL must stay on `api.deepseek.com`.

## OpenCode Go

`opencode-go` needs no configuration. The provider's own key is sent to the official endpoint **GET `https://opencode.ai/zen/go/v1/usage`**, which reports three fixed windows as **used** percentages:

```json
{"usage":{"rolling":{"status":"ok","percent":10,"resetsAt":"2026-09-22T18:52:04.287Z"},
          "weekly":{"status":"ok","percent":4,"resetsAt":"2026-09-28T00:00:00.000Z"},
          "monthly":{"status":"ok","percent":2,"resetsAt":"2026-10-22T13:32:00.000Z"}}}
```

Shown as `5h` / `1w` / `30d`, with remaining = `100 - percent`. Only the undecorated keys `percent` and `resetsAt` are read: this is a single official deployment, so no alias guessing. Missing or malformed percentages stay unknown. The endpoint returns no money amounts — the OpenCode console is the only place a dollar balance is visible — and the call itself does not consume Go plan usage. The provider's base URL must stay on `opencode.ai`.

## Architecture

```text
Pi model/auth ──► adapter registry ──► Codex / Kimi / OpenCode Go / custom query
                                           │
                                  QuotaSnapshot (plain data)
                                           │
                              QuotaController (refresh/state)
                                           │
                          ┌────────────────┼─────────────────┐
                     quotaElement      /usage view     structured event
                          │
                   renderBar([...])
```

- `src/query/types.ts`: stable, UI-free adapter/data contracts.
- `src/query/codex.ts`, `kimi.ts`, `opencode-go.ts`, `new-api.ts`: provider-specific auth, endpoints and parsing. No terminal/Pi imports.
- `src/config.ts`: strict `settings.json` provider-to-adapter configuration loading.
- `src/bar/balance.ts`: amount-only rendering, independent of periodic quota gauges.
- `src/query/http.ts`: injectable GET transport, no redirects, bounded response size, safe error codes.
- `src/query/registry.ts`: exact provider matching, duplicate detection, output validation.
- `src/query/controller.ts`: cancellable state machine, deadlines, request coalescing, backoff, stale-result rejection. No rendering or Pi imports.
- `src/bar/bar.ts`: generic elements/spans, Unicode gauges, color roles and composition.
- `src/bar/quota.ts`: converts state into a quota element or detail lines. No I/O.
- `src/bar/card.ts`: captures an independent snapshot and renders a width-aware chat item.
- `src/extension.ts`: the only Pi integration layer; lifecycle, auth bridge, status, custom entry registration.

Normal queries run at most once per 60 seconds. A local 10-second tick updates countdowns and picks up theme changes without forcing an HTTP request. Turn-end checks respect that query interval. Errors back off exponentially; HTTP 429 honors `Retry-After`. Manual refresh explicitly bypasses the interval/backoff.

Switching models clears values synchronously and aborts the old request. A generation check also discards late results from noncooperative adapters. Query deadlines include authentication. Shutdown/reload cleans up timers and pending work. No background resources start in the factory or print mode.

## Add a custom provider

Implement `QuotaAdapter` and supply it to `createQuotaExtension({ adapters: [...] })`. See **`examples/custom-provider.ts`** for a complete, deliberately nonfunctional template. Replace its provider ID, endpoint and response mapping, then load that entry **instead of** `src/index.ts`.

An adapter receives:

```ts
interface QueryContext {
  provider: string;
  signal: AbortSignal;
  now(): number;
  getAuth(provider: string): Promise<ProviderAuth | undefined>;
  getJson(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown>;
}
```

Return normalized windows with an ID, short English label, duration, remaining percentage (`null` when unknown) and reset timestamp (`null` when unknown). Amount-only adapters may instead return `windows: []` plus `balance: { currency, remaining, used }`. A snapshot must contain windows, a valid balance, or both. Pass the signal into I/O. Throw `QuotaError` with a safe code. Never include credentials in results, IDs, labels or errors.

Custom provider names are **not automatically treated as aliases for Codex or Kimi**: a gateway may have different credentials and a different quota system. No URL is inferred from model names or arbitrary response fields.

## Compose a larger bar

The quota is one element, not an owner of the entire footer:

```ts
import { renderBar } from './src/bar/bar.ts';
import { quotaElement } from './src/bar/quota.ts';

const text = renderBar([
  { id: 'context', spans: [{ text: 'ctx [▃] 32%', tone: 'dim' }] },
  quotaElement(state),
  { id: 'git', spans: [{ text: 'main', tone: 'dim' }] },
], (tone, text) => ctx.ui.theme.fg(tone, text));
```

The context and git values above are examples, not built-in live collectors. This extension only calls `setStatus`; it never replaces Pi's footer or hides other extensions.

For a future independent bar extension, use `createQuotaExtension({ footer: false })` and subscribe to **`quota-bar:state:v1`** on `pi.events`. It publishes `QuotaState` on selection/query/shutdown changes, with no credentials or precolored text. Subscribe before session startup for the initial state; unsubscribe on shutdown. The consumer owns its local countdown rendering.

## Safety and limits

- Codex/Kimi/OpenCode Go adapters send credentials only to their fixed official origins. They reject custom auth/model base URLs rather than pretending a gateway credential is an official subscription.
- Codex account routing comes from the active Authorization header/JWT (or its explicit runtime account header), never another CLI's auth file. JWT decoding only extracts metadata; server-side authentication verifies the token.
- No browser-cookie scraping, credential logging, background quota disk cache, model calls, request rewriting, or quota-reset redemption. Explicit `/usage` snapshots persist sanitized quota data in the session; no raw API responses or credentials are stored.
- The default HTTP client uses Node `fetch`; it does not configure its own proxy. It inherits the process's fetch/dispatcher setup. Custom networking can be injected into the standalone controller/client.
- Official quota APIs are undocumented and may change. Malformed/absent counts remain unknown or produce a schema error, never fabricated 100%.
- This covers percentage quota windows and new-api account balances, not Codex credit balances/spend-cap management or Kimi booster wallets.
- Mocked protocol/lifecycle tests pass. Live verification covers the OpenCode Go usage endpoint and the new-api dashboard-PAT `/api/user/self` path.

## Development

Node >=22.18 is needed to run the TypeScript tests directly.

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run demo
NO_COLOR=1 npm run demo
```

Pi supplies the runtime peer packages. This checkout uses local symlinks to the installed Pi 0.85.1 peers for development typechecking; they are not part of the package source.

Tests cover parsing, missing data, credential selection, fixed destinations, response bounds, deadlines, Retry-After/backoff, rapid switching, shutdown, custom adapters, exact footer spacing, colors, snapshot persistence, stale-command cancellation and narrow chat-item rendering.

Protocol references: [pi-quotas](https://github.com/latentminds-ai/pi-quotas), [pi-usage-meter](https://github.com/rock3r/pi-usage-meter), and the installed Pi 0.85.1 extension/TUI documentation. This project has its own query/state/render implementation; neither reference plugin is installed as a dependency.
