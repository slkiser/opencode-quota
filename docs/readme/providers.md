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
| Alibaba Coding Plan           | [Needs setup](#alibaba-coding-plan)                                 | Local CLI      | Quota and requests |
| Alibaba Token Plan            | [Needs setup](#alibaba-token-plan)                                  | Local CLI      | Quota              |
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

| Provider                 | Auth/setup                         | Data from    | Reports |
| ------------------------ | ---------------------------------- | ------------ | ------- |
| Alibaba Token Plan       | [Needs setup](#alibaba-token-plan) | Local CLI    | Quota and credits |
| Kimi Code                | Automatic                          | Remote API   | Quota   |
| Kimi Code (CN)           | Automatic                          | Remote API   | Quota   |
| MiniMax Token Plan       | Automatic                          | Remote API   | Quota   |
| MiniMax Token Plan (CN)  | Automatic                          | Remote API   | Quota   |
| Zhipu Coding Plan        | Automatic                          | Remote API   | Quota   |

Except for Alibaba Token Plan, which reports one Credits row per team seat, these show only your own member API key's usage, not the whole organization's.

</details>

## Custom providers

Providers OpenCode Quota doesn't include (for example Chutes AI, NanoGPT, Synthetic, Kilo Gateway) can be added as a custom provider, read from the provider's quota API (`remote-api`) or estimated by counting OpenCode's requests (`local-estimate`). Ask your agent to add a custom provider: paste this into OpenCode and replace `<provider>`:

```text
Add a custom OpenCode Quota provider for <provider> with the quota_provider_add tool, following docs/readme/providers.md#custom-providers in https://github.com/slkiser/opencode-quota. Never put a key or other secret in the definition: set apiKeyEnv to the name of the environment variable that holds the key, or leave it out to use the key OpenCode has for that provider. The tool saves the provider switched off; tell me the address and key source it returns. After I switch it on, test it with quota_provider_test, and fix what it reports (add it again with the same id; I switch it on again) until it shows rows.
```

The agent saves the provider switched off: until you switch it on, it is never fetched and its key is never sent, and no agent tool can switch it on. Switch it on by setting `"enabled": true` in `opencode-quota/settings.jsonc`, or tick it in `/quota_settings` → **Providers**, which shows its address and the key it sends. The agent tools change only OpenCode Quota's own settings file, never `opencode.json`, and refuse a definition holding anything that looks like a key.

To write one yourself, add it to `providers.custom` in `settings.jsonc` ([where](configuration.md#where-settings-live)); `/quota_status` checks it with the plugin's own validator.

- **Identity:** `id` is the stable identity; add `providerId` only when it differs. A definition is on unless it has `"enabled": false`. Definitions keep file order, and `custom` in `providers.off` skips them all.
- **Credentials:** the variable named by `apiKeyEnv`, then `provider.<providerId>.options.apiKey` in the [OpenCode config files](troubleshooting.md#opencode-config-files) (no `{env:…}` unless it names `apiKeyEnv`), then an API-key login saved in OpenCode 2 (`opencode.db`) for that provider id.
- **Models:** `modelIds` only limits `words.onlyCurrentModel` and which requests a local estimate counts. Use exact, case-sensitive model ids without the provider prefix, or leave it out to cover every model of that provider.
- **Local estimate:** 1–16 windows; `utc-day` resets at UTC midnight, `rolling` uses `durationMinutes` (up to 366 days). Every window needs `requestLimit`; `usdBudget` is optional. Each check counts the completed requests in OpenCode's own messages; nothing else is stored.
- **Local estimate prices:** the automatic match comes first (models.dev, and Cursor's own prices for Auto, Composer and Grok); `pricingModelMap` is used only where it finds none and cannot override a successful automatic match. If any request cannot be priced, the request counts stay and the budget percentage is reported unavailable.
- **Not accepted:** scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode provider/model config. `/connect` → **Other** stores its credential, not its model setup.
- OpenRouter is built in; a custom OpenRouter definition only helps for a different endpoint or label. Alibaba Token Plan uses the reserved `alibaba-token-plan` id and stays a separate official-CLI provider; `alibaba-token-plan-cn` is another name for the same CLI.

<details>
<summary><strong>Example: a remote API and a local estimate</strong></summary>

```jsonc
{
  "providers": {
    "custom": [
      {
        "id": "openrouter-primary",
        "providerId": "openrouter",
        "label": "OpenRouter Primary",
        "mode": "remote-api",
        "url": "https://openrouter.ai/api/v1/key",
        "format": "openrouter-key-v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
      },
      {
        "id": "private-gateway",
        "label": "Private Gateway Estimate",
        "mode": "local-estimate",
        "modelIds": ["model-a"],
        "windows": [
          { "id": "daily", "label": "Daily", "type": "utc-day", "requestLimit": 1000, "usdBudget": 25 },
        ],
      },
    ],
  },
}
```

</details>

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

- They follow the providers' docs and weren't tested with a real key: [Vercel AI Gateway credits](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api#check-credit-balance), [Moonshot balance](https://platform.kimi.ai/docs/api/balance), [Poe usage API](https://creator.poe.com/docs/resources/usage-api).
- Poe: a Poe sign-in made through OpenCode's OAuth can't be used here. Create a key at [poe.com/api/keys](https://poe.com/api/keys) and set `POE_API_KEY`.

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

- **Rows:** optional `rowsPath` and 1–16 `mappings`. Without `rowsPath`, an object is one item and an array is a list of items; with it, the array it names is the list. A list holds 1–100 items, and each mapping makes one row per item. With more than one item, the rows are numbered `Daily 1`, `Daily 2`, …: item 1 keeps the plain row id and later items add `.2`, `.3`, ….
- **Mapping names:** each name keys its rows, so names must still differ when spaces count as `_` (`Daily limit` and `Daily_limit` clash; `Daily-limit` is fine).
- **Paths:** 1–8 literal own-property segments of 1–64 Unicode code points. Dots and brackets mean nothing special; array indexes and the segments `__proto__`, `prototype`, and `constructor` are rejected.
- **Size:** adapter input is limited to 8 container levels, 128 objects, 384 object properties, and 640 array elements, and a response to 32 container levels. Names and labels are 1–80 code points (a numbered row's label is shortened so its number fits), units 1–32, and status/display output at most 160.
- **Metrics:** `percentage`, `used-limit`, `remaining-limit`, `spend-budget`, `remaining-budget`, `value`, and `status`. Calculations are fixed; no formulas or fallback parsing.
- **Numbers:** exactly one `path` or `literal`, finite, with absolute magnitude at most `1e15`. A response may also write a number as text if it is a plain decimal like `"95.50"` or `"-3"` (spaces around it are ignored); other text such as `"95.50 USD"` or `"1e3"` is rejected. Zero is not the same as missing or `null`. Path sources may use `divideBy` with `100`, `1000`, or `1000000`.
- **Timestamps:** `iso-8601`, `unix-seconds`, or `unix-milliseconds`. ISO needs a time zone, allows 1–3 fractional digits and offsets through `±14:00`, and must fall within years 1970–9999. Output is canonical UTC ISO.
- **Errors:** a bad mapping candidate gets a fixed, redacted diagnostic while the valid ones stay visible.

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

OpenCode Quota sends a fixed authenticated `GET` and waits up to `providers.checking.requestTimeoutMs` (5 seconds unset). The URL must use HTTPS, except for loopback testing. Redirects and URLs containing credentials, queries, or fragments are rejected. Responses must be JSON and are limited to 256 KiB; a `quota-v1` envelope holds at most 100 rows.

</details>

## API keys

These providers read an API key from, in order: an environment variable, then `provider.<id>.options.apiKey` (or OpenCode 2's native `providers.<id>.settings.apiKey`) in the session's [OpenCode config files](troubleshooting.md#opencode-config-files), then an API-key login, not an OAuth sign-in, saved in OpenCode 2 (`opencode.db`).

- Config counts as in OpenCode: the highest-ranked file that sets `apiKey` decides, so `""` there (or `null` in the native form) means no key from config, even when a lower file has one. A native `providers.<id>` entry replaces the `provider.<id>` entry with the same id. A `provider.<id>` entry OpenCode 2 drops for a wrong-typed field (such as `"apiKey": null`, or a `baseURL` that is not text) sets nothing, so a lower file's key still counts.
- A whole value `{env:NAME}` is filled in only when `NAME` is one of that provider's own variables and is set. Other templates, such as `{file:…}`, are not filled in.

| Provider                | Environment variables (first match wins)              | Notes |
| ----------------------- | ----------------------------------------------------- | ----- |
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

`<plan> | usage needs billing token` means GitHub reported your plan but no usage for your login: normal for Business and Enterprise seats, whose usage comes from the organization's pool, and not a sign you are out of credits. The token below shows real numbers.

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
- An annual Pro or Pro+ plan that stayed on request-based billing after June 1, 2026 adds `"billingModel": "legacy_premium_requests"`; its totals come from the tier, and its percentage and reset are calculated locally.

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

<a id="anthropic-claude"></a>

### Anthropic (Claude)

OpenCode's Anthropic login is enough: each `anthropic` login is asked once per check at Anthropic's OAuth usage endpoint, and an expired one shows "Sign in again". Claude Code is optional. A placeholder login from an auth plugin such as `@cortexkit/opencode-anthropic-auth` is skipped; quota then needs a Claude Code login. Without an OpenCode Anthropic login, quota comes from Claude Code itself or from Anthropic's usage endpoint with Claude Code's credentials (macOS Keychain, then `~/.claude/.credentials.json`). When Anthropic rejects an OpenCode login, `/quota_status` shows whether Claude Code and its credentials still work. With openchamber's `claude-code` provider, quota uses Claude Code's login. To use Claude Code, install it and sign in:

```bash
claude auth login
claude auth status
```

OpenCode Quota runs `claude` from OpenCode's `PATH`, or else the first working one of `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, and `/usr/local/bin/claude` (not on Windows). If Claude lives elsewhere, or on Windows when `claude` is not on OpenCode's `PATH`, set `providers.anthropic.binaryPath`. `/quota_status` shows the one it ran as `binary_path`.

<a id="cursor"></a>

### Cursor

Use companion plugin [`cursor-opencode-provider`](https://github.com/oakimov/cursor-opencode-provider#readme). Add its OpenCode 2 entry **before** `@slkiser/opencode-quota` in `opencode.json`:

```jsonc
{
  "plugin": ["cursor-opencode-provider/plugin/opencode2", "@slkiser/opencode-quota"],
}
```

Restart OpenCode, run `/connect`, choose **Cursor**, then sign in with **Cursor account (browser login)** or paste an **API key** from [cursor.com/settings](https://cursor.com/settings). A `CURSOR_API_KEY` environment variable also works. OpenCode 1 plugins such as `@playwo/opencode-cursor-oauth` and `@rama_nigg/open-cursor` do not run on OpenCode 2; replace them with this entry.

Cursor estimates the current billing cycle from your local OpenCode history, priced like the Usage tab: Auto, Composer and Grok 4.5–4.7 at Cursor's own prices, every other model at its models.dev price. These have no price: a request whose prompt passes 200k tokens on Claude Sonnet 4 or Grok 4.7 (Cursor bills those at a higher rate), Gemini 3.6 Flash, GLM 5.3 Flash and the Muse models (Cursor's price is not models.dev's), and any request on `claude-sonnet-4-1m` or the `grok-4.7-1m` and `grok-4.7-500k` models. A cache write costs nothing unless Cursor publishes a cache-write rate for the model, as cursor-opencode-provider bills it.

- With every request priced and a **Plan** or **Included API budget** set under Cursor on the Providers tab, it shows an **API budget** percentage; without one, **API spend**. With any unpriced request, it shows only **Known API spend**, never a percentage or a total.
- **Billing day** sets the cycle's first day; unset, the cycle is the local calendar month.

<a id="alibaba-coding-plan"></a>

### Alibaba Coding Plan

The Coding Plan is a separate subscription, read by the same Alibaba Cloud Model Studio CLI and the same console session as the Alibaba Token Plan.

```bash
npm install -g bailian-cli
bl auth login --console
```

- It runs `bl usage coding-plan --output json`, which needs the console token. An API Key (AK/SK) signs in to the console too: `bl auth login --open-api --access-key-id <id> --access-key-secret <secret>` mints a CLI access token from it, validates it and saves both.
- It reports three request windows: `5h`, `Weekly` and `Monthly`, keyed `five_hour`, `weekly` and `monthly`. The quota is **requests**, so a row shows the percent left, the requests used, the limit and the reset time.
- A window the console reports no quota for has no row: the plan does not cover it, or its limit is 0.
- An account without a Coding Plan subscription prints `{}`: no rows and no error.
- It answers to `alibaba-coding-plan` and to the aliases `alibaba` and `alibaba-coding-plan-cn`. `providers.off` resolves synonyms, so `providers.off: ["alibaba"]` switches the Coding Plan off, not the Token Plan.
- OpenCode Quota never installs `bl`, opens a login, reads console cookies, or runs a custom command.

<a id="alibaba-token-plan"></a>

### Alibaba Token Plan

This is separate from Alibaba Coding Plan, and read by the same `bl` CLI:

```bash
npm install -g bailian-cli
bl auth login --console
```

OpenCode Quota runs two commands, each with its own sign-in. They are independent: setting up one still runs the other, and a half that was never set up reports nothing at all.

- **Personal** (one row per quota window, `alibaba-token-plan.personal.monthly`) runs `bl usage token-plan --output json` and needs the same **console** token (an API Key can mint one too, see [Coding Plan setup](#alibaba-coding-plan)).
- It reports every window `bl` sends, one row each with the percent of that window left: `alibaba-token-plan.personal.five_hour`, `alibaba-token-plan.personal.weekly` or `alibaba-token-plan.personal.monthly`. A window the reply does not carry has no row.
- A window the reply reports no quota for has no row either: it carries no usage ratio, and `/quota_status` says so in `window_hint`.
- **Team seats** (one `Credits` row per seat, `alibaba-token-plan.team.<slug>`) run `bl token-plan list-seats --status NORMAL --query-assigned true --page-size 100 --output json` and need **API Key** (AK/SK) credentials: `bl auth login --open-api`, or `ALIBABA_CLOUD_ACCESS_KEY_ID` and `ALIBABA_CLOUD_ACCESS_KEY_SECRET`. Each seat shows the credits left in its billing cycle, out of the cycle total, and the percent of that grant left.
- Without the AK/SK no team row is reported; the personal row still is. A seat whose status is not `NORMAL` has no row by design.
- Neither command carries a region or account, so you see the plan `bl` is signed in to. `bl auth status` says which account, region and site that is.
- One id reports it: `alibaba-token-plan`, and `alibaba-token-plan-cn` is another name for the same CLI, so a config that names it keeps working for provider selection and for `providers.off`.
- Its rows are saved and shared between OpenCode windows, keyed to the account the CLI reports.
- `bl` must be in an absolute folder on the [service `PATH`](troubleshooting.md#service-environment). A native `bl` runs directly, npm's `bl.cmd` shim is run with the `node` on that `PATH`, and other launchers are refused.
- Cookie-based console scraping is not supported. After switching the CLI's console account, restart OpenCode or wait for the next live check.

OpenCode Quota's Google integrations use independent community companion plugins. They are not endorsed by Google.

<a id="google-agy-quick-setup"></a>

### Google AGY

Use companion plugin [`@anthonyhaussman/opencode-agy-auth`](https://github.com/anthonyhaussman/opencode-agy-auth). OpenCode 2 needs its OpenCode 2 build, currently the alpha: `@anthonyhaussman/opencode-agy-auth@alpha`. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **Antigravity CLI (OAuth)**:

```bash
opencode auth login google-agy
```

- It shows the companion's grouped weekly and five-hour windows for each account. AGY logins copied from OpenCode 1 keep working.
- If the login has no project id, set `OPENCODE_AGY_PROJECT_ID`, or `providers.google-agy.settings.projectId` in [OpenCode config](troubleshooting.md#opencode-config-files) (the OpenCode 1 form `provider.google-agy.options.projectId` also works).

<a id="gemini-cli"></a>

### Gemini CLI

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Google ended personal Gemini Code Assist accounts (individual, AI Pro, and AI Ultra) on 2026-06-18; see [Google's notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals). Personal Google users should use [Google AGY](#google-agy-quick-setup).

Use companion plugin [`opencode-gemini-auth`](https://github.com/jenslys/opencode-gemini-auth#readme) 2.x, which supports OpenCode 2. Add it **before** `@slkiser/opencode-quota` in `opencode.json`, then sign in once and choose **OAuth with Google (Gemini CLI)**:

```bash
opencode auth login google
```

Quota checks `google-gemini-cli` when it finds it.

<a id="deepseek"></a>

### DeepSeek

Shows your account balance: one **Total balance** row per currency, never added up or converted (detailed output adds **Granted balance** and **Topped-up balance**), or the API's availability status when there is no valid balance. DeepSeek has no reset window, so there is no percentage. Key: `DEEPSEEK_API_KEY`, or see [API keys](#api-keys).

<a id="kimi-code"></a>

### Kimi Code

Each regional plan has its own key and host. A key is sent only to its own host, and a failed request is never retried on the other one.

- **Kimi Code (Global)** uses `api.kimi.ai`. Key order: `KIMI_GLOBAL_API_KEY` → `provider.kimi-code-plan-global.options.apiKey` in OpenCode config → `kimi-code-plan-global` API-key login saved in OpenCode 2.
- **Kimi Code (CN)** uses `api.kimi.com`. Key order: `KIMI_CN_API_KEY` → `KIMI_API_KEY` → `KIMI_CODE_API_KEY` → OpenCode config under `kimi-code-plan-cn`, `kimi-for-coding`, `kimi-code`, or `kimi` → an API-key login saved in OpenCode 2 under those same ids. The legacy ids `kimi-for-coding`, `kimi-code`, and `kimi` belong to the CN plan.

<a id="xiaomi-mimo"></a>

### Xiaomi MiMo

Reads the signed-in dashboard API: a **Monthly quota** of tokens and the account's balances.

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

- `api-platform_serviceToken` and `userId` are required; every cookie but those and `api-platform_ph` and `api-platform_slh` is removed before requests. The value may start with `Cookie:`; line breaks are rejected.
- An invalid variable or a higher-priority `mimo.json` blocks lower-priority sources instead of falling back.

<a id="ollama-cloud"></a>

### Ollama Cloud

Create an Ollama API key, then set `OLLAMA_API_KEY` (or see [API keys](#api-keys)). Credit plans show a **Monthly** row, older plans **Session** and **Weekly** rows, and **Purchased** shows unexpired purchased credits. The `OLLAMA_USAGE_COOKIE`, `ollama-cloud.json` and `ollama-usage/config.yaml` cookie setups are not read.

<a id="openai-and-xai"></a>

### OpenAI and xAI

- **OpenAI:** ChatGPT quota needs a Codex login: `/connect` → OpenAI → **Codex browser (legacy)** or **Codex device code (legacy)**. OpenAI rejects **Sign in with ChatGPT** logins on ChatGPT's usage endpoint, so they show "ChatGPT quota unavailable for Sign in with ChatGPT", and stored API keys show "ChatGPT quota unavailable for API key", both without a ChatGPT request.
- **xAI:** reads OpenCode's xAI login and shows its Weekly window. A lookup of at most 2 seconds labels the plan xAI Lite, xAI SuperGrok or xAI Heavy; when it fails or the plan is unknown, the label is xAI SuperGrok.

<a id="openrouter"></a>

### OpenRouter

Reads your OpenCode API key. A limited key shows the budget's percentage left; an unlimited key shows **This month**'s spend, or the all-time **Spend** when OpenRouter reports no monthly figure.

<a id="opencode-go"></a>

### OpenCode Go

If you are signed in to the OpenCode Console in OpenCode 2, Go first asks the Console (`/api/go/status`). If you are not signed in, the sign-in fails, or that call fails, it uses the official `https://opencode.ai/zen/go/v1/usage` API with your API key.

API key order:

1. `OPENCODE_API_KEY`
2. OpenCode config: `provider.opencode-go.options.apiKey`
3. OpenCode config fallback: `provider.opencode.options.apiKey`
4. An `opencode-go` API-key login saved in OpenCode 2 (`opencode.db`). `opencode auth login opencode-go` creates it.
5. A legacy `opencode` API-key login as the final fallback.

- Go shows **Five-hour**, **Weekly** and **Monthly**; a window the API reports as `rate-limited` shows as 0% left. When the Console reports no Go subscription, no Go rows appear.
- `OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_AUTH_COOKIE` and the `opencode-quota/opencode-go.json` file are not read and cannot be converted to an API key.

<a id="opencode-zen"></a>

### OpenCode Zen

Zen uses your OpenCode Console sign-in from OpenCode 2; no cookie or workspace ID is needed.

1. Run `opencode auth login opencode`, sign in to the Console in your browser, and pick the organization to track.
2. To track another organization, sign in again and pick it. With several saved sign-ins, `opencode auth switch opencode` picks the active one.
3. Check it with `/quota_status` in OpenCode, or `opencode-quota status` in a terminal.

- An OpenCode API key alone is not a Console sign-in. Inside OpenCode an expired sign-in is refreshed; the terminal command does not refresh it.
- **Monthly budget** is your member budget in the Console when Zen can use it, else the Console credit limit plus this month's usage. `providers.opencode.monthlyLimitUsd` (Providers tab: **Monthly budget**) overrides both. `/quota_status` shows `member_budget_note` when a member budget can't be used.
- **Auto-reload** is an extra row (Layout → All places → **Extra rows**), and so is **Balance** when there is a budget. If a route other than the balance fails, Zen still shows the rows that don't need it.
- The `opencode-quota/opencode.json` file and the `OPENCODE_WORKSPACE_ID` / `OPENCODE_AUTH_COOKIE` variables are not read.
