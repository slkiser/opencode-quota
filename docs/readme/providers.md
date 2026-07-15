# Providers

[← Back to README](../../README.md)

Supported providers and provider-specific setup notes.

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

### Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status.

`quotaProviders` is an ordered global-only array with one stable identity per definition. Run `opencode-quota provider add` to preview and maintain it in global OpenCode JSONC/JSON. Definitions run automatically with matching providers; manual provider selection uses the aggregate id `quota-providers`.

The definition `id` also identifies the OpenCode provider. Use `providerId` only when it differs. Project provider/model declarations remain read-only matching inputs and may override the normal global declaration for that project, but project quota endpoints, mappings, estimates, and credentials are never trusted.

#### Remote API mode

`mode: "remote-api"` supports two fixed safe formats:

- `openrouter-key-v1` expects OpenRouter's key response. A positive limit becomes a budget percentage; unlimited/no-limit usage becomes a spend value.
- `accounting-v1` expects `{ "version": "accounting-v1", "entries": [...] }`. Every entry has `kind`, `name`, and `resultType`; percent rows have `percentRemaining`, and value rows have `value`.

Example `accounting-v1` response:

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

The request is a fixed `GET` with bearer authentication and JSON accept headers. URLs must be absolute HTTPS, except loopback HTTP, and cannot contain embedded credentials, a query, fragment, whitespace, or control characters. Redirects are rejected. Responses require JSON content type, are limited to 256 KiB, and `accounting-v1` is limited to 100 rows.

#### Local estimate mode

`mode: "local-estimate"` counts matching OpenCode assistant requests from local storage. Each definition declares one to sixteen request windows:

- `type: "utc-day"` resets at UTC midnight.
- `type: "rolling"` requires `durationMinutes` and is bounded to 366 days.
- Every window requires `requestLimit`; `usdBudget` is optional and belongs to that same window.

Token pricing uses automatic models.dev matching first. `pricingModelMap` is accepted only for missing or ambiguous automatic matches and cannot override a successful match. When any request in a budget window cannot be priced, request usage remains visible and the budget row says it is unavailable.

State is stored per stable definition id under `~/.local/state/opencode/opencode-quota/quota-providers/`. Updates are versioned, deduplicated, pruned, serialized, and atomic; malformed files recover without using their contents.

#### Auth and security boundary

Credentials resolve from explicit `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then strict API-key OpenCode `auth.json`. Repo-local secrets are never read. User definitions cannot add methods, headers, templates, scripts, executable mappings, regular expressions, or JSONPath.

`modelIds` controls only exact `onlyCurrentModel` inclusion. Omit it for all models under `providerId`; otherwise list exact case-sensitive model ids without the provider prefix, such as `anthropic/claude-sonnet-4`.

A truly custom provider still needs its ordinary OpenCode provider/model declaration. `/connect` → **Other** stores only its credential. Maintained Qwen Code and Alibaba Coding Plan limits can instead be tuned with their reserved `quotaProviders` ids; no duplicate ordinary provider block is needed. `/quota_status` reports exact state paths and safe provenance, never URLs, keys, headers, bodies, counter contents, or raw errors.

## Provider setup notes

<a id="github-copilot"></a>

### GitHub Copilot

**`copilot-quota-token.json`** is a local billing credential file that you create. OpenCode and opencode-quota do not create it automatically. It exists because GitHub's public billing reports require billing permissions that are not part of OpenCode's normal Copilot OAuth login.

Put the file in the OpenCode runtime config directory shown by:

```bash
opencode debug paths
```

For a personal Copilot Max account, use:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "max",
  "username": "your-github-login"
}
```

The default `billingModel` is `"ai_credits"`. Supported tiers are `free`, `student`, `pro`, `pro+`, `max`, `business`, and `enterprise`.

Choose the credential and scope that match who pays for Copilot:

| Billing scope | Required config                                                                  | Officially supported credential                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal      | `tier` plus optional `username`                                                  | Fine-grained PAT with **Plan: read**, GitHub App user access token, or a supported classic credential                                                                                                    |
| Organization  | `"tier": "business"`, `organization`, optional `username` filter                 | Fine-grained PAT, GitHub App user token, or GitHub App installation token with **Organization administration: read**; classic credentials also work for an authorized organization admin/billing manager |
| Enterprise    | `"tier": "enterprise"`, `enterprise`, optional `organization`/`username` filters | Classic PAT held by an enterprise admin or billing manager; GitHub does not permit fine-grained PATs or GitHub App tokens                                                                                |

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

opencode-quota requests the current UTC calendar month from GitHub's public AI Credit usage report. It shows total AI Credits consumed, included-pool consumption, billed credits, billed spend when supplied, and an applicable organization/enterprise AI Credit budget when the budget API exposes one.

A percentage is shown only with a real denominator: GitHub's documented current Pro, Pro+, or Max personal allowance, or a positive API-reported additional-usage budget. Free and Student do not have a concrete public allowance, and organization/enterprise usage reports do not expose the included-pool total, so those rows stay value-only.

Legacy premium requests are not a fallback. They are available only for Copilot Pro or Pro+ subscribers on an existing annual plan that remained on request-based billing after June 1, 2026:

```json
{
  "token": "github_pat_REPLACE_ME",
  "tier": "pro+",
  "billingModel": "legacy_premium_requests",
  "username": "your-github-login"
}
```

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
