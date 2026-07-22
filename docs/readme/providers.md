[← Back to README](../../README.md)

# Providers

## On this page

| Find                                 | Go to                                                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider support                     | [Pre-configured providers](#pre-configured-providers) · [Custom providers](#custom-providers)                                                                                                |
| Billing, API key, or dashboard setup | [GitHub Copilot](#github-copilot) · [DeepSeek](#deepseek) · [Ollama Cloud](#ollama-cloud) · [OpenCode Go](#opencode-go) · [OpenCode Zen](#opencode-zen)                                      |
| CLI or companion-plugin setup        | [Anthropic](#anthropic-claude) · [Cursor](#cursor) · [Qwen Code](#qwen-code) · [Google Antigravity](#google-antigravity) · [Google AGY](#google-agy-quick-setup) · [Gemini CLI](#gemini-cli) |

## Pre-configured providers

Most providers work automatically. If a provider has a “Needs setup” link, open that setup note only if you use that provider.

| Provider                 | Auth/setup                             | Data from          | Reports            |
| ------------------------ | -------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)       | [Needs setup](#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| GitHub Copilot           | [Needs setup](#github-copilot)         | Remote API         | Usage and budget   |
| OpenAI                   | Automatic                              | Remote API         | Quota              |
| Cursor                   | [Needs setup](#cursor)                 | Local estimate     | Budget and spend   |
| Qwen Code                | [Needs setup](#qwen-code)              | Local estimate     | Quota              |
| Alibaba Coding Plan      | OpenCode config                        | Local estimate     | Quota              |
| MiniMax Coding Plan      | OpenCode config                        | Remote API         | Quota              |
| MiniMax Coding Plan (CN) | OpenCode config                        | Remote API         | Quota              |
| Kimi Code                | OpenCode config                        | Remote API         | Quota              |
| Chutes AI                | API key/config                         | Remote API         | Quota              |
| Synthetic                | Automatic                              | Remote API         | Quota              |
| Google Antigravity       | [Needs setup](#google-antigravity)     | Remote API         | Quota              |
| Google AGY               | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| Gemini CLI               | [Needs setup](#gemini-cli)             | Remote API         | Quota              |
| Z.ai Coding Plan         | OpenCode config                        | Remote API         | Quota              |
| Zhipu Coding Plan        | OpenCode config                        | Remote API         | Quota              |
| NanoGPT                  | API key/config                         | Remote API         | Quota and balance  |
| DeepSeek                 | API key/config                         | Remote API         | Balance and status |
| Ollama Cloud             | [Needs setup](#ollama-cloud)           | Dashboard scraping | Quota              |
| OpenCode Go              | [Needs setup](#opencode-go)            | Dashboard scraping | Quota              |
| OpenCode Zen             | [Needs setup](#opencode-zen)           | Dashboard scraping | Budget and balance |

The friendly `Quota` label covers quota and rate-limit windows; v4 JSON distinguishes them.

## Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status.

Run the guided setup:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It asks only how the provider works, previews the exact global config change, and asks before writing. It does not ask for a secret.

A custom provider can use:

- **Remote API:** real quota data from a supported endpoint.
- **Local estimate:** request counts and optional spend estimates from OpenCode's local data.

Definitions run automatically when provider selection is set to `auto`. If you choose providers manually, the list must include `quota-providers` plus every built-in provider you still want.

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

For `json-v1`, the guided command asks for one strict JSON adapter object. This example maps `remaining`, `limit`, and `status` fields from one response object:

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
3. An API-key entry in OpenCode `auth.json`.

Project secrets are never read. Custom definitions cannot add scripts, methods, headers, templates, executable mappings, regular expressions, JSONPath, or automatic endpoint discovery.

`modelIds` only filters `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for the provider.

To tune Qwen Code or Alibaba Coding Plan, use its reserved `qwen-code` or `alibaba-coding-plan` ID and maintained window shape. Do not add a duplicate normal provider block.

A custom model provider still needs its normal OpenCode provider/model config. `/connect` → **Other** stores its credential, not its model setup.

`/quota_status` shows safe setup details and state paths without showing URLs, keys, headers, response bodies, counter contents, or raw errors.

</details>

## Provider setup notes

<a id="github-copilot"></a>

### GitHub Copilot

GitHub's billing API needs a separate token with billing access. Your normal OpenCode Copilot login does not include that permission.

Create `copilot-quota-token.json` in the OpenCode config directory shown by:

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

Use a fine-grained personal access token with **Plan: read**. Supported tiers are `free`, `student`, `pro`, `pro+`, `max`, `business`, and `enterprise`.

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
  "username": "optional-user-filter"
}
```

Enterprise example:

```json
{
  "token": "ghp_REPLACE_ME",
  "tier": "enterprise",
  "enterprise": "your-enterprise",
  "organization": "optional-org-filter",
  "username": "optional-user-filter"
}
```

GitHub does not allow fine-grained PATs or GitHub App tokens for enterprise billing reports.

</details>

<details>
<summary><strong>What Copilot reports</strong></summary>

OpenCode Quota reads the current UTC calendar month. It shows used AI Credits, billed credits, billed spend when available, and organization or enterprise budgets when GitHub returns them.

A percentage appears only when GitHub provides a real allowance or positive budget. Otherwise the plugin shows the value without inventing a percentage.

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

</details>

Official references: [AI Credit billing reports](https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10), [billing budgets](https://docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10), [individual AI Credit allowances](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals), [organization and enterprise pools](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises), and [legacy annual plans](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing).
<a id="anthropic-claude"></a>

### Anthropic (Claude)

Install Claude Code, authenticate it, and make sure `claude` is on your `PATH`:

```bash
claude auth login
claude auth status
```

If Claude lives at a custom path, set `anthropicBinaryPath` in `opencode-quota/quota-toast.json`.

<a id="cursor"></a>

### Cursor

Use companion plugin [`@playwo/opencode-cursor-oauth`](https://github.com/PoolPirate/opencode-cursor#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate once:

```bash
opencode auth login --provider cursor
```

<a id="qwen-code"></a>

### Qwen Code

Use companion plugin [`opencode-qwencode-auth`](https://github.com/gustavodiasdev/opencode-qwencode-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.

<a id="google-antigravity"></a>

### Google Antigravity

Use companion plugin [`opencode-antigravity-auth`](https://github.com/NoeFabris/opencode-antigravity-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`.

<a id="google-agy-quick-setup"></a>

### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://www.npmjs.com/package/@anthonyhaussman/opencode-agy-auth). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

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

### Gemini CLI

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme). Add it before `@slkiser/opencode-quota` in `opencode.json`, then authenticate Google once:

```bash
opencode auth login --provider google
```

If you use manual provider selection, include `google-gemini-cli` in `enabledProviders`.

<a id="deepseek"></a>

### DeepSeek

DeepSeek shows the current on-demand account balance from `GET https://api.deepseek.com/user/balance`.

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

<a id="ollama-cloud"></a>

### Ollama Cloud

Ollama Cloud quota scrapes the Ollama Cloud settings page and needs a `__Secure-session` cookie:

```bash
export OLLAMA_USAGE_COOKIE="your-session-cookie-value"
```

Or use one of these config files (cookie without the `__Secure-session=` prefix, or with — the plugin normalizes it):

- `~/.config/opencode/opencode-quota/ollama-cloud.json`: `{ "cookie": "..." }`
- `~/.config/ollama-usage/config.yaml`: `cookie: "..."`

To find the cookie, open `ollama.com/settings` in your browser, open Developer Tools → Storage → Cookies, and copy the value of `__Secure-session`.

<a id="opencode-go"></a>

### OpenCode Go

OpenCode Go quota scrapes the dashboard and needs a workspace ID plus an `auth` cookie:

```bash
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie"
```

Use `opencodeGoWindows` to choose **5h**, **Weekly**, and/or **Monthly** windows. Environment variables take precedence over the optional `opencode-go.json` file.

<a id="opencode-zen"></a>

### OpenCode Zen

OpenCode Zen balance scrapes `opencode.ai/workspace/{id}/billing`. Set its own workspace ID and `auth` cookie:

```bash
export OPENCODE_WORKSPACE_ID="your-workspace-id"
export OPENCODE_AUTH_COOKIE="your-auth-cookie"
```

Find both values in your browser: the workspace ID is in the billing-page URL, and the `auth` cookie is under Developer Tools → Storage → Cookies for `opencode.ai`.

You can instead create `~/.config/opencode/opencode-quota/opencode.json`:

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie"
}
```

Set `opencodeMonthlyLimit` in `opencode-quota/quota-toast.json` to override the monthly budget from the billing page. Without a monthly limit, the provider shows the current balance only.
