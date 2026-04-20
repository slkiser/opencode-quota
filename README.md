# OpenCode Quota

[![npm version](https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota)](https://www.npmjs.com/package/@slkiser/opencode-quota)
[![npm downloads](https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota)](https://www.npmjs.com/package/@slkiser/opencode-quota)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?branch=main&label=CI)](https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933)](./package.json)

`opencode-quota` adds usage quota and token visibility to OpenCode with zero context-window pollution.

What you get:

- TUI sidebar panel with quota
- popup quota toasts after assistant responses
- manual `/quota`, `/quota_status`, and `/tokens_*` commands

**Quota providers**: Anthropic (Claude), GitHub Copilot, OpenAI (Plus/Pro), Cursor, Qwen Code, Alibaba Coding Plan, MiniMax Coding Plan, Kimi Code, Chutes AI, Firmware AI, Google Antigravity, Z.ai Coding Plan, NanoGPT, and OpenCode Go.

**Token reports**: All models and providers in [models.dev](https://models.dev), plus deterministic local pricing for Cursor Auto/Composer and Cursor model aliases that are not on models.dev.

<table>
  <tr>
    <td width="100%">
      <img src="https://shawnkiser.com/opencode-quota/sidebar.webp" alt="Image of opencode-quota /tokens_weekly output" />
    </td>
  </tr>
    <tr>
    <td width="100%" align="center">Example of TUI sidebar</td>
  </tr>
</table>

<table>

  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/toast.webp" alt="Image of opencode-quota toast" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/token.webp" alt="Image of opencode-quota /tokens_weekly output" />
    </td>
  </tr>
    <tr>
    <td width="50%" align="center">Example of popup toast</td>
    <td width="50%" align="center">Example of <code>/tokens_weekly</code></td>
  </tr>
</table>

OpenCode `>= 1.4.3` is required.

If you are coming back later:

- see [Provider Setup At A Glance](#provider-setup-at-a-glance) for provider-specific setup needs
- see [Commands](#commands) for the slash commands
- see [Configuration Reference](#configuration-reference) when you want to customize behavior
- see [Troubleshooting](#troubleshooting) if something does not appear or auto-detect correctly

## Installation

### Automatic setup (recommended)

```sh
npx @slkiser/opencode-quota init
```

The installer (append-only, preserves existing values) asks for:

- **Scope**: `Project` or `Global`
- **Quota UI**: `Toast`, `Sidebar`, `Toast + Sidebar`, or `None (manual /quota and /tokens_* only)`
- **Provider mode**: `Auto-detect` or `Manual select`
- **Layout style**: `classic` or `grouped`
- **Show session input/output tokens**: `Yes` or `No`

All quota settings live in `opencode.json` or `opencode.jsonc`. `tui.json` or `tui.jsonc` is only for loading the sidebar plugin.

### After install

1. Restart OpenCode.
2. Run `/quota_status`.
3. Run `/quota`.
4. If you chose `Sidebar` or `Toast + Sidebar`, open the session sidebar and confirm the `Quota` panel appears.

### Manual setup

You can install manually, but the installer is easier and safer.

1. Add the server plugin to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

2. If you also want the sidebar, add the same package to a `tui.json` or `tui.jsonc` file that OpenCode loads (commonly the same folder):

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

3. Optional settings still go in `opencode.json`, not `tui.json`.

Providers are auto-detected from your existing OpenCode setup by default, and most providers work from your existing OpenCode auth.

<details>
<summary><strong>Example: Sidebar only (turn off popup toasts)</strong></summary>

Keep the `tui.json` or `tui.jsonc` entry above and disable toasts in `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
  "experimental": {
    "quotaToast": {
      "enableToast": false,
    },
  },
}
```

</details>

<details>
<summary><strong>Example: Turn off auto-detection and choose providers</strong></summary>

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-antigravity"],
    },
  },
}
```

</details>

<details>
<summary><strong>Example: Grouped quota layout instead of the default classic layout</strong></summary>

```jsonc
{
  "experimental": {
    "quotaToast": {
      "formatStyle": "grouped",
    },
  },
}
```

</details>

## Provider Setup At A Glance

| Provider                | Auto setup                                           | Authentication                  | Quota                    |
| ----------------------- | ---------------------------------------------------- | ------------------------------- | ------------------------ |
| **Anthropic (Claude)**  | Needs [quick setup](#anthropic-quick-setup)          | Local CLI auth                  | Local CLI report         |
| **GitHub Copilot**      | Usually                                              | OpenCode auth or PAT            | Remote API               |
| **OpenAI**              | Yes                                                  | OpenCode auth                   | Remote API               |
| **Cursor**              | Needs [quick setup](#cursor-quick-setup)             | Companion auth                  | Local runtime accounting |
| **Qwen Code**           | Needs [quick setup](#qwen-code-quick-setup)          | Companion auth                  | Local estimation         |
| **Alibaba Coding Plan** | Yes                                                  | OpenCode auth/global config/env | Local estimation         |
| **Firmware AI**         | Usually                                              | OpenCode auth/global config/env | Remote API               |
| **Chutes AI**           | Usually                                              | OpenCode auth/global config/env | Remote API               |
| **Google Antigravity**  | Needs [quick setup](#google-antigravity-quick-setup) | Companion auth                  | Remote API               |
| **Z.ai**                | Yes                                                  | OpenCode auth/global config/env | Remote API               |
| **NanoGPT**             | Usually                                              | OpenCode auth/global config/env | Remote API               |
| **MiniMax Coding Plan** | Yes                                                  | OpenCode auth/global config/env | Remote API               |
| **Kimi Code**           | Yes                                                  | OpenCode auth/global config/env | Remote API               |
| **OpenCode Go**         | Needs [quick setup](#opencode-go-quick-setup)        | Env/config auth                 | Dashboard scraping       |

<a id="anthropic-quick-setup"></a>

<details>
<summary><strong>Quick setup: Anthropic (Claude)</strong></summary>

Anthropic quota support now checks the local Claude CLI instead of passing Claude consumer OAuth tokens directly to Anthropic APIs.

If Claude Code is already installed and authenticated, this usually works automatically. Otherwise:

1. Install Claude Code so `claude` is available on your `PATH`.
2. Run `claude auth login`.
3. Confirm `claude auth status` succeeds locally.
4. Confirm OpenCode is configured with the `anthropic` provider.

If Claude lives at a custom path, set `experimental.quotaToast.anthropicBinaryPath`. The default is `claude`.

If you use Anthropic via API key in OpenCode, model usage still works normally. This plugin only shows Anthropic quota rows when the local Claude CLI exposes quota windows.

For behavior details and troubleshooting, see [Anthropic notes](#anthropic-notes).

</details>

<a id="cursor-quick-setup"></a>

<details>
<summary><strong>Quick setup: Cursor</strong></summary>

Cursor quota support requires the `@playwo/opencode-cursor-oauth` [plugin](https://github.com/PoolPirate/opencode-cursor):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@playwo/opencode-cursor-oauth", "@slkiser/opencode-quota"],
  "provider": {
    "cursor": {
      "name": "Cursor",
    },
  },
  "experimental": {
    "quotaToast": {
      "cursorPlan": "pro",
      "cursorBillingCycleStartDay": 7,
    },
  },
}
```

Then authenticate once:

```sh
opencode auth login --provider cursor
```

For behavior details and troubleshooting, see [Cursor notes](#cursor-notes).

</details>

<a id="google-antigravity-quick-setup"></a>

<details>
<summary><strong>Quick setup: Google Antigravity</strong></summary>

Google quota support requires the `opencode-antigravity-auth` [plugin](https://github.com/NoeFabris/opencode-antigravity-auth). `@slkiser/opencode-quota` does not install that companion plugin transitively, so install/configure it separately and then enable both plugins:

```jsonc
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"],
}
```

For behavior details and troubleshooting, see [Google Antigravity notes](#google-antigravity-notes).

</details>

<a id="qwen-code-quick-setup"></a>

<details>
<summary><strong>Quick setup: Qwen Code</strong></summary>

Qwen quota support requires the `opencode-qwencode-auth` [plugin](https://github.com/gustavodiasdev/opencode-qwencode-auth):

```jsonc
{
  "plugin": ["opencode-qwencode-auth", "@slkiser/opencode-quota"],
}
```

For behavior details and troubleshooting, see [Qwen Code notes](#qwen-code-notes).

</details>

<a id="opencode-go-quick-setup"></a>

<details>
<summary><strong>Quick setup: OpenCode Go</strong></summary>

OpenCode Go quota scrapes the OpenCode Go dashboard. It requires a workspace ID and an auth cookie.

**Option A — Environment variables:**

```sh
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie"
```

**Option B — Config file** (for example, `~/.config/opencode/opencode-quota/opencode-go.json` on Linux or legacy macOS installs):

```json
{
  "workspaceId": "your-workspace-id",
  "authCookie": "your-auth-cookie"
}
```

To find these values:

1. **workspaceId** — Visit [opencode.ai](https://opencode.ai), open your workspace, and copy the workspace ID from the URL: `https://opencode.ai/workspace/<workspaceId>/go`.
2. **authCookie** — Open your browser DevTools on `opencode.ai`, go to Application → Cookies, and copy the value of the `auth` cookie.

Environment variables take precedence over the config file. Run `/quota_status` to see the exact config paths checked on your machine. For behavior details and troubleshooting, see [OpenCode Go notes](#opencode-go-notes).

</details>

## Commands

| Command               | What it shows                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/quota`              | Manual grouped quota report with a local call timestamp                                                          |
| `/quota_status`       | Concise diagnostics for config, TUI setup, provider availability, account detection, and pricing snapshot health |
| `/pricing_refresh`    | Pull the local runtime pricing snapshot from `models.dev` on demand                                              |
| `/tokens_today`       | Tokens used today (calendar day)                                                                                 |
| `/tokens_daily`       | Tokens used in the last 24 hours                                                                                 |
| `/tokens_weekly`      | Tokens used in the last 7 days                                                                                   |
| `/tokens_monthly`     | Tokens used in the last 30 days, including pricing sections                                                      |
| `/tokens_all`         | Tokens used across all local history                                                                             |
| `/tokens_session`     | Tokens used in the current session only                                                                          |
| `/tokens_session_all` | Tokens used in the current session plus all descendant child/subagent sessions                                   |
| `/tokens_between`     | Tokens used between two dates: `YYYY-MM-DD YYYY-MM-DD`                                                           |

## Provider-Specific Notes

<a id="anthropic-notes"></a>

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

The plugin probes the local Claude CLI with `anthropicBinaryPath --version` and `anthropicBinaryPath auth status`. By default `anthropicBinaryPath` is `claude`, so standard installs work without extra config. It does not pass Claude Free/Pro/Max OAuth tokens directly to Anthropic endpoints.

If the Claude CLI exposes 5-hour and 7-day quota windows in local structured output, the plugin shows them. If the CLI only exposes auth state, Anthropic quota rows are skipped and `/quota_status` explains why.

**Troubleshooting:**

| Problem                           | Solution                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `claude` not found                | Install Claude Code and make sure `claude` is on your `PATH`                                               |
| Claude installed at a custom path | Set `experimental.quotaToast.anthropicBinaryPath` to the Claude executable path                            |
| Not authenticated                 | Run `claude auth login`, then confirm `claude auth status` works                                           |
| Authenticated but no quota rows   | Your local Claude CLI version did not expose quota windows; run `/quota_status` for the exact probe result |
| Plugin not detected               | Confirm OpenCode is configured with the `anthropic` provider                                               |

</details>

<a id="github-copilot-notes"></a>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Personal quota works automatically when OpenCode is already signed in. Without `copilot-quota-token.json`, the plugin reads the OpenCode Copilot OAuth token from `~/.local/share/opencode/auth.json` and calls `GET https://api.github.com/copilot_internal/user`.

- Managed billing uses `copilot-quota-token.json` in the OpenCode runtime config directory (`opencode debug paths`). `business` requires `organization`; `enterprise` requires `enterprise` and can also filter by `organization` or `username`.
- `copilot-quota-token.json` takes precedence over OAuth. If the PAT config is invalid, the plugin reports that error and does not silently fall back.
- Output is labeled `[Copilot] (personal)` or `[Copilot] (business)`, and managed output includes the org or enterprise slug.
- Enterprise premium usage does not support fine-grained PATs or GitHub App tokens.
- Check `/quota_status` for `copilot_quota_auth`, `billing_mode`, `billing_scope`, `quota_api`, `effective_source`, and `billing_api_access_likely`.

Example `copilot-quota-token.json`:

```json
{
  "token": "github_pat_...",
  "tier": "business",
  "organization": "your-org-slug"
}
```

```json
{
  "token": "ghp_...",
  "tier": "enterprise",
  "enterprise": "your-enterprise-slug",
  "organization": "optional-org-filter",
  "username": "optional-user-filter"
}
```

</details>

<a id="cursor-notes"></a>

<details>
<summary><strong>Cursor</strong></summary>

See [Cursor quick setup](#cursor-quick-setup) for companion-plugin OAuth auth. The canonical companion package is `@playwo/opencode-cursor-oauth`; older plugin names such as `opencode-cursor-oauth`, `opencode-cursor`, and `cursor-acp` are still detected as compatibility aliases. Quota and token reporting stays local to OpenCode history and local pricing data.

- Detects Cursor usage when the provider is `cursor` or the stored/current model id is `cursor/*`.
- `/tokens_*` maps Cursor API-pool models to official pricing and uses bundled static pricing for `auto` and `composer*`.
- `/quota` and toasts estimate the current billing-cycle spend from local history only. Session cookies and team APIs are not required.
- Remaining percentage appears only when `experimental.quotaToast.cursorPlan` or `experimental.quotaToast.cursorIncludedApiUsd` is set. Billing cycle defaults to the local calendar month unless `experimental.quotaToast.cursorBillingCycleStartDay` is set.
- Legacy `cursor-acp/*` history remains readable. Unknown future Cursor model ids appear in `/quota_status` under Cursor diagnostics and `unknown_pricing`.

Example override:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "cursorPlan": "none",
      "cursorIncludedApiUsd": 120,
    },
  },
}
```

</details>

<a id="openai-notes"></a>

<details>
<summary><strong>OpenAI</strong></summary>

OpenAI uses native OpenCode OAuth from `auth.json`. The canonical auth family is OpenCode auth, not companion-plugin auth.

- Quota is fetched from the OpenAI usage API using the native OpenCode OAuth token stored under `openai` in `auth.json`.
- Older OpenCode installs may still have compatible OpenAI OAuth entries under `codex`, `chatgpt`, or `opencode`. Those remain supported for backward compatibility.
- `/quota_status` includes an `openai` section with the detected auth source, token status, expiry, and account details derived from the token when available.

</details>

<a id="qwen-code-notes"></a>

<details>
<summary><strong>Qwen Code</strong></summary>

See [Qwen Code quick setup](#qwen-code-quick-setup) for auth. Usage is local-only estimation for the free plan; the plugin does not call an Alibaba quota API.

- Free tier limits: `1000` requests per UTC day and `60` requests per rolling minute.
- The canonical companion auth key is `qwen-code`. Older installs may still use `opencode-qwencode-auth`, which remains a supported fallback.
- Counters increment on successful question-tool completions while the current model is `qwen-code/*`.
- State file: `.../opencode/opencode-quota/qwen-local-quota.json`.
- Check `/quota_status` for auth detection, `qwen_oauth_source`, `qwen_local_plan`, and local counter state.

</details>

<a id="alibaba-coding-plan-notes"></a>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Alibaba Coding Plan uses trusted env vars or trusted user/global OpenCode config first, then native OpenCode auth from `alibaba-coding-plan` or `alibaba` in `auth.json`. Quota is local request-count estimation with rolling windows.

- `lite`: `1200 / 5h`, `9000 / week`, `18000 / month`
- `pro`: `6000 / 5h`, `45000 / week`, `90000 / month`
- API key sources are `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`, trusted user/global `provider["alibaba-coding-plan"].options.apiKey` or `provider.alibaba.options.apiKey`, then `auth.json`.
- Repo-local `opencode.json` / `opencode.jsonc` is ignored for Alibaba secrets.
- Allowed env templates are limited to `{env:ALIBABA_CODING_PLAN_API_KEY}` and `{env:ALIBABA_API_KEY}`.
- If auth fallback wins and omits `tier`, or if env/config wins, the plugin uses `experimental.quotaToast.alibabaCodingPlanTier`, which defaults to `lite`.
- Counters increment on successful question-tool completions while the current model is `alibaba/*` or `alibaba-cn/*`.
- State file: `.../opencode/opencode-quota/alibaba-coding-plan-local-quota.json`.
- `/quota_status` shows auth detection, resolved tier, state-file path, and current 5h/weekly/monthly usage.

Example fallback tier:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "alibabaCodingPlanTier": "lite",
    },
  },
}
```

</details>

<a id="minimax-coding-plan-notes"></a>

<details>
<summary><strong>MiniMax Coding Plan</strong></summary>

MiniMax Coding Plan uses trusted env vars or trusted user/global OpenCode config first, then native OpenCode auth from `auth.json["minimax-coding-plan"]`. No additional plugin is required.

- `MiniMax-M*` models — rolling 5-hour interval + weekly
- API key sources are `MINIMAX_CODING_PLAN_API_KEY`, `MINIMAX_API_KEY`, trusted user/global `provider["minimax-coding-plan"].options.apiKey` or `provider.minimax.options.apiKey`, then `auth.json`.
- Repo-local `opencode.json` / `opencode.jsonc` is ignored for MiniMax secrets.
- Allowed env templates are limited to `{env:MINIMAX_CODING_PLAN_API_KEY}` and `{env:MINIMAX_API_KEY}`.
- When `auth.json` fallback wins, the plugin reads `key` first and falls back to `access`.
- `/quota_status` shows auth detection, API-key diagnostics, live quota state, and endpoint errors

</details>

<a id="kimi-code-notes"></a>

<details>
<summary><strong>Kimi Code</strong></summary>

Kimi Code uses trusted env vars or trusted user/global OpenCode config first, then native OpenCode auth from `auth.json["kimi-for-coding"]` or `auth.json["kimi-code"]`. No additional plugin is required.

- API key sources are `KIMI_API_KEY`, `KIMI_CODE_API_KEY`, trusted user/global `provider["kimi-for-coding"].options.apiKey` or `provider["kimi-code"].options.apiKey`, then `auth.json`.
- Repo-local `opencode.json` / `opencode.jsonc` is ignored for Kimi secrets.
- Allowed env templates are limited to `{env:KIMI_API_KEY}` and `{env:KIMI_CODE_API_KEY}`.
- The plugin calls `https://api.kimi.com/coding/v1/usages`.
- `/quota_status` shows auth detection, API-key diagnostics, live quota state, and endpoint errors.

</details>

<a id="zai-notes"></a>

<details>
<summary><strong>Z.ai</strong></summary>

Z.ai uses trusted env vars or trusted user/global OpenCode config first, then native OpenCode auth from `auth.json["zai-coding-plan"]`.

- API key sources are `ZAI_API_KEY`, `ZAI_CODING_PLAN_API_KEY`, trusted user/global `provider.zai.options.apiKey`, `provider["zai-coding-plan"].options.apiKey`, or `provider.glm.options.apiKey`, then `auth.json`.
- Repo-local `opencode.json` / `opencode.jsonc` is ignored for Z.ai secrets.
- Allowed env templates are limited to `{env:ZAI_API_KEY}` and `{env:ZAI_CODING_PLAN_API_KEY}`.
- `/quota_status` shows auth diagnostics plus live 5-hour, weekly, and MCP quota windows when the Z.ai API reports them.
- Malformed `zai-coding-plan` fallback auth is surfaced as an auth error instead of being silently treated as missing.

</details>

<a id="firmware-ai-notes"></a>

<details>
<summary><strong>Firmware AI</strong></summary>

If OpenCode already has Firmware configured, it usually works automatically. Optional API key: `provider.firmware.options.apiKey`.

For security, provider secrets are read from environment variables or your user/global OpenCode config only. Repo-local `opencode.json` / `opencode.jsonc` is ignored for `provider.firmware.options.apiKey`.

Allowed env templates are limited to `{env:FIRMWARE_AI_API_KEY}` and `{env:FIRMWARE_API_KEY}`.

Example user/global config (`~/.config/opencode/opencode.jsonc` on Linux/macOS):

```jsonc
{
  "provider": {
    "firmware": {
      "options": {
        "apiKey": "{env:FIRMWARE_API_KEY}",
      },
    },
  },
}
```

</details>

<a id="chutes-ai-notes"></a>

<details>
<summary><strong>Chutes AI</strong></summary>

If OpenCode already has Chutes configured, it usually works automatically. Optional API key: `provider.chutes.options.apiKey`.

For security, provider secrets are read from environment variables or your user/global OpenCode config only. Repo-local `opencode.json` / `opencode.jsonc` is ignored for `provider.chutes.options.apiKey`.

Allowed env templates are limited to `{env:CHUTES_API_KEY}`.

Example user/global config (`~/.config/opencode/opencode.jsonc` on Linux/macOS):

```jsonc
{
  "provider": {
    "chutes": {
      "options": {
        "apiKey": "{env:CHUTES_API_KEY}",
      },
    },
  },
}
```

</details>

<a id="google-antigravity-notes"></a>

<details>
<summary><strong>Google Antigravity</strong></summary>

See [Google Antigravity quick setup](#google-antigravity-quick-setup). This companion auth flow does not use `auth.json`; it reads `antigravity-accounts.json` from the OpenCode runtime directories. `@slkiser/opencode-quota` expects the companion plugin to be installed separately.

- `/quota_status` includes a `google_antigravity` section with the selected accounts path, all present/candidate paths, account counts, valid refresh-token counts, companion package state/path, and the Google token-cache path.
- If the companion plugin is missing or incompatible, `/quota_status` shows `companion_package_state` and `companion_error`.
- If detection looks wrong, start with the `google_antigravity` section in `/quota_status`.

</details>

<a id="nanogpt-notes"></a>

<details>
<summary><strong>NanoGPT</strong></summary>

NanoGPT uses live NanoGPT subscription usage and balance endpoints, so `/quota`, grouped/classic toasts, and `/quota_status` can show daily quota, monthly quota, and account balance in real time.

- Canonical provider id is `nanogpt`. Alias `nano-gpt` also normalizes in `enabledProviders`.
- Optional API key: `provider.nanogpt.options.apiKey` or `provider["nano-gpt"].options.apiKey`.
- For security, provider secrets are read from `NANOGPT_API_KEY`, `NANO_GPT_API_KEY`, your user/global OpenCode config, or `auth.json`. Repo-local `opencode.json` / `opencode.jsonc` is ignored for NanoGPT secrets.
- Allowed env templates are limited to `{env:NANOGPT_API_KEY}` and `{env:NANO_GPT_API_KEY}`.
- `/quota_status` prints a `nanogpt` section with API-key diagnostics, auth candidate paths, live subscription state, daily/monthly usage windows, endpoint errors, and balance details.
- NanoGPT quota reflects subscription-covered requests and account balance. It is not token-priced in `/tokens_*`.

Example user/global config (`~/.config/opencode/opencode.jsonc` on Linux/macOS):

```jsonc
{
  "provider": {
    "nanogpt": {
      "options": {
        "apiKey": "{env:NANOGPT_API_KEY}",
      },
    },
  },
}
```

</details>

<a id="opencode-go-notes"></a>

<details>
<summary><strong>OpenCode Go</strong></summary>

OpenCode Go quota scrapes the OpenCode Go dashboard at `https://opencode.ai/workspace/<workspaceId>/go` using an `auth` cookie. There is no official usage API yet; the plugin parses the SolidJS SSR hydration output for `monthlyUsage` data.

- **Config sources** (checked in order):
  1. Environment variables: `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`
  2. Config file: for example `~/.config/opencode/opencode-quota/opencode-go.json` on Linux or legacy macOS installs, with `{ "workspaceId": "...", "authCookie": "..." }`
- Environment variables take precedence. Both `workspaceId` and `authCookie` must come from the same source.
- Quota returns a usage percentage and a reset countdown. There is no absolute request count.
- `/quota_status` shows an `opencode_go` section with config state, config source, checked paths, and live scrape results or errors.
- Because this is a scraper, it may break if OpenCode changes their dashboard markup. An official API ([opencode#16513](https://github.com/anomalyco/opencode/pull/16513)) is pending.

**Troubleshooting:**

| Problem                  | Solution                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Config not detected      | Confirm `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` are set, then use `/quota_status` to inspect the exact config paths checked on your machine |
| Incomplete config        | Both `workspaceId` and `authCookie` are required; check `/quota_status` for which field is missing                                                           |
| Scrape returns no data   | The auth cookie may have expired; get a fresh one from your browser                                                                                          |
| Dashboard format changed | The SolidJS SSR pattern may have changed; file an issue or wait for the official API                                                                         |

</details>

## Configuration Reference

All quota plugin settings live under `experimental.quotaToast` in `opencode.json` or `opencode.jsonc`. The sidebar install step is separate: add the package to `tui.json` or `tui.jsonc`, or choose `Sidebar` or `Toast + Sidebar` in `npx @slkiser/opencode-quota init`.

When both are present, user/global config provides defaults. Project/workspace config may override display-oriented settings for that project, but user/global config remains authoritative for automatic/network-affecting settings such as `enabled`, `enabledProviders`, `minIntervalMs`, `pricingSnapshot.*`, `showOnIdle`, `showOnQuestion`, `showOnCompact`, and `showOnBothFail`. SDK config is only used when no config files are found.

### Core/shared settings

| Option                        | Default   | Meaning                                                                                                                                                                                                      |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                     | `true`    | Master switch for quota collection and handled slash commands. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are handled as no-ops.                                           |
| `enabledProviders`            | `"auto"`  | Auto-detect providers, or set an explicit provider list.                                                                                                                                                     |
| `minIntervalMs`               | `300000`  | Minimum fetch interval between provider updates.                                                                                                                                                             |
| `formatStyle`                 | `classic` | Shared quota-row style for popup toasts and the TUI sidebar: `classic` or `grouped`. Legacy `toastStyle` is still accepted on read for backward compatibility, but `formatStyle` is the canonical key.       |
| `onlyCurrentModel`            | `false`   | Filter quota rows to the current model/provider when that session selection can be resolved.                                                                                                                 |
| `showSessionTokens`           | `true`    | Show the `Session input/output tokens` section in quota displays when session token data is available. Toasts and `/quota` show per-model input/output rows; the TUI sidebar shows a one-line total summary. |
| `pricingSnapshot.source`      | `"auto"`  | Token pricing snapshot selection for `/tokens_*`: `auto`, `bundled`, or `runtime`.                                                                                                                           |
| `pricingSnapshot.autoRefresh` | `7`       | Refresh stale local pricing data after this many days.                                                                                                                                                       |

### Toast settings

| Option            | Default | Meaning                                                                         |
| ----------------- | ------- | ------------------------------------------------------------------------------- |
| `enableToast`     | `true`  | Show popup toasts. Disabling this does not disable `/quota` or the TUI sidebar. |
| `toastDurationMs` | `9000`  | Toast duration in milliseconds.                                                 |
| `showOnIdle`      | `true`  | Show a toast on the idle trigger.                                               |
| `showOnQuestion`  | `true`  | Show a toast after a question/assistant response.                               |
| `showOnCompact`   | `true`  | Show a toast after session compaction.                                          |
| `showOnBothFail`  | `true`  | Show a fallback toast when providers attempted quota reads and all failed.      |
| `layout.maxWidth` | `50`    | Toast formatting width target. Ignored by the TUI sidebar.                      |
| `layout.narrowAt` | `42`    | Toast compact-layout breakpoint. Ignored by the TUI sidebar.                    |
| `layout.tinyAt`   | `32`    | Toast tiny-layout breakpoint. Ignored by the TUI sidebar.                       |
| `debug`           | `false` | Append toast debug context when troubleshooting.                                |

### TUI sidebar setup

If you want the `Quota` sidebar panel, you need **two files**:

1. **`tui.json` or `tui.jsonc`**: add the plugin entry so OpenCode mounts the sidebar panel.
2. **`opencode.json` or `opencode.jsonc`**: put all quota settings under `experimental.quotaToast`.

**Important:** `experimental.quotaToast.*` settings do **not** go in `tui.json`. `tui.json` is only for loading the TUI plugin.

| File                               | What goes there                          | Needed for sidebar? |
| ---------------------------------- | ---------------------------------------- | ------------------- |
| `tui.json` / `tui.jsonc`           | `plugin: ["@slkiser/opencode-quota"]`    | Yes                 |
| `opencode.json` / `opencode.jsonc` | All `experimental.quotaToast.*` settings | Yes                 |

### Provider-specific settings

| Option                       | Default      | Meaning                                                                                              |
| ---------------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `anthropicBinaryPath`        | `"claude"`   | Command/path used for local Claude CLI probing; override this for custom installs or shim locations. |
| `googleModels`               | `["CLAUDE"]` | Google model keys to query: `CLAUDE`, `G3PRO`, `G3FLASH`, `G3IMAGE`.                                 |
| `alibabaCodingPlanTier`      | `"lite"`     | Fallback Alibaba Coding Plan tier when auth does not include `tier`.                                 |
| `cursorPlan`                 | `"none"`     | Cursor included API budget preset: `none`, `pro`, `pro-plus`, `ultra`.                               |
| `cursorIncludedApiUsd`       | unset        | Override Cursor monthly included API budget in USD.                                                  |
| `cursorBillingCycleStartDay` | unset        | Local billing-cycle anchor day `1..28`; when unset, Cursor usage resets on the local calendar month. |

## Token Pricing Snapshot

`/tokens_*` uses a local `models.dev` pricing snapshot. A bundled snapshot ships for offline use, and Cursor `auto` and `composer*` pricing stays bundled because those ids are not on `models.dev`.

| `pricingSnapshot.source` | Active pricing behavior                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `auto`                   | Newer runtime snapshot wins; otherwise bundled pricing stays active.                      |
| `bundled`                | Packaged bundled snapshot stays active.                                                   |
| `runtime`                | Runtime snapshot stays active when present; bundled pricing is fallback until one exists. |

- See [Configuration Reference](#configuration-reference) for option defaults.
- `pricingSnapshot.autoRefresh` controls how many days a runtime snapshot can age before background refresh.
- `/pricing_refresh` refreshes only the local runtime snapshot under the OpenCode cache directory. It never rewrites the packaged bundled snapshot.
- If `pricingSnapshot.source` is `bundled`, `/pricing_refresh` still updates the runtime cache, but active pricing stays bundled.
- Reports keep working if refresh fails.
- Pricing selection stays local and deterministic. There are no custom URLs or arbitrary pricing sources.

## Troubleshooting

If something is missing or looks wrong:

1. Run `/quota_status`.
2. Confirm the expected provider appears in the detected provider list.
3. If token reports are empty, make sure OpenCode has already created `opencode.db`.
4. If Copilot managed billing is expected, confirm `copilot-quota-token.json` is present and valid.
5. If provider setup looks wrong, check [Provider Setup At A Glance](#provider-setup-at-a-glance) and [Provider-Specific Notes](#provider-specific-notes). For Google Antigravity or Qwen Code, confirm the companion auth plugin is installed. For Alibaba Coding Plan, confirm OpenCode `alibaba` or `alibaba-coding-plan` auth is configured; `tier` may be `lite` or `pro`, and if it is missing the plugin falls back to `experimental.quotaToast.alibabaCodingPlanTier`.

If `opencode.db` is missing, start OpenCode once and let its local migration complete.

## Contribution

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow and repository policy.

## License

MIT

## Remarks

OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

## Star History

<a href="https://www.star-history.com/?repos=slkiser%2Fopencode-quota&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
 </picture>
</a>
