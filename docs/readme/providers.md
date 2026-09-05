[← Back to README](../../README.md)

# Providers

## On this page

| Find                                 | Go to                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider support                     | [Pre-configured providers](#pre-configured-providers) · [Custom providers](#custom-providers)                                                                                                                         |
| Billing, API key, or dashboard setup | [GitHub Copilot](#github-copilot) · [DeepSeek](#deepseek) · [Kilo Gateway](#kilo-gateway) · [Xiaomi MiMo](#xiaomi-mimo) · [Ollama Cloud](#ollama-cloud) · [OpenCode Go](#opencode-go) · [OpenCode Zen](#opencode-zen) |
| CLI or companion-plugin setup        | [Anthropic](#anthropic-claude) · [Cursor](#cursor) · [Qwen Code](#qwen-code) · [Google Antigravity](#google-antigravity) · [Google AGY](#google-agy-quick-setup) · [Gemini CLI (deprecated)](#gemini-cli)             |

## Pre-configured providers

Most providers work automatically. `Automatic` means OpenCode Quota reuses the credential saved through OpenCode's `/connect`. If a provider has a “Needs setup” link, open that setup note only if you use that provider. Providers can appear in both audience sections when the vendor supports both.

### American providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider           | Auth/setup                             | Data from          | Reports            |
| ------------------ | -------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude) | [Needs setup](#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI          | Automatic                              | Remote API         | Quota              |
| Cursor             | [Needs setup](#cursor)                 | Local estimate     | Budget and spend   |
| GitHub Copilot     | Automatic                              | Remote API         | Budget and usage   |
| Google AGY         | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| Google Antigravity | [Needs setup](#google-antigravity)     | Remote API         | Quota              |
| Kilo Gateway       | Automatic                              | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                              | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                              | Remote API         | Quota and usage    |
| OpenAI             | Automatic                              | Remote API         | Quota              |
| OpenCode Go        | Automatic                              | Remote API         | Quota              |
| OpenCode Zen       | [Needs setup](#opencode-zen)           | Dashboard scraping | Budget and balance |
| OpenRouter         | Automatic                              | Remote API         | Budget and spend   |
| Synthetic          | Automatic                              | Remote API         | Quota              |
| xAI                | Automatic                              | Remote API         | Quota              |

</details>

<details>
<summary><strong>Business / Enterprise</strong></summary>

| Provider                | Auth/setup                             | Data from          | Reports            |
| ----------------------- | -------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)      | [Needs setup](#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI               | Automatic                              | Remote API         | Quota              |
| Cursor                  | [Needs setup](#cursor)                 | Local estimate     | Budget and spend   |
| Gemini CLI (deprecated) | [Existing setups only](#gemini-cli)    | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| Google Antigravity      | [Needs setup](#google-antigravity)     | Remote API         | Quota              |
| NanoGPT                 | Automatic                              | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                              | Remote API         | Quota              |
| OpenCode Zen            | [Needs setup](#opencode-zen)           | Dashboard scraping | Budget and balance |
| OpenRouter              | Automatic                              | Remote API         | Budget and spend   |
| Synthetic               | Automatic                              | Remote API         | Quota              |
| xAI                     | Automatic                              | Remote API         | Quota              |

Business placement describes vendor plan availability. Except for configured Copilot organization/enterprise billing, current integrations generally report one signed-in account, seat, API key, or workspace.

</details>

### Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                 | Auth/setup                  | Data from      | Reports            |
| ------------------------ | --------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan      | Automatic                   | Local estimate | Quota              |
| DeepSeek                 | Automatic                   | Remote API     | Balance and status |
| Kimi Code                | Automatic                   | Remote API     | Quota              |
| MiniMax Coding Plan      | Automatic                   | Remote API     | Quota              |
| MiniMax Coding Plan (CN) | Automatic                   | Remote API     | Quota              |
| Qwen Code                | [Needs setup](#qwen-code)   | Local estimate | Quota              |
| Xiaomi MiMo              | [Needs setup](#xiaomi-mimo) | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan         | Automatic                   | Remote API     | Quota              |
| Zhipu Coding Plan        | Automatic                   | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| MiniMax Coding Plan      | Automatic  | Remote API | Quota   |
| MiniMax Coding Plan (CN) | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These vendors offer team or business plans, but the current integrations report only the configured member API key rather than organization-wide usage.

</details>

The friendly `Quota` label covers quota and rate-limit windows; JSON distinguishes them.

### Rich accounting rows

OpenCode Zen, NanoGPT, Xiaomi MiMo, Kilo Gateway, DeepSeek, and Cursor use provider-neutral accounting rows. Quota, rate limit, budget, usage, spend, remaining credits, and account balance stay separate: a balance is not remaining allowance, and spend is not a budget percentage.

Root `accountingDetail` defaults to `"summary"`. Set it to `"detailed"` to admit supplementary balance/status/spend rows and fuller percentage basis where the surface has room. `formatStyle` still controls window selection, while `percentDisplayMode` controls used-versus-remaining percentage direction. Narrow and compact surfaces may omit lower-priority detail.

Structured currency rows use explicit uppercase codes such as `USD 12.50` or `CNY 8.25`. OpenCode Quota does not convert, combine, or choose a preferred currency.

xAI reads OpenCode's existing xAI OAuth login and reports its single Weekly quota window. The credits endpoint remains authoritative for quota; a best-effort subscriptions lookup labels recognized plans as xAI Lite, xAI SuperGrok, or xAI Heavy. If subscription metadata is unavailable or unrecognized, the quota remains visible under the xAI SuperGrok label.

OpenRouter reads the existing OpenCode API key and calls OpenRouter's current-key endpoint. Limited keys show used budget and the remaining percentage; unlimited keys show spend. It does not invent a reset time.

## Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status.

Run the guided setup:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It asks only how the provider works, previews the exact global config change, and asks before writing. It does not ask for a response body, credential, or secret value.

A custom provider can use:

- **Remote API:** real quota data from a supported endpoint.
- **Local estimate:** request counts and optional spend estimates from OpenCode's local data.

Definitions run automatically when provider selection is set to `auto`. If you choose providers manually, the list must include `quota-providers` plus every built-in provider you still want.

OpenRouter is built in. A custom OpenRouter definition is still useful when you need a different endpoint or display label.

See [Configuration](configuration.md#custom-providers) for a complete config example.

<details>
<summary><strong>Remote API response rules</strong></summary>

`mode: "remote-api"` accepts three formats:

- `quota-v1` reads the standard OpenCode Quota envelope.
- `json-v1` maps fields from a strict JSON response through a declarative adapter.
- `openrouter-key-v1` reads OpenRouter's key response.

A `quota-v1` response looks like this:

```json
{
  "version": "quota-v1",
  "entries": [
    {
      "kind": "percent",
      "name": "Requests",
      "resultType": "quota",
      "percentRemaining": 42,
      "label": "Daily:",
      "right": "58/100"
    },
    {
      "kind": "value",
      "name": "Spend",
      "resultType": "spend",
      "value": "$12.50"
    }
  ]
}
```

For `json-v1`, the guided command builds the existing adapter schema one field at a time. It asks for literal property segments, compatible metric sources, and optional units and timestamps. This persisted-config example maps `remaining`, `limit`, and `status` fields from one response object:

```json
{
  "mappings": [
    {
      "resultType": "quota",
      "name": "Requests",
      "label": "Daily:",
      "unit": "requests",
      "unitPosition": "suffix",
      "metric": {
        "type": "remaining-limit",
        "remaining": { "path": ["remaining"] },
        "limit": { "path": ["limit"] }
      }
    },
    {
      "resultType": "status",
      "name": "Status",
      "metric": {
        "type": "status",
        "value": { "path": ["status"] }
      }
    }
  ]
}
```

Adapter rules:

- An adapter has an optional `rowsPath` and 1–16 `mappings`. Without `rowsPath`, an object is one row and an array contains the rows. Selected arrays contain 1–100 rows, responses allow at most 32 container levels, and at most 1,600 row/mapping candidates are evaluated.
- Paths contain 1–8 literal own-property segments of 1–64 Unicode code points. Dots and brackets have no special meaning; array indexes and the exact segments `__proto__`, `prototype`, and `constructor` are rejected.
- Adapter input is limited to 8 container levels, 128 objects, 384 object properties, and 640 array elements. Static names and labels contain 1–80 code points, units 1–32, and status/display output at most 160; a provider-prefixed entry name also cannot exceed 160.
- Metric types are `percentage`, `used-limit`, `remaining-limit`, `spend-budget`, `remaining-budget`, `value`, and `status`. Calculations are fixed; formulas and fallback parsing are not supported.
- Numeric sources use exactly one `path` or `literal`, must be finite with absolute magnitude at most `1e15`, and distinguish zero from missing or `null`. Path sources may use `divideBy` with `100`, `1000`, or `1000000`.
- Timestamp sources require `iso-8601`, `unix-seconds`, or `unix-milliseconds`. ISO input requires a time zone, allows 1–3 fractional digits and offsets through `±14:00`, and every normalized instant must fall within years 1970–9999. Accepted timestamps are emitted as canonical UTC ISO strings.
- A bad mapping candidate is reported with fixed, redacted diagnostics while other valid candidates remain visible. At most 16 detailed errors plus one omission summary are retained. An adapter may produce at most 100 successful entries; producing a 101st rejects the response.

Metric compatibility and fixed output:

| `metric.type`      | Allowed `resultType`            | Percent or value output                                    |
| ------------------ | ------------------------------- | ---------------------------------------------------------- |
| `percentage`       | `quota`, `rate_limit`, `budget` | remaining: `percentage`; used: `100 - percentage`          |
| `used-limit`       | `quota`, `rate_limit`           | `(limit - used) / limit * 100`; right side is `used/limit` |
| `remaining-limit`  | `quota`, `rate_limit`           | `remaining / limit * 100`; right side is `remaining/limit` |
| `spend-budget`     | `budget`                        | `(budget - spend) / budget * 100`; right is `spend/budget` |
| `remaining-budget` | `budget`                        | `remaining / budget * 100`; right is `remaining/budget`    |
| `value`            | Determined by `valueType`       | The selected numeric value                                 |
| `status`           | `status`                        | The selected bounded text value                            |

For `metric.type: "value"`:

| `valueType` | Allowed `resultType`           | Negative values |
| ----------- | ------------------------------ | --------------- |
| `used`      | `quota`, `rate_limit`, `usage` | Rejected        |
| `limit`     | `quota`, `rate_limit`          | Rejected        |
| `remaining` | `quota`, `rate_limit`          | Allowed         |
| `balance`   | `balance`                      | Allowed         |
| `spend`     | `spend`                        | Rejected        |
| `budget`    | `budget`                       | Rejected        |

Pair denominators (`limit` and pair-form `budget`) must be greater than zero. Remaining values cannot exceed their denominator; used and spend may exceed it, so the calculated remaining percentage may be negative. A direct remaining percentage may be negative but cannot exceed 100; a direct used percentage must be non-negative and may exceed 100. Values are never clamped.

`unit` and `unitPosition` must appear together. Units are forbidden for `percentage` and `status`; prefix units render like `$2/$10`, while suffix units render like `2/10 tokens`.

**Never put secrets in adapter display configuration.** Static `name`, `label`, and `unit` fields and every `literal` can appear in the provider-add preview, written configuration, cache identity, rendered quota rows, or exports.

OpenCode Quota sends a fixed authenticated `GET`. The URL must use HTTPS, except for loopback testing. Redirects and URLs containing credentials, queries, or fragments are rejected. Responses must be JSON and are limited to 256 KiB. Standard envelopes and selected `json-v1` row arrays are limited to 100 rows.

</details>

<details>
<summary><strong>Local estimate rules</strong></summary>

`mode: "local-estimate"` counts matching completed OpenCode assistant requests. Each definition can have 1–16 windows.

- `utc-day` resets at UTC midnight.
- `rolling` uses `durationMinutes` and can be at most 366 days.
- Every window needs `requestLimit`.
- `usdBudget` is optional.

OpenCode Quota tries models.dev pricing first. Use `pricingModelMap` only when automatic matching cannot find one clear model. If any request cannot be priced, request counts remain visible and the budget percentage is unavailable.

State files live under `~/.local/state/opencode/opencode-quota/quota-providers/`.

</details>

<details>
<summary><strong>Credentials and safety</strong></summary>

Credentials are checked in this order:

1. The environment variable named by `apiKeyEnv`.
2. Trusted global `provider.<providerId>.options.apiKey`.
3. An API-key entry in OpenCode `opencode.db`.

Project secrets are never read. Custom definitions cannot add scripts, methods, headers, templates, executable mappings, regular expressions, JSONPath, or automatic endpoint discovery.

`modelIds` only filters `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for the provider.

To tune Qwen Code or Alibaba Coding Plan, use its reserved `qwen-code` or `alibaba-coding-plan` ID and maintained window shape. Do not add a duplicate normal provider block.

A custom model provider still needs its normal OpenCode provider/model config. `/connect` → **Other** stores its credential, not its model setup.

`/quota_status` shows safe setup details and state paths without showing URLs, keys, headers, response bodies, counter contents, or raw errors.

</details>

## Provider setup notes

<a id="github-copilot"></a>

### GitHub Copilot

Personal quota works automatically from your OpenCode-managed Copilot OAuth login. GitHub.com uses `api.github.com`; a GHE.com login uses the trusted `enterpriseUrl` stored with that OAuth credential and calls `api.<enterprise-host>`.

Organization and enterprise billing reports need a separate token with billing access. Create `copilot-quota-token.json` in the OpenCode config directory shown by:

```bash
opencode debug paths
```

For a personal Copilot Max plan:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "max",
  "username": "your-github-login"
}
```

Use a fine-grained personal access token with **Plan: read**. Supported tiers are `free`, `student`, `pro`, `pro+`, `max`, `business`, and `enterprise`. A configured PAT is authoritative and never falls back to or borrows the hostname from OpenCode OAuth.

<details>
<summary><strong>Organization and enterprise setup</strong></summary>

Choose the setup that matches who pays for Copilot:

| Billing scope | Required config                                         | Token permission                                                                        |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Personal      | `tier` and optional `username`                          | Fine-grained PAT with **Plan: read**, GitHub App user token, or supported classic token |
| Organization  | `tier: "business"`, `organization`, optional `username` | **Organization administration: read**; user, installation, or authorized classic token  |
| Enterprise    | `tier: "enterprise"`, `enterprise`, optional filters    | Classic PAT held by an enterprise admin or billing manager                              |

Organization example:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "business",
  "organization": "your-org",
  "username": "optional-user-filter",
  "enterpriseUrl": "your-company.ghe.com"
}
```

Omit `enterpriseUrl` for GitHub.com. For GHE.com, use only the enterprise hostname or a host-only HTTPS URL such as `https://your-company.ghe.com`. Paths, queries, fragments, ports, userinfo, wildcards, `api.` prefixes, IP/localhost values, HTTP URLs, and non-`.ghe.com` domains are rejected before any request.

Enterprise example:

```json
{
  "token": "ghp_REPLACE_ME",
  "tier": "enterprise",
  "enterprise": "your-enterprise",
  "organization": "optional-org-filter",
  "username": "optional-user-filter",
  "enterpriseUrl": "your-company.ghe.com"
}
```

GitHub does not allow fine-grained PATs or GitHub App tokens for enterprise billing reports.

</details>

<details>
<summary><strong>What Copilot reports</strong></summary>

OpenCode OAuth uses GitHub's undocumented internal `premium_interactions` snapshot. OpenCode Quota labels that source neutrally as **Copilot Premium Interactions** instead of assuming it is the same unit as public AI Credit billing. GitHub supplies the entitlement, remaining amount, optional percentage, unlimited state, and reset; the displayed used amount is calculated from entitlement minus remaining, and a percentage is calculated only when the snapshot omits one.

A personal PAT reads GitHub's public billing report for the current UTC calendar month. That API reports accounting usage, not a plan entitlement, remaining quota, or reset. Personal PAT output is therefore usage-only—for example, `Used 100 | Included 80 | Billed 20 ($0.20)`—with no locally supplied allowance, remaining percentage, or reset.

Organization and enterprise PAT reports use the same used/included/billed accounting fields at the configured payer scope. When GitHub returns an additional-usage budget, it appears as a separate **Copilot Additional Usage** row; its percentage compares billed spend with that budget and is not an included-credit allowance.

Token-based OAuth placeholder responses show the plan only. They do not invent usage, a denominator, or a percentage. A PAT report without a percentage is also expected and does not indicate missing data.

</details>

<details>
<summary><strong>Older annual Pro and Pro+ plans</strong></summary>

Use legacy premium requests only if an existing annual Pro or Pro+ plan stayed on request-based billing after June 1, 2026:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "pro+",
  "billingModel": "legacy_premium_requests",
  "username": "your-github-login"
}
```

Legacy premium-request totals come from the configured eligible tier. Their remaining percentage and next-month reset are local calculations, not fields returned by GitHub.

</details>

Official references: [AI Credit billing reports](https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10), [billing budgets](https://docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10), [GHE.com REST hostnames](https://docs.github.com/en/enterprise-cloud@latest/rest/meta/meta), [individual AI Credit allowances](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals), [organization and enterprise pools](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises), and [legacy annual plans](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing).
<a id="anthropic-claude"></a>

### Anthropic (Claude)

OpenCode's existing Anthropic OAuth credential is sufficient; a separate Claude Code installation is not required. To use Claude Code as the local quota source and credential fallback, install it, authenticate it, and make sure `claude` is on your `PATH`:

```bash
claude auth login
claude auth status
```

If Claude lives at a custom path, set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`.

When Claude Code does not expose quota windows itself, quota is read from Anthropic's OAuth usage endpoint using the first usable access token: OpenCode's own `anthropic` OAuth credential from `opencode.db`, then Claude Code's credentials. `/quota_status` reports which store answered as `oauth_credential_source`.

<a id="cursor"></a>

### Cursor

Use companion plugin [`@playwo/opencode-cursor-oauth`](https://github.com/PoolPirate/opencode-cursor#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate once:

```bash
opencode auth login --provider cursor
```

Cursor estimates the current local billing cycle from OpenCode history. With complete model coverage and a positive configured/preset allowance, it shows an **API budget** percentage with used, limit, and remaining USD facts. If any Cursor model is unknown, it shows only **Known API spend** plus a partial-data issue; it never presents that partial spend as total account spend or a percentage. Without an allowance it shows **API spend**. **Auto+Composer spend** is supplementary and appears in detailed output when space allows.

<a id="qwen-code"></a>

### Qwen Code

Use companion plugin [`opencode-qwencode-auth`](https://github.com/gustavodiasdev/opencode-qwencode-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.

OpenCode Quota's Google integrations use independent community companion plugins. They are not endorsed by Google.

<a id="google-antigravity"></a>

### Google Antigravity

Use companion plugin [`opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.

<a id="google-agy-quick-setup"></a>

### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://github.com/anthonyhaussman/opencode-agy-auth). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

Google AGY reports the companion's grouped weekly and five-hour quota windows for each account.

```bash
opencode auth login --provider google-agy
```

If you use manual provider selection, include `google-agy` in `enabledProviders`.

```jsonc
{
  "enabledProviders": ["google-agy"],
}
```

If the AGY auth entry does not include a project id, set `OPENCODE_AGY_PROJECT_ID` or `provider.google-agy.options.projectId`.

```jsonc
{
  "provider": {
    "google-agy": {
      "options": {
        "projectId": "your-google-cloud-project",
      },
    },
  },
}
```

<a id="gemini-cli"></a>

### Gemini CLI (deprecated)

**Deprecated in v4.1:** Existing configurations, aliases, companion detection, authentication, and quota fetching continue to work unchanged. Do not use this provider for a new install. Removal is planned for v5.0.0, and OpenCode Quota does not switch providers or authentication automatically.

Google's official Antigravity CLI replaces the individual Gemini CLI experience. Google AI Studio or Vertex AI are the supported choices for third-party access. Within OpenCode Quota, `google-agy` is the suggested successor for quota reporting; this is an OpenCode Quota recommendation, not a Google endorsement.

The instructions below remain available only to maintain an existing setup.

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

```bash
opencode auth login --provider google
```

If you use manual provider selection, include `google-gemini-cli` in `enabledProviders`.

<a id="deepseek"></a>

### DeepSeek

DeepSeek reads the current on-demand account balance from `GET https://api.deepseek.com/user/balance`. Summary shows each valid provider-reported **Total balance** as its own currency row. Detailed output can also show **Granted balance** and **Topped-up balance** for that currency. Currencies are never summed or converted. If no valid total balance exists, the provider shows the API's availability state instead; malformed individual decimals produce a partial-data issue rather than becoming zero.

Use one of these trusted API-key sources:

```bash
export DEEPSEEK_API_KEY="your-api-key"
```

Or put the key in trusted user/global OpenCode config, not repo-local config:

```jsonc
{
  "provider": {
    "deepseek": {
      "options": { "apiKey": "{env:DEEPSEEK_API_KEY}" },
    },
  },
}
```

If you use manual provider selection, include `deepseek` in `enabledProviders`.

<a id="nanogpt"></a>

### NanoGPT

NanoGPT reports provider-supplied **Daily quota** and **Monthly quota** percentages with available used, limit, and remaining request facts. Its current balance is a separate primary row: USD is used when available, otherwise a valid NANO balance is shown. USD and NANO are never combined. Subscription and balance requests can succeed independently, so valid rows remain visible with a partial-data issue when another endpoint fails.

<a id="kilo-gateway"></a>

### Kilo Gateway

Kilo Gateway checks the authenticated `kiloPass.getState` tRPC endpoint first. An active pass with positive total credits shows one **Credits** percentage with used, limit, and remaining USD facts plus the provider reset when available; it does not add a duplicate remaining-credits row. A zero-credit active pass shows one **Remaining credits** USD value and preserves the reset.

If the account has no active Kilo Pass, OpenCode Quota falls back to one provider-reported **Total balance** USD row. This balance-only path does not invent usage, quota percentages, or reset times. Base, usage, bonus, remaining, overage, and reset source values stay available in `/quota_status` and curated JSON `rawDetails`.

Create a Kilo Gateway API key in your personal profile, then set:

```bash
export KILO_API_KEY="your-api-key"
```

Credentials resolve in this order:

1. `KILO_API_KEY`
2. Trusted user/global OpenCode config: `provider.kilo.options.apiKey`
3. A strict `kilo` API-key entry in OpenCode `opencode.db`: `{ "type": "api", "key": "..." }`

Project-local `opencode.json` and `opencode.jsonc` files are not read for this secret. The canonical OpenCode provider ID is `kilo`; if you use manual provider selection, include `kilo` in `enabledProviders`.

<a id="xiaomi-mimo"></a>

### Xiaomi MiMo

Xiaomi MiMo reads the signed-in dashboard API for one provider-reported **Monthly quota** with used/limit token facts plus optional **Total balance**, **Cash balance**, and **Gift balance** rows. Total balance is primary; cash and gift are supplementary and appear in detailed output when space allows. A valid provider currency code is preserved. When the provider supplies no currency, amounts are credits rather than an invented currency.

Use exactly one trusted credential source. The environment variable has priority:

```bash
export MIMO_USAGE_COOKIE='api-platform_serviceToken=...; userId=...'
```

Or create the trusted user/global OpenCode runtime file `opencode-quota/mimo.json` (commonly `~/.config/opencode/opencode-quota/mimo.json`):

```json
{
  "cookie": "api-platform_serviceToken=...; userId=..."
}
```

Do not put this credential in a repository or workspace config. A present invalid environment value or higher-priority `mimo.json` blocks lower-priority files instead of falling back.

The value may start with `Cookie:`. OpenCode Quota rejects line breaks, requires `api-platform_serviceToken` and `userId`, keeps optional `api-platform_ph` and `api-platform_slh`, and removes every other cookie before requests.

To copy the value manually:

1. Sign in at `platform.xiaomimimo.com`.
2. Open the browser Developer Tools, then **Network**.
3. Refresh the dashboard and select the `/api/v1/balance` request.
4. Copy its **Request Headers → Cookie** value into the environment variable or trusted file above.

The confirmed OpenCode provider IDs are `xiaomi`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, and `xiaomi-token-plan-sgp`. In manual provider mode, put canonical `xiaomi` in `enabledProviders`.

Plan name/code only enrich the display. An explicitly expired plan does not appear active, and `currentPeriodEnd` is not treated as a quota reset. The three fixed dashboard requests are independent, so available quota or balance data still appears when another request fails.

Per-API-key costs remain unsupported until Xiaomi exposes endpoint and schema evidence for that accounting.

<a id="ollama-cloud"></a>

### Ollama Cloud

Ollama Cloud calls `https://ollama.com/api/usage` and reports session and weekly quota plus per-model request counts. Create an Ollama API key, then set:

```bash
export OLLAMA_API_KEY="your-api-key"
```

Credentials resolve in this order:

1. `OLLAMA_API_KEY`
2. Trusted user/global OpenCode config: `provider.ollama-cloud.options.apiKey`
3. A strict `ollama-cloud` API-key entry in OpenCode `opencode.db`: `{ "type": "api", "key": "..." }`

Project-local `opencode.json` and `opencode.jsonc` files are not read for this secret. The old `OLLAMA_USAGE_COOKIE`, `ollama-cloud.json`, and `ollama-usage/config.yaml` cookie setup is no longer supported.

<a id="opencode-go"></a>

### OpenCode Go

OpenCode Go reads subscription quota from the official `https://opencode.ai/zen/go/v1/usage` API. OpenCode Quota automatically resolves the API key in this order:

1. `OPENCODE_API_KEY`
2. Trusted user/global OpenCode config: `provider.opencode-go.options.apiKey`
3. Trusted user/global fallback: `provider.opencode.options.apiKey`
4. A strict `opencode-go` API-key entry in OpenCode `opencode.db`: `{ "type": "api", "key": "..." }`. This is the key the OpenCode CLI writes via `opencode auth login -p opencode-go`.
5. A strict legacy `opencode` API-key entry in `opencode.db` as the final fallback.

Project-local `opencode.json` and `opencode.jsonc` files are not read for this secret. Use `opencodeGoWindows` to choose which validated API results appear across surfaces and in the expanded sidebar: **Five-hour**, **Weekly**, and/or **Monthly**. To keep those rows expanded but prefer one while the sidebar is collapsed, set `tuiSidebarPanel.opencodeGoPreferredWindow` to `rolling`, `weekly`, or `monthly`; an unset or unavailable preference keeps the lowest-remaining selection. These settings do not change authentication or the API request.

The updater reports obsolete `OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_AUTH_COOKIE`, and global `opencode-quota/opencode-go.json` sources without reading their values or contents. Workspace/cookie material cannot be converted into the official API key. Configure and verify a supported key before removing those sources manually; see [Updating safely](updating.md#opencode-go-findings).

<a id="opencode-zen"></a>

### OpenCode Zen

OpenCode Zen balance scrapes `opencode.ai/workspace/{id}/billing`. Provide its own workspace ID and `auth` cookie via the plugin config file `~/.config/opencode/opencode-quota/opencode.json`:

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie"
}
```

Find both values in your browser: the workspace ID is in the billing-page URL, and the `auth` cookie is under Developer Tools → Storage → Cookies for `opencode.ai`.

> The credentials are read only from this config file. They are not read from
> the `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE` environment variables,
> which collide with the OpenCode client's workspace feature. The updater may
> cautiously report those names when no supported global file exists; review
> [Updating safely](updating.md#opencode-zen-findings) before changing them.

Set `opencodeMonthlyLimit` in `opencode-quota/quota-toast.json` to override the monthly budget from the billing page. With valid monthly usage and a positive page/configured limit, Zen shows a primary **Monthly budget** percentage with used, limit, and locally derived remaining USD facts. The current account balance is separate and supplementary; without a valid budget percentage, that balance becomes the primary row. **Auto-reload** is a supplementary enabled/disabled row. Its raw amount and trigger remain diagnostics because their monetary units are not confirmed.

Use root `accountingDetail: "detailed"` to admit the supplementary balance and auto-reload rows. At runtime, the removed `opencodeZenDisplay` key remains diagnostic-only. The explicit `update` command can migrate recognized file-backed `default` and `detailed` values; unsupported cases remain unchanged for manual review. See [Updating safely](updating.md#what-can-change-automatically).
