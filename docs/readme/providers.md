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
| Cursor             | [Needs setup](#cursor)                 | Local estimate     | Budget and spend   |
| GitHub Copilot     | Automatic                              | Remote API         | Budget and usage   |
| Google AGY         | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| Ollama Cloud       | Automatic                              | Remote API         | Quota and balance  |
| OpenAI             | Automatic                              | Remote API         | Quota              |
| OpenCode Go        | Automatic                              | Remote API         | Quota              |
| OpenCode Zen       | Automatic                              | Remote API         | Budget and balance |
| OpenRouter         | Automatic                              | Remote API         | Budget and spend   |
| xAI                | Automatic                              | Remote API         | Quota              |

</details>

<details>
<summary><strong>Business / Enterprise</strong></summary>

| Provider                | Auth/setup                             | Data from          | Reports            |
| ----------------------- | -------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)      | [Needs setup](#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Cursor                  | [Needs setup](#cursor)                 | Local estimate     | Budget and spend   |
| Gemini CLI              | [Needs setup](#gemini-cli)             | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](#google-agy-quick-setup) | Remote API         | Quota              |
| OpenAI                  | Automatic                              | Remote API         | Quota              |
| OpenCode Zen            | Automatic                              | Remote API         | Budget and balance |
| OpenRouter              | Automatic                              | Remote API         | Budget and spend   |
| xAI                     | Automatic                              | Remote API         | Quota              |

These tables show which plans a vendor sells. Except for Copilot organization/enterprise billing, each integration reports one signed-in account, seat, API key, or workspace.

</details>

### Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                      | Auth/setup                                                          | Data from      | Reports            |
| ----------------------------- | ------------------------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan           | Automatic                                                           | Local estimate | Quota              |
| Alibaba Token Plan            | [Needs setup](#alibaba-token-plan)                                  | Official CLI   | Quota and credits  |
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

- `Quota` covers quota and rate-limit windows; both export as `quota`.
- OpenCode Zen, Xiaomi MiMo, DeepSeek, and Cursor keep quota, rate limit, budget, usage, spend, credits, and balance as separate rows. A balance is not remaining allowance, and spend is not a budget percentage.
- Money shows USD with a `$` prefix, such as `$12.50`, and other currencies with an uppercase currency code after the amount, such as `8.25 CNY`. OpenCode Quota never converts, combines, or picks a preferred currency.
- `words.detail: "detailed"` adds supplementary balance, status, and spend rows. See [All settings](configuration.md#all-settings).

## Custom providers

Providers OpenCode Quota doesn't include (for example Chutes AI, NanoGPT, Synthetic, Kilo Gateway) can be added as a custom provider: ask your agent with the prompt below.

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status. Ask your agent to add a custom provider: paste this into OpenCode and replace `<provider>`:

```text
Add a custom OpenCode Quota provider for <provider> with the quota_provider_add tool, following docs/readme/providers.md#custom-providers in https://github.com/slkiser/opencode-quota. Never put a key or other secret in the definition: set apiKeyEnv to the name of the environment variable that holds the key, or leave it out to use the key OpenCode has for that provider. The tool saves the provider switched off; tell me the address and key source it returns. After I switch it on, test it with quota_provider_test, and fix what it reports (add it again with the same id; I switch it on again) until it shows rows.
```

Then switch the provider on by setting `"enabled": true` in `opencode-quota/settings.jsonc` in the OpenCode config folder (`~/.config/opencode/` by default), or in the TUI's `/quota_settings` → **Providers**. An agent saves every provider it adds or replaces switched off: until you switch it on, it is never fetched and its key is never sent. No agent tool can switch it on. The Providers tab switches on only the definition it shows: if its address or key source changed since, Save saves nothing and shows the new ones to check.

The `quota_settings_*` and `quota_provider_*` tools change only OpenCode Quota's own settings file (through a symlink, its target), never `opencode.json`. A definition holding anything that looks like a key is refused. `quota_provider_test` and `quota_provider_remove` take a provider's `id`.

To edit it yourself, put definitions in `providers.custom` in `settings.jsonc` ([where](configuration.md#where-settings-live)). Changes apply without a restart.

- **Remote API:** real quota data from a supported endpoint (formats below).
- **Local estimate:** counts matching completed OpenCode requests in 1–16 windows, with optional spend estimates. `utc-day` resets at UTC midnight; `rolling` uses `durationMinutes` (up to 366 days). Every window needs `requestLimit`; `usdBudget` is optional.
- **Credentials:** the variable named by `apiKeyEnv`, then `provider.<providerId>.options.apiKey` in the [OpenCode config files](troubleshooting.md#opencode-config-files) (no `{env:…}` unless it names `apiKeyEnv`), then an API-key login saved in OpenCode 2 (`opencode.db`) for that provider id. A switched-off provider is never fetched and its key is never sent.
- Switched-on definitions whose `providerId` OpenCode has run automatically unless `providers.off` includes `custom`.
- A custom model provider still needs its normal OpenCode provider/model config. `/connect` → **Other** stores its credential, not its model setup.
- OpenRouter is built in. A custom OpenRouter definition only helps if you need a different endpoint or label.
- Alibaba Token Plan uses the reserved `alibaba-token-plan` ID and stays a separate official-CLI provider; it is not a local-estimate tuning target. `alibaba-token-plan-cn` is accepted as another name for the same CLI.

See [Configuration](configuration.md#custom-providers) for a complete example and the other rules (pricing, what is not allowed).

<details>
<summary><strong>Recipes: Vercel AI Gateway, Moonshot, Poe</strong></summary>

Add the providers you use to `providers.custom` in `settings.jsonc`, then set the key variable (or use an API-key login saved in OpenCode):

```jsonc
{
  "providers": {
    "custom": [
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
- `openrouter-key-v1` reads OpenRouter's key response, with the same rows as the [built-in OpenRouter](#openrouter).

A `quota-v1` response looks like this:

```json
{
  "version": "quota-v1",
  "entries": [
    { "kind": "percent", "name": "Requests", "resultType": "quota", "percentRemaining": 42, "label": "Daily:" },
    { "kind": "value", "name": "Spend", "resultType": "spend", "value": "$12.50" }
  ]
}
```

A `json-v1` adapter is built from literal property segments, compatible metric sources, and optional units and timestamps. This example maps `remaining`, `limit`, and `status` from one response object:

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

- **Rows:** optional `rowsPath` and 1–16 `mappings`. Without `rowsPath`, an object is one item and an array is a list of items; with it, the array it names is the list. Each mapping makes one row per item, so a reply can show up to 1,600 rows (100 items × 16 mappings). When the list holds more than one item, the rows are numbered: `Daily 1`, `Daily 2`, `Daily 3`, where item 1 keeps the plain row id and items 2 and later add `.2`, `.3`. One item keeps the plain name `Daily`. Lists hold 1–100 items, responses allow at most 32 container levels, and at most 1,600 item/mapping candidates are checked.
- **Mapping names:** each name keys its rows, so names must still differ when spaces count as `_` (`Daily limit` and `Daily_limit` clash; `Daily-limit` is fine).
- **Paths:** 1–8 literal own-property segments of 1–64 Unicode code points. Dots and brackets mean nothing special; array indexes and the segments `__proto__`, `prototype`, and `constructor` are rejected.
- **Size:** adapter input is limited to 8 container levels, 128 objects, 384 object properties, and 640 array elements. Names and labels are 1–80 code points (a numbered row's label is shortened so its number fits), units 1–32, and status/display output at most 160.
- **Metrics:** `percentage`, `used-limit`, `remaining-limit`, `spend-budget`, `remaining-budget`, `value`, and `status`. Calculations are fixed; no formulas or fallback parsing.
- **Numbers:** exactly one `path` or `literal`, finite, with absolute magnitude at most `1e15`. A response may also write a number as text if it is a plain decimal like `"95.50"` or `"-3"` (spaces around it are ignored); other text such as `"95.50 USD"` or `"1e3"` is rejected. Zero is not the same as missing or `null`. Path sources may use `divideBy` with `100`, `1000`, or `1000000`.
- **Timestamps:** `iso-8601`, `unix-seconds`, or `unix-milliseconds`. ISO needs a time zone, allows 1–3 fractional digits and offsets through `±14:00`, and must fall within years 1970–9999. Output is canonical UTC ISO.
- **Errors:** a bad mapping candidate gets a fixed, redacted diagnostic while other valid candidates stay visible. At most 16 detailed errors plus one summary are kept.

Metric compatibility and fixed output:

| `metric.type`      | Allowed `resultType`            | Percent or value output                                    |
| ------------------ | ------------------------------- | ---------------------------------------------------------- |
| `percentage`       | `quota`, `rate_limit`, `budget` | remaining: `percentage`; used: `100 - percentage`          |
| `used-limit`       | `quota`, `rate_limit`           | `(limit - used) / limit * 100`                             |
| `remaining-limit`  | `quota`, `rate_limit`           | `remaining / limit * 100`                                  |
| `spend-budget`     | `budget`                        | `(budget - spend) / budget * 100`                          |
| `remaining-budget` | `budget`                        | `remaining / budget * 100`                                 |
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

`unit` and `unitPosition` must appear together. Units are forbidden for `percentage` and `status`, and show only on `value` rows: prefix like `€2`, suffix like `2 tokens`. A value with unit `$` or `USD` (in any case, such as `usd`) is money and shows like built-in money, `$1,234.57` or `-$3.50`, in either position. Other values show at most 15 significant digits, so `0.7` with `divideBy: 100` shows as `0.007`.

**Never put secrets in adapter display configuration.** Static `name`, `label`, and `unit` fields and every `literal` can appear in written configuration, cache identity, rendered quota rows, or exports.

OpenCode Quota sends a fixed authenticated `GET` and waits up to `providers.checking.requestTimeoutMs` (5 seconds unset). The URL must use HTTPS, except for loopback testing. Redirects and URLs containing credentials, queries, or fragments are rejected. Responses must be JSON and are limited to 256 KiB. Standard envelopes are limited to 100 rows and `json-v1` lists to 100 items. An HTTP 401 shows as `Sign in again`, a 429 as `Rate limited` (with its `Retry-After` wait, at most a day), an endpoint that cannot be reached as `Can't reach …`, and a redirect or a reply that is not valid JSON as `Unexpected reply`.

</details>

## API keys

These providers read an API key from, in order: an environment variable, then OpenCode config (`provider.<id>.options.apiKey`), then an API-key login saved in OpenCode 2 (`opencode.db`).

- OpenCode config means the [OpenCode config files](troubleshooting.md#opencode-config-files) of the session, the project's included. For each provider id, the file ranked highest that sets `apiKey` decides, as in OpenCode: `""` there, or `null` in the native form, means no key from config, even when a lower file has one.
- A whole value `{env:NAME}` is filled in only when `NAME` is one of that provider's own variables and is set; otherwise it gives no key from config. Other templates, such as `{file:…}`, are not filled in.
- An OpenCode login used as a fallback must be an API-key login, not an OAuth sign-in.
- `provider.<id>.options.apiKey` can also be written in OpenCode 2's native form, `providers.<id>.settings.apiKey`. Like OpenCode 2, a native `providers.<id>` entry replaces the `provider.<id>` entry with the same id. A `provider.<id>` entry OpenCode 2 drops because a field has the wrong type, such as `"apiKey": null` or a `baseURL` that is not text, sets nothing, so a lower file's key still counts.

| Provider                | Environment variables (first match wins)              | Notes |
| ----------------------- | ----------------------------------------------------- | ----- |
| Alibaba Coding Plan     | `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`       | |
| DeepSeek                | `DEEPSEEK_API_KEY`                                     | See [DeepSeek](#deepseek). |
| Kimi Code / Kimi Code (CN) | See [Kimi Code](#kimi-code)                         | Each region has its own keys. |
| MiniMax Token Plan      | `MINIMAX_CODING_PLAN_API_KEY`, `MINIMAX_API_KEY`       | International endpoint. Runtime/config ids like `minimax` and `minimax-coding-plan` use this provider. |
| MiniMax Token Plan (CN) | `MINIMAX_CHINA_CODING_PLAN_API_KEY`                    | Config under `minimax-china-coding-plan`, `minimax-cn-coding-plan`, `minimax-cn`, or `minimax-china`. Runtime id `minimax-cn-coding-plan` uses this provider. |
| Ollama Cloud            | `OLLAMA_API_KEY`                                       | See [Ollama Cloud](#ollama-cloud). |
| OpenCode Go             | `OPENCODE_API_KEY`                                     | Has its own order; see [OpenCode Go](#opencode-go). |
| OpenRouter              | `OPENROUTER_API_KEY`                                   | See [OpenRouter](#openrouter). |
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

OpenCode's Anthropic login is enough; Claude Code is optional. Each OpenCode `anthropic` login is asked once per check at Anthropic's OAuth usage endpoint. Claude Code is started only when Anthropic rejects a login, so `/quota_status` shows whether Claude Code is installed and signed in. An expired login shows "Sign in again". To use Claude Code as the quota source when OpenCode has no Anthropic login, install it and sign in:

```bash
claude auth login
claude auth status
```

- OpenCode Quota runs `claude` from OpenCode's `PATH`, or else the first working one of `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). If Claude lives elsewhere, or on Windows when `claude` is not on OpenCode's `PATH`, set `providers.anthropic.binaryPath`. `/quota_status` shows the one it ran as `binary_path`.
- When Claude Code does not expose quota windows itself, quota comes from Anthropic's OAuth usage endpoint with Claude Code's own credentials (macOS Keychain, then `~/.claude/.credentials.json`). `/quota_status` shows `oauth_credential_source`: `opencode-auth` for OpenCode logins, `claude-credentials` for Claude Code's.
- When Anthropic rejects an OpenCode login, that login shows its error, and `/quota_status` shows whether Claude Code and its credentials still work.
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

Cursor's three settings sit under Cursor on the Providers tab (`/quota_settings`): **Plan** (Pro includes $20 of API use a month, Pro Plus $70, Ultra $400), **Included API budget** (your own amount instead of the plan's), and **Billing day** (the day your Cursor bill renews).

Cursor estimates the current billing cycle from your local OpenCode history, pricing each model the way the Usage tab does: Auto, Composer and Grok 4.5–4.7 at Cursor's own prices (their spend is the Auto+Composer row), every other model at its models.dev price. These have no price: a request whose prompt passes 200k tokens on Claude Sonnet 4, GPT-5.4, GPT-5.5, GPT-5.6 or Grok 4.7 (Cursor bills those at a higher rate), Gemini 3.6 Flash, GLM 5.3 Flash and the Muse models (Cursor's price is not models.dev's), and the `grok-4.7-500k` models. A cache write costs nothing unless Cursor publishes a cache-write rate for the model, as cursor-opencode-provider bills it.

- With all models known and an allowance (`providers.cursor.plan` or `providers.cursor.includedApiUsd`), it shows an **API budget** percentage with used, limit, and remaining USD.
- Without an allowance, it shows **API spend**.
- If any Cursor model or request has no price, it shows only **Known API spend** plus a partial-data issue, never a percentage or a total.
- **Auto+Composer spend** is a supplementary row shown in detailed output when there is room.
- Set `providers.cursor.billingCycleStartDay` to your billing day; otherwise the cycle is the local calendar month.

<a id="alibaba-token-plan"></a>
<a id="alibaba-personal-token-plan"></a>

### Alibaba Token Plan

This is separate from Alibaba Coding Plan. Install and sign in to Alibaba Cloud Model Studio's official CLI yourself:

```bash
npm install -g bailian-cli
bl auth login --console
```

- OpenCode Quota runs only `bl usage token-plan --output json`. It never installs `bl`, opens a login, reads console cookies, or runs a custom command.
- The command carries no region or account, so which plan you see is the one `bl` is signed in to. `bl auth login --console` binds it to that console's account, and `bl auth status` says which account, region and site that is. Change it there, not in OpenCode Quota.
- One ID reports it: `alibaba-token-plan`, and `alibaba-token-plan-cn` is accepted as another name for the same CLI, so a config that names it keeps working for provider selection and for `providers.off`. Per-row settings (hide, rename, order) are keyed by the canonical `alibaba-token-plan` id. There is nothing to tell apart or to switch off: the numbers come from that one sign-in.
- It reports one **Monthly** row, keyed `personal`: the percent of the monthly plan still left, and its reset time when `bl` gives one. A signed-in reply with no percentage leaves the row out — an account that sells no personal plan is not a fault — and `/quota_status` says so in `window_hint`, using `bl`'s own wording; nothing is invented.
- `bl` must be in an absolute folder on the [service `PATH`](#service-environment) (the OpenCode service's inside OpenCode, your shell's in the terminal). Relative entries are ignored, and so is anything inside the project folder, including a `bl` that links into it. Your home folder is not a project, so `~/.local/bin` and nvm folders work.
- A native `bl` executable is run directly. An npm `bl.cmd` shim is resolved to the package's own node entry and run with `node`, so no shell is involved. Other launchers (`.ps1`, `.bat`, a `bl` linking to `cmd.exe`) are refused.
- Team plans and cookie-based console scraping are not supported.
- After switching the CLI's console account, restart OpenCode or wait for the next live check.


OpenCode Quota's Google integrations use independent community companion plugins. They are not endorsed by Google.

<a id="google-agy-quick-setup"></a>

### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://github.com/anthonyhaussman/opencode-agy-auth). OpenCode 2 needs its OpenCode 2 build, currently the alpha: `@anthonyhaussman/opencode-agy-auth@alpha`. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **Antigravity CLI (OAuth)**:

```bash
opencode auth login google-agy
```

- It shows the companion's grouped weekly and five-hour windows for each account. AGY logins copied from OpenCode 1 keep working.
- Remove `google-agy` from `providers.off` if it is switched off.
- If the login has no project id, set `OPENCODE_AGY_PROJECT_ID`, or `providers.google-agy.settings.projectId` in [OpenCode config](troubleshooting.md#opencode-config-files) (the OpenCode 1 form `provider.google-agy.options.projectId` also works).

<a id="gemini-cli"></a>

### Gemini CLI

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal Gemini Code Assist accounts (individual, AI Pro, and AI Ultra) on 2026-06-18; see [Google's notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals). Personal Google users should use [Google AGY](#google-agy-quick-setup).

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme) 2.x, which supports OpenCode 2. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **OAuth with Google (Gemini CLI)**:

```bash
opencode auth login google
```

Quota checks `google-gemini-cli` when it finds it. Remove it from `providers.off` if you switched it off.

<a id="deepseek"></a>

### DeepSeek

Shows your on-demand account balance from `GET https://api.deepseek.com/user/balance`. DeepSeek has no quota reset window, so there is no quota percentage.

- Each valid **Total balance** is its own currency row. Detailed output can add **Granted balance** and **Topped-up balance**. Currencies are never added up or converted.
- With no valid total balance, it shows the API's availability status. A malformed number becomes a partial-data issue, not zero.
- Key: `DEEPSEEK_API_KEY`, or `provider.deepseek.options.apiKey` in OpenCode config (for example `"{env:DEEPSEEK_API_KEY}"`). See [API keys](#api-keys).
- Remove `deepseek` from `providers.off` if it is switched off.

<a id="kimi-code"></a>

### Kimi Code

Each regional plan has its own key and host. A key is sent only to its own host, and a failed request is never retried on the other one.

- **Kimi Code (Global)** uses `api.kimi.ai`. Key order: `KIMI_GLOBAL_API_KEY` → `provider.kimi-code-plan-global.options.apiKey` in OpenCode config → `kimi-code-plan-global` API-key login saved in OpenCode 2.
- **Kimi Code (CN)** uses `api.kimi.com`. Key order: `KIMI_CN_API_KEY` → `KIMI_API_KEY` → `KIMI_CODE_API_KEY` → OpenCode config under `kimi-code-plan-cn`, `kimi-for-coding`, `kimi-code`, or `kimi` → an API-key login saved in OpenCode 2 under those same ids. The legacy ids `kimi-for-coding`, `kimi-code`, and `kimi` belong to the CN plan.

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
- The three dashboard requests are independent, so other rows still appear if one fails. Per-API-key costs are not supported.

<a id="ollama-cloud"></a>

### Ollama Cloud

Create an Ollama API key, then set `OLLAMA_API_KEY` (or use `provider.ollama-cloud.options.apiKey` in OpenCode config, or an `ollama-cloud` API-key login saved in OpenCode 2).

- Calls `https://ollama.com/api/balance`. Credit plans show a **Monthly** row (included credits left, with the period's reset time); legacy plans show **Session** and **Weekly** rows with their reset times.
- **Purchased** shows unexpired purchased credits in USD when there are some, or when Ollama returns nothing else.
- The API gives no per-model rows.
- The old `OLLAMA_USAGE_COOKIE`, `ollama-cloud.json`, and `ollama-usage/config.yaml` cookie setup is no longer supported.

<a id="openai-and-xai"></a>

### OpenAI and xAI

- **OpenAI:** ChatGPT quota needs a Codex login: `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. OpenAI rejects **Sign in with ChatGPT** logins on ChatGPT's usage endpoint (HTTP 401 `no_matching_rule`), so they show "ChatGPT quota unavailable for Sign in with ChatGPT", and stored API keys show "ChatGPT quota unavailable for API key", both without a ChatGPT request. `/quota_status` shows `auth_method: chatgpt-token-sharing` when the active login is Sign in with ChatGPT.
- **xAI:** reads OpenCode's xAI login and shows its single Weekly window. The credits endpoint sets the quota; a best-effort subscription lookup labels the plan as xAI Lite, xAI SuperGrok, or xAI Heavy. That lookup waits at most 2 seconds (less when `providers.checking.requestTimeoutMs` is lower). If the plan is unknown or the lookup fails, the quota still shows under the xAI SuperGrok label.

<a id="openrouter"></a>

### OpenRouter

Reads your OpenCode API key and calls OpenRouter's current-key endpoint. Limited keys show the budget's percentage left. Unlimited keys show **This month**: the spend in the current UTC month (`usage_monthly`), or the all-time **Spend** when the reply has no monthly figure. No reset time is invented. `/quota_status` has an `openrouter:` section with the key source and the live check result.

<a id="opencode-go"></a>

### OpenCode Go

If you are signed in to the OpenCode Console in OpenCode 2, Go first asks the Console (`/api/go/status`). If you are not signed in, the sign-in fails, or that call fails, it uses the official `https://opencode.ai/zen/go/v1/usage` API with your API key.

API key order:

1. `OPENCODE_API_KEY`
2. OpenCode config: `provider.opencode-go.options.apiKey`
3. OpenCode config fallback: `provider.opencode.options.apiKey`
4. An `opencode-go` API-key login saved in OpenCode 2 (`opencode.db`). `opencode auth login opencode-go` creates it.
5. A legacy `opencode` API-key login as the final fallback.

- Without an API key: an expired sign-in shows `Sign in again` (as it does for Zen), a sign-in OpenCode cannot return shows as an error, and a failed Console call (including HTTP 403) shows no Go quota.
- If the Console reports no Go subscription (for example HTTP 404), no Go rows appear.
- A window with API status `rate-limited` is shown as used up (0% left) with its reset time. Other windows stay visible.
- Go shows **Five-hour**, **Weekly**, and **Monthly**. The collapsed sidebar shows the window with the least left.
- Old workspace/cookie setups (`OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_AUTH_COOKIE`, and the global `opencode-quota/opencode-go.json` file) are not read and cannot be converted to an API key. Remove them once Go works.

<a id="opencode-zen"></a>

### OpenCode Zen

Zen uses your OpenCode Console sign-in from OpenCode 2; no cookie or workspace ID is needed.

1. Run `opencode auth login opencode`, sign in to the Console in your browser, and pick the organization to track.
2. To track another organization, sign in again and pick it. With several saved sign-ins, `opencode auth switch opencode` picks the active one.
3. Check it with `/quota_status` in OpenCode, or `opencode-quota status` in a terminal.

- Inside OpenCode, an expired token is refreshed; the terminal command does not refresh it.
- An OpenCode API key alone is not a Console sign-in. Zen appears when a Console sign-in is found and `providers.off` does not include `opencode`.
- Zen reads unofficial Console routes (`/api/billing/status`, `/api/billing/account`, `/api/billing/auto-recharge`, `/api/policies/members/{account id}`, and `/api/usage/cost-by-day`), so OpenCode may change them.
- **Monthly budget:** a percentage with used, limit, and remaining USD. It uses your member budget (`/api/policies/members/{account id}`, trusted only when the reply names your account): of the monthly budget rules that apply to you, your own `each` cap or a shared `combined` cap, the one with the least USD left. A $0 budget blocks, so it shows 0% left. A member budget resets at 00:00 UTC on the 1st of the next month. A budget Zen can't evaluate (it covers only some models, it is a non-zero per-model budget, its rule doesn't match, or its amounts are missing) could be the one that binds, so then Zen uses no member budget and `/quota_status` shows `member_budget_note`. Without a usable member budget, Zen uses the Console credit limit (`/api/billing/account`) plus this month's usage costs (`/api/usage/cost-by-day`). `providers.opencode.monthlyLimitUsd` in `settings.jsonc` overrides the budget from either source.
- **Balance:** always required. It is supplementary when a budget percentage exists, and primary otherwise (next to a **Monthly spend** row when this month's usage is known).
- **Auto-reload:** a supplementary enabled/disabled row. Its amount and trigger stay in diagnostics.
- If a non-balance route fails, Zen still shows the balance, hides only the rows that need the failed data, and lists the failed route as an error.
- `words.detail: "detailed"` shows the supplementary balance and auto-reload rows.
- The old `opencode-quota/opencode.json` file and `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE` variables are no longer read. Remove the file after Zen works. The variables may also belong to OpenCode's workspace feature, so remove them only if they held Zen credentials.
