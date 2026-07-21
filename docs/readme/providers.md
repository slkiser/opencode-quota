[← Back to README](../../README.md)

# Providers

Find your provider in the table. Open a setup note only when the table says **Needs setup**.

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

`mode: "remote-api"` accepts two formats:

- `openrouter-key-v1` reads OpenRouter's key response.
- `accounting-v1` reads the small JSON format below.

```json
{
  "version": "accounting-v1",
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

OpenCode Quota sends a fixed authenticated `GET`. The URL must use HTTPS, except for loopback testing. Redirects and URLs containing credentials, queries, or fragments are rejected. Responses must be JSON and are limited to 256 KiB. `accounting-v1` is limited to 100 rows.

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
