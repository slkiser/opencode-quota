[← Back to README](../../README.md)

# Providers

Jump to: [Pre-configured providers](#pre-configured-providers) · [Custom providers](#custom-providers) · [API keys](#api-keys) · [Setup notes](#provider-setup-notes)

## Pre-configured providers

Most providers work automatically. `Automatic` means OpenCode Quota reuses the login you saved with OpenCode's `/connect`, read through OpenCode 2's plugin API. Open a **Needs setup** link only if you use that provider.

- Several logins for one provider? Each gets its own rows, and `(active)` marks the one OpenCode uses.
- A provider can appear in both audience tables when the vendor sells both.

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
| Kilo Gateway       | Automatic                              | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                              | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                              | Remote API         | Quota and usage    |
| OpenAI             | Automatic                              | Remote API         | Quota              |
| OpenCode Go        | Automatic                              | Remote API         | Quota              |
| OpenCode Zen       | Automatic                              | Remote API         | Budget and balance |
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
| Gemini CLI              | [Needs setup](#gemini-cli)             | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| NanoGPT                 | Automatic                              | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                              | Remote API         | Quota              |
| OpenCode Zen            | Automatic                              | Remote API         | Budget and balance |
| OpenRouter              | Automatic                              | Remote API         | Budget and spend   |
| Synthetic               | Automatic                              | Remote API         | Quota              |
| xAI                     | Automatic                              | Remote API         | Quota              |

These tables show which plans a vendor sells. Except for Copilot organization/enterprise billing, each integration reports one signed-in account, seat, API key, or workspace.

</details>

### Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                      | Auth/setup                                                          | Data from      | Reports            |
| ----------------------------- | ------------------------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan           | Automatic                                                           | Local estimate | Quota              |
| Alibaba Personal Token Plan   | [Needs setup](#alibaba-personal-token-plan)                         | Official CLI   | Quota              |
| DeepSeek                      | Automatic                                                           | Remote API     | Balance and status |
| Kimi Code                     | Automatic                                                           | Remote API     | Quota              |
| Kimi Code (CN)                | Automatic                                                           | Remote API     | Quota              |
| MiniMax Token Plan            | Automatic                                                           | Remote API     | Quota              |
| MiniMax Token Plan (CN)       | Automatic                                                           | Remote API     | Quota              |
| Xiaomi MiMo                   | [Needs setup](#xiaomi-mimo)                                         | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan              | Automatic                                                           | Remote API     | Quota              |
| Zhipu Coding Plan             | Automatic                                                           | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| Kimi Code (CN)           | Automatic  | Remote API | Quota   |
| MiniMax Token Plan       | Automatic  | Remote API | Quota   |
| MiniMax Token Plan (CN)  | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These show only your own member API key's usage, not the whole organization's.

</details>

### How rows are shown

- `Quota` covers quota and rate-limit windows; JSON tells them apart.
- OpenCode Zen, NanoGPT, Xiaomi MiMo, Kilo Gateway, DeepSeek, and Cursor keep quota, rate limit, budget, usage, spend, credits, and balance as separate rows. A balance is not remaining allowance, and spend is not a budget percentage.
- Money uses uppercase currency codes such as `USD 12.50` or `CNY 8.25`. OpenCode Quota never converts, combines, or picks a preferred currency.
- `accountingDetail: "detailed"` adds supplementary balance, status, and spend rows. See [Show accounting detail](configuration.md#show-accounting-detail).
- Which rows can show a **Runs out** estimate: see [Estimate when fixed quota runs out](configuration.md#estimate-when-fixed-quota-runs-out).

## Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status. Run the guided setup:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It asks how the provider works, previews the exact global config change, and asks before writing. It never asks for a response body, credential, or secret value.

- **Remote API:** real quota data from a supported endpoint (formats below).
- **Local estimate:** counts matching completed OpenCode requests in 1–16 windows, with optional spend estimates. `utc-day` resets at UTC midnight; `rolling` uses `durationMinutes` (up to 366 days). Every window needs `requestLimit`; `usdBudget` is optional.
- **Credentials:** the variable named by `apiKeyEnv`, then trusted global `provider.<providerId>.options.apiKey`, then an API-key login saved in OpenCode 2 (`opencode.db`) for that provider id. Project secrets are never read.
- With `enabledProviders: "auto"`, definitions run automatically. A manual list must include `quota-providers` plus every built-in provider you still want.
- A custom model provider still needs its normal OpenCode provider/model config. `/connect` → **Other** stores its credential, not its model setup.
- OpenRouter is built in. A custom OpenRouter definition only helps if you need a different endpoint or label.
- Alibaba Personal Token Plan uses the reserved `alibaba-token-plan` ID and stays a separate official-CLI provider; it is not a local-estimate tuning target.

See [Configuration](configuration.md#custom-providers) for a complete example and the other rules (pricing, state files, what is not allowed).

<details>
<summary><strong>Recipes: Vercel AI Gateway, Moonshot, Poe</strong></summary>

Add the providers you use to `quotaProviders` in `quota-toast.jsonc`, then set the key variable (or use an API-key login saved in OpenCode):

```jsonc
{
  "quotaProviders": [
    {
      // Vercel AI Gateway: team credit balance and total spend, in USD.
      "id": "vercel-credits",
      "providerId": "vercel",
      "label": "Vercel AI Gateway",
      "mode": "remote-api",
      "url": "https://ai-gateway.vercel.sh/v1/credits",
      "format": "json-v1",
      "apiKeyEnv": "AI_GATEWAY_API_KEY",
      "adapter": {
        "mappings": [
          { "resultType": "balance", "name": "Balance", "label": "Balance:", "unit": "USD", "unitPosition": "suffix", "metric": { "type": "value", "valueType": "balance", "value": { "path": ["balance"] } } },
          { "resultType": "spend", "name": "Spend", "label": "Spend:", "unit": "USD", "unitPosition": "suffix", "metric": { "type": "value", "valueType": "spend", "value": { "path": ["total_used"] } } }
        ]
      }
    },
    {
      // Moonshot / Kimi API platform (not Kimi Code, which is built in): available balance, in USD.
      "id": "moonshot-balance",
      "providerId": "moonshotai",
      "label": "Moonshot",
      "mode": "remote-api",
      "url": "https://api.moonshot.ai/v1/users/me/balance",
      "format": "json-v1",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "adapter": {
        "mappings": [
          { "resultType": "balance", "name": "Balance", "label": "Balance:", "unit": "USD", "unitPosition": "suffix", "metric": { "type": "value", "valueType": "balance", "value": { "path": ["data", "available_balance"] } } }
        ]
      }
    },
    {
      // Poe: point balance (points, not money).
      "id": "poe-points",
      "providerId": "poe",
      "label": "Poe",
      "mode": "remote-api",
      "url": "https://api.poe.com/usage/current_balance",
      "format": "json-v1",
      "apiKeyEnv": "POE_API_KEY",
      "adapter": {
        "mappings": [
          { "resultType": "balance", "name": "Points", "label": "Points:", "unit": "points", "unitPosition": "suffix", "metric": { "type": "value", "valueType": "balance", "value": { "path": ["current_point_balance"] } } }
        ]
      }
    }
  ]
}
```

- Provider docs: [Vercel AI Gateway credits](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance), [Moonshot balance](https://platform.kimi.ai/docs/api/balance), [Poe usage API](https://creator.poe.com/docs/resources/usage-api).
- Poe: a Poe sign-in made through OpenCode's OAuth can't be used here. Create a key at [poe.com/api/keys](https://poe.com/api/keys) and set `POE_API_KEY`.
- These recipes follow the providers' docs and weren't tested with a real key; open an issue if one doesn't work.

</details>

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
    { "kind": "percent", "name": "Requests", "resultType": "quota", "percentRemaining": 42, "label": "Daily:", "right": "58/100" },
    { "kind": "value", "name": "Spend", "resultType": "spend", "value": "$12.50" }
  ]
}
```

For `json-v1`, the guided command builds the adapter one field at a time: literal property segments, compatible metric sources, and optional units and timestamps. This saved-config example maps `remaining`, `limit`, and `status` from one response object:

```json
{
  "mappings": [
    {
      "resultType": "quota",
      "name": "Requests",
      "label": "Daily:",
      "unit": "requests",
      "unitPosition": "suffix",
      "metric": { "type": "remaining-limit", "remaining": { "path": ["remaining"] }, "limit": { "path": ["limit"] } }
    },
    { "resultType": "status", "name": "Status", "metric": { "type": "status", "value": { "path": ["status"] } } }
  ]
}
```

Adapter rules:

- **Rows:** optional `rowsPath` and 1–16 `mappings`. Without `rowsPath`, an object is one row and an array holds the rows. Selected arrays hold 1–100 rows, responses allow at most 32 container levels, and at most 1,600 row/mapping candidates are checked.
- **Paths:** 1–8 literal own-property segments of 1–64 Unicode code points. Dots and brackets mean nothing special; array indexes and the segments `__proto__`, `prototype`, and `constructor` are rejected.
- **Size:** adapter input is limited to 8 container levels, 128 objects, 384 object properties, and 640 array elements. Names and labels are 1–80 code points, units 1–32, and status/display output (including a provider-prefixed entry name) at most 160.
- **Metrics:** `percentage`, `used-limit`, `remaining-limit`, `spend-budget`, `remaining-budget`, `value`, and `status`. Calculations are fixed; no formulas or fallback parsing.
- **Numbers:** exactly one `path` or `literal`, finite, with absolute magnitude at most `1e15`. A response may also write a number as text if it is a plain decimal like `"95.50"` or `"-3"` (spaces around it are ignored); other text such as `"95.50 USD"` or `"1e3"` is rejected. Zero is not the same as missing or `null`. Path sources may use `divideBy` with `100`, `1000`, or `1000000`.
- **Timestamps:** `iso-8601`, `unix-seconds`, or `unix-milliseconds`. ISO needs a time zone, allows 1–3 fractional digits and offsets through `±14:00`, and must fall within years 1970–9999. Output is canonical UTC ISO.
- **Errors:** a bad mapping candidate gets a fixed, redacted diagnostic while other valid candidates stay visible. At most 16 detailed errors plus one summary are kept. More than 100 successful entries rejects the response.

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

## API keys

These providers read an API key from, in order: an environment variable, then trusted user/global OpenCode config (`provider.<id>.options.apiKey`), then an API-key login saved in OpenCode 2 (`opencode.db`).

- Project-local `opencode.json` / `opencode.jsonc` is never read for secrets.
- An OpenCode login used as a fallback must be an API-key login, not an OAuth sign-in.
- `provider.<id>.options.apiKey` can also be written in OpenCode 2's native form, `providers.<id>.settings.apiKey`. Like OpenCode 2, a native `providers.<id>` entry replaces the `provider.<id>` entry with the same id.

| Provider                | Environment variables (first match wins)              | Notes |
| ----------------------- | ----------------------------------------------------- | ----- |
| Alibaba Coding Plan     | `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`       | |
| Chutes AI               | `CHUTES_API_KEY`                                       | |
| DeepSeek                | `DEEPSEEK_API_KEY`                                     | See [DeepSeek](#deepseek). |
| Kilo Gateway            | `KILO_API_KEY`                                         | See [Kilo Gateway](#kilo-gateway). |
| Kimi Code / Kimi Code (CN) | See [Kimi Code](#kimi-code)                         | Each region has its own keys. |
| MiniMax Token Plan      | `MINIMAX_CODING_PLAN_API_KEY`, `MINIMAX_API_KEY`       | International endpoint. Runtime/config ids like `minimax` and `minimax-coding-plan` use this provider. |
| MiniMax Token Plan (CN) | `MINIMAX_CHINA_CODING_PLAN_API_KEY`                    | Config under `minimax-china-coding-plan`, `minimax-cn-coding-plan`, `minimax-cn`, or `minimax-china`. Runtime id `minimax-cn-coding-plan` uses this provider. |
| NanoGPT                 | `NANOGPT_API_KEY`, `NANO_GPT_API_KEY`                  | |
| Ollama Cloud            | `OLLAMA_API_KEY`                                       | See [Ollama Cloud](#ollama-cloud). |
| OpenCode Go             | `OPENCODE_API_KEY`                                     | Has its own order; see [OpenCode Go](#opencode-go). |
| OpenRouter              | `OPENROUTER_API_KEY`                                   | See [OpenRouter](#openrouter). |
| Synthetic               | `SYNTHETIC_API_KEY`                                    | |
| Z.ai Coding Plan        | `ZAI_API_KEY`, `ZAI_CODING_PLAN_API_KEY`               | A malformed fallback login shows as an auth error. |
| Zhipu Coding Plan       | `ZHIPU_API_KEY`, `ZHIPU_CODING_PLAN_API_KEY`           | A malformed fallback login shows as an auth error. |

## Provider setup notes

If something below does not work, see [Provider fixes](troubleshooting.md#provider-fixes).

<a id="github-copilot"></a>

### GitHub Copilot

**Personal quota** works automatically from your OpenCode Copilot login. GitHub.com uses `api.github.com`; a GHE.com login uses the `enterpriseUrl` saved with that login and calls `api.<enterprise-host>`.

If Quota shows `<plan> | usage needs billing token`, GitHub reported your plan but no usage for your login. This is normal for Business and Enterprise seats (usage comes from the organization's pool), and it does not mean you are out of credits. Add the token below to see real numbers.

**Organization and enterprise billing** need a separate token with billing access. Create `copilot-quota-token.json` in the OpenCode config folder shown by `opencode debug paths`. Example for a personal Copilot Max plan:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "max",
  "username": "your-github-login"
}
```

- Tiers: `free`, `student`, `pro`, `pro+`, `max`, `business`, and `enterprise`.
- A configured token always wins. It never falls back to, or borrows the host from, your OpenCode login.

<details>
<summary><strong>Organization and enterprise setup</strong></summary>

| Billing scope | Required config                                         | Token permission                                                                        |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Personal      | `tier` and optional `username`                          | Fine-grained PAT with **Plan: read**, GitHub App user token, or supported classic token |
| Organization  | `tier: "business"`, `organization`, optional `username` | **Organization administration: read**; user, installation, or authorized classic token  |
| Enterprise    | `tier: "enterprise"`, `enterprise`, optional filters    | Classic PAT held by an enterprise admin or billing manager                              |

Organization example (for an enterprise, use `"tier": "enterprise"`, add `"enterprise": "your-enterprise"`, and `organization` becomes an optional filter):

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "business",
  "organization": "your-org",
  "username": "optional-user-filter",
  "enterpriseUrl": "your-company.ghe.com"
}
```

- Omit `enterpriseUrl` for GitHub.com. For GHE.com, use only the hostname or a host-only HTTPS URL such as `https://your-company.ghe.com`. Paths, queries, fragments, ports, userinfo, wildcards, `api.` prefixes, IP/localhost values, HTTP URLs, and non-`.ghe.com` domains are rejected before any request.
- GitHub does not allow fine-grained PATs or GitHub App tokens for enterprise billing reports.

</details>

<details>
<summary><strong>What Copilot reports</strong></summary>

- **OpenCode login:** GitHub's undocumented internal `premium_interactions` snapshot, normally labeled **Copilot Premium Interactions** (not assumed to match public AI Credit billing). GitHub supplies the entitlement, remaining amount, optional percentage, unlimited state, and reset. For in-range snapshots, used is derived from entitlement minus remaining; a percentage is calculated only when GitHub omits one. Token-based placeholder responses show the plan only.
- **Token-based billing over limit:** once token-based billing usage passes the entitlement, GitHub reports a negative remaining amount plus a GitHub-reported `credits_used` AI-credit usage total. OpenCode shows that reported total; if it is missing or invalid, usage falls back to entitlement minus remaining and is marked locally derived. The remaining percentage stays provider-reported and does not exceed 100% when over limit.
- **Personal token:** GitHub's public billing report for the current UTC calendar month. It is usage only, for example `Used 100 | Included 80 | Billed 20 ($0.20)`, with no allowance, remaining percentage, or reset. A missing percentage is expected.
- **Organization and enterprise tokens:** the same used/included/billed fields for that payer. If GitHub returns an additional-usage budget, it shows as a separate **Copilot Additional Usage** row comparing billed spend with that budget.

</details>

<details>
<summary><strong>Older annual Pro and Pro+ plans</strong></summary>

Only if an existing annual Pro or Pro+ plan stayed on request-based billing after June 1, 2026:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "pro+",
  "billingModel": "legacy_premium_requests",
  "username": "your-github-login"
}
```

Totals come from the configured tier. The remaining percentage and next-month reset are calculated locally, not returned by GitHub.

</details>

GitHub references: [AI Credit billing reports](https://docs.github.com/en/rest/billing/usage?apiVersion=2026-03-10), [billing budgets](https://docs.github.com/en/rest/billing/budgets?apiVersion=2026-03-10), [GHE.com REST hostnames](https://docs.github.com/en/enterprise-cloud@latest/rest/meta/meta), [individual AI Credit allowances](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals), [organization and enterprise pools](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises), and [legacy annual plans](https://docs.github.com/en/copilot/reference/copilot-billing/request-based-billing-legacy/what-changed-with-billing).

<a id="anthropic-claude"></a>

### Anthropic (Claude)

OpenCode's Anthropic login is enough; Claude Code is optional. To also use Claude Code as the quota source and credential fallback, install it and sign in:

```bash
claude auth login
claude auth status
```

- OpenCode Quota runs `claude` from OpenCode's `PATH`, or else the first working one of `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). If Claude lives elsewhere, or on Windows when `claude` is not on OpenCode's `PATH`, set `anthropicBinaryPath`. `/quota_status` shows the one it ran as `binary_path`.
- When Claude Code does not expose quota windows itself, quota comes from Anthropic's OAuth usage endpoint, using the first usable token: OpenCode's own `anthropic` login, then Claude Code's credentials. `/quota_status` shows which one as `oauth_credential_source`.
- **Claude Usage Credits:** a separate monthly group when that response includes enabled Usage Credits with numeric utilization. Missing or invalid credit data never changes the regular 5-hour and weekly rows.
- **Fable:** a separate weekly row when Anthropic returns that model-scoped window. It is never guessed from your plan name. See [Claude Fable models on your plan](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan).

<a id="cursor"></a>

### Cursor

Use companion plugin [`cursor-opencode-provider`](https://github.com/oakimov/cursor-opencode-provider#readme). Add its OpenCode 2 entry **before** `@slkiser/opencode-quota` in `opencode.json`:

```jsonc
{
  "plugin": ["cursor-opencode-provider/plugin/opencode2", "@slkiser/opencode-quota"],
}
```

Restart OpenCode, run `/connect`, choose **Cursor**, then sign in with **Cursor account (browser login)** or paste an **API key** from [cursor.com/settings](https://cursor.com/settings). A `CURSOR_API_KEY` environment variable also works. OpenCode 1 plugins such as `@playwo/opencode-cursor-oauth` and `@rama_nigg/open-cursor` do not run on OpenCode 2; replace them with this entry.

Cursor estimates the current billing cycle from your local OpenCode history:

- With all models known and an allowance (`cursorPlan` or `cursorIncludedApiUsd`), it shows an **API budget** percentage with used, limit, and remaining USD.
- Without an allowance, it shows **API spend**.
- If any Cursor model is unknown, it shows only **Known API spend** plus a partial-data issue, never a percentage or a total.
- **Auto+Composer spend** is a supplementary row shown in detailed output when there is room.
- Set `cursorBillingCycleStartDay` to your billing day; otherwise the cycle is the local calendar month.

<a id="alibaba-personal-token-plan"></a>

### Alibaba Personal Token Plan

This is separate from Alibaba Coding Plan. Install and sign in to Alibaba Cloud Model Studio's official CLI yourself:

```bash
npm install -g bailian-cli
bl auth login --console
```

- OpenCode Quota runs only `bl usage token-plan --output json`. It never installs `bl`, opens a login, reads console cookies, or runs a custom command.
- On macOS and Linux, `bl` must be in an absolute folder on the `PATH` (the OpenCode service's inside OpenCode, your shell's in the terminal). Relative entries are ignored, and so is anything inside the project folder, including a `bl` that links into it. Your home folder is not a project, so `~/.local/bin` and nvm folders work.
- On Windows, use WSL. Native `bl.exe` and `.cmd` shims are not supported in this release.
- Team plans, China-only `alibaba-token-plan-cn` runtimes, and cookie-based console scraping are not supported.
- After switching the CLI's console account, restart OpenCode or wait for the next live check.
- With a manual provider list, include `alibaba-token-plan` in `enabledProviders`.

OpenCode Quota's Google integrations use independent community companion plugins. They are not endorsed by Google.

<a id="google-agy-quick-setup"></a>

### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://github.com/anthonyhaussman/opencode-agy-auth). OpenCode 2 needs its OpenCode 2 build, currently the alpha: `@anthonyhaussman/opencode-agy-auth@alpha`. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **Antigravity CLI (OAuth)**:

```bash
opencode auth login google-agy
```

- It shows the companion's grouped weekly and five-hour windows for each account. AGY logins copied from OpenCode 1 keep working.
- With a manual provider list, include `google-agy` in `enabledProviders`.
- If the login has no project id, set `OPENCODE_AGY_PROJECT_ID`, or `providers.google-agy.settings.projectId` in your user/global `opencode.json` (the OpenCode 1 form `provider.google-agy.options.projectId` also works).

<a id="gemini-cli"></a>

### Gemini CLI

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal Gemini Code Assist accounts (individual, AI Pro, and AI Ultra) on 2026-06-18; see [Google's notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals). Personal Google users should use [Google AGY](#google-agy-quick-setup).

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme) 2.x, which supports OpenCode 2. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **OAuth with Google (Gemini CLI)**:

```bash
opencode auth login google
```

If you use manual provider selection, include `google-gemini-cli` in `enabledProviders`.

<a id="deepseek"></a>

### DeepSeek

Shows your on-demand account balance from `GET https://api.deepseek.com/user/balance`. DeepSeek has no quota reset window, so there is no quota percentage.

- Each valid **Total balance** is its own currency row. Detailed output can add **Granted balance** and **Topped-up balance**. Currencies are never added up or converted.
- With no valid total balance, it shows the API's availability status. A malformed number becomes a partial-data issue, not zero.
- Key: `DEEPSEEK_API_KEY`, or `provider.deepseek.options.apiKey` in trusted user/global config (for example `"{env:DEEPSEEK_API_KEY}"`). See [API keys](#api-keys).
- With a manual provider list, include `deepseek` in `enabledProviders`.

<a id="nanogpt"></a>

### NanoGPT

- **Daily quota** and **Monthly quota** percentages, with used, limit, and remaining requests when available.
- The balance is its own row: USD when available, otherwise a valid NANO balance. USD and NANO are never combined.
- Subscription and balance requests work independently, so one failing leaves the other rows visible with a partial-data issue.

<a id="kilo-gateway"></a>

### Kilo Gateway

Create an API key in your Kilo personal profile, then set `KILO_API_KEY` (or use trusted user/global `provider.kilo.options.apiKey`, or a `kilo` API-key login saved in OpenCode 2). The provider id is `kilo`; with a manual provider list, include `kilo` in `enabledProviders`.

It checks the `kiloPass.getState` endpoint first, then shows:

- **Active Kilo Pass with credits:** one **Credits** percentage with used, limit, and remaining USD, plus the reset when available.
- **Active pass with zero credits:** one **Remaining credits** USD value, with the reset.
- **No active pass:** one **Total balance** USD row, with no invented usage, percentage, or reset.
- Base, usage, bonus, remaining, overage, and reset source values stay in `/quota_status` and JSON `rawDetails`.

<a id="kimi-code"></a>

### Kimi Code

Each regional plan has its own key and host. A key is sent only to its own host, and a failed request is never retried on the other one.

- **Kimi Code (Global)** uses `api.kimi.ai`. Key order: `KIMI_GLOBAL_API_KEY` → trusted user/global `provider.kimi-code-plan-global.options.apiKey` → `kimi-code-plan-global` API-key login saved in OpenCode 2.
- **Kimi Code (CN)** uses `api.kimi.com`. Key order: `KIMI_CN_API_KEY` → `KIMI_API_KEY` → `KIMI_CODE_API_KEY` → trusted user/global config under `kimi-code-plan-cn`, `kimi-for-coding`, `kimi-code`, or `kimi` → an API-key login saved in OpenCode 2 under those same ids. The legacy ids `kimi-for-coding`, `kimi-code`, and `kimi` belong to the CN plan.

<a id="xiaomi-mimo"></a>

### Xiaomi MiMo

Reads the signed-in dashboard API: one **Monthly quota** with used/limit tokens, plus optional **Total balance** (primary), **Cash balance**, and **Gift balance** (detailed output). A valid currency code is kept; with none, amounts are credits.

Use exactly one trusted credential source. The environment variable wins:

```bash
export MIMO_USAGE_COOKIE='api-platform_serviceToken=...; userId=...'
```

Or create the user/global file `opencode-quota/mimo.json` (usually `~/.config/opencode/opencode-quota/mimo.json`), never in a repository:

```json
{
  "cookie": "api-platform_serviceToken=...; userId=..."
}
```

To copy the cookie:

1. Sign in at `platform.xiaomimimo.com`.
2. Open the browser Developer Tools, then **Network**.
3. Refresh the dashboard and select the `/api/v1/balance` request.
4. Copy its **Request Headers → Cookie** value into the variable or file above.

- The value may start with `Cookie:`. Line breaks are rejected. `api-platform_serviceToken` and `userId` are required, `api-platform_ph` and `api-platform_slh` are kept, and every other cookie is removed before requests.
- An invalid variable or a higher-priority `mimo.json` blocks lower-priority sources instead of falling back.
- Provider ids: `xiaomi`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-ams`, and `xiaomi-token-plan-sgp`. With a manual provider list, use `xiaomi`.
- Plan name and code only label the display. An expired plan is not shown as active, and `currentPeriodEnd` is not a quota reset.
- The three dashboard requests are independent, so other rows still appear if one fails. Per-API-key costs are not supported yet.

<a id="ollama-cloud"></a>

### Ollama Cloud

Create an Ollama API key, then set `OLLAMA_API_KEY` (or use trusted user/global `provider.ollama-cloud.options.apiKey`, or an `ollama-cloud` API-key login saved in OpenCode 2).

- Calls `https://ollama.com/api/usage` and shows session, weekly, or monthly usage (newer plans show only a monthly pool).
- The API gives no reset times and no per-model rows.
- The old `OLLAMA_USAGE_COOKIE`, `ollama-cloud.json`, and `ollama-usage/config.yaml` cookie setup is no longer supported.

<a id="openai-and-xai"></a>

### OpenAI and xAI

- **OpenAI:** ChatGPT quota requires an OAuth login via `opencode auth login openai`; stored API keys show "ChatGPT quota unavailable for API key" without a ChatGPT request.
- **xAI:** reads OpenCode's xAI login and shows its single Weekly window. The credits endpoint sets the quota; a best-effort subscription lookup labels the plan as xAI Lite, xAI SuperGrok, or xAI Heavy. If the plan is unknown, the quota still shows under the xAI SuperGrok label.

<a id="openrouter"></a>

### OpenRouter

Reads your OpenCode API key and calls OpenRouter's current-key endpoint. Limited keys show used budget and remaining percentage; unlimited keys show spend. No reset time is invented. `/quota_status` has an `openrouter:` section with the key source and the live check result.

<a id="opencode-go"></a>

### OpenCode Go

If you are signed in to the OpenCode Console in OpenCode 2, Go first asks the Console (`/api/go/status`). If you are not signed in, the sign-in fails, or that call fails, it uses the official `https://opencode.ai/zen/go/v1/usage` API with your API key.

API key order:

1. `OPENCODE_API_KEY`
2. Trusted user/global OpenCode config: `provider.opencode-go.options.apiKey`
3. Trusted user/global fallback: `provider.opencode.options.apiKey`
4. An `opencode-go` API-key login saved in OpenCode 2 (`opencode.db`). `opencode auth login opencode-go` creates it.
5. A legacy `opencode` API-key login as the final fallback.

- Without an API key: a sign-in OpenCode cannot return shows as an error, and a failed Console call (including HTTP 403) shows no Go quota.
- If the Console reports no Go subscription (for example HTTP 404), no Go rows appear.
- A window with API status `rate-limited` is shown as used up (0% left) with its reset time. Other windows stay visible.
- `opencodeGoWindows` picks which of **Five-hour**, **Weekly**, and **Monthly** appear everywhere. `tuiSidebarPanel.opencodeGoPreferredWindow` (`rolling`, `weekly`, or `monthly`) picks the row shown while the sidebar is collapsed; if unset or unavailable, the lowest remaining window is used.
- Old workspace/cookie setups cannot be converted to an API key. See [OpenCode Go findings](updating.md#opencode-go-findings).

<a id="opencode-zen"></a>

### OpenCode Zen

Zen uses your OpenCode Console sign-in from OpenCode 2; no cookie or workspace ID is needed.

1. Run `opencode auth login opencode`, sign in to the Console in your browser, and pick the organization to track.
2. To track another organization, sign in again and pick it. With several saved sign-ins, `opencode auth switch opencode` picks the active one.
3. Check it with `/quota_status` in OpenCode, or `opencode-quota status` in a terminal.

- Inside OpenCode, an expired token is refreshed; the terminal command does not refresh it.
- An OpenCode API key alone is not a Console sign-in. Without a sign-in, auto mode skips Zen; include `opencode` in `enabledProviders` to see a sign-in hint instead.
- Zen reads unofficial Console routes (`/api/billing/status`, `/api/billing/account`, `/api/billing/auto-recharge`, `/api/budgets/org`, and `/api/usage/cost-by-day`), so OpenCode may change them.
- **Monthly budget:** a percentage with used, limit, and remaining USD. It uses the org budget (`/api/budgets/org`) and its reset date when that has a positive limit and usable spend. Otherwise it uses the Console credit limit (`/api/billing/account`) plus this month's usage costs (`/api/usage/cost-by-day`). `opencodeMonthlyLimit` in `quota-toast.json` overrides the budget from either source.
- **Balance:** always required. It is supplementary when a budget percentage exists, and primary otherwise (next to a **Monthly spend** row when this month's usage is known).
- **Auto-reload:** a supplementary enabled/disabled row. Its amount and trigger stay in diagnostics.
- If a non-balance route fails, Zen still shows the balance, hides only the rows that need the failed data, and lists the failed route as an error.
- `accountingDetail: "detailed"` shows the supplementary balance and auto-reload rows. The old `opencodeZenDisplay` setting is gone; see [What can change automatically](updating.md#what-can-change-automatically).
- The old `opencode-quota/opencode.json` file and `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE` variables are no longer read. See [OpenCode Zen findings](updating.md#opencode-zen-findings).
