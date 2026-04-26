<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility for OpenCode.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>

[![OpenCode Quota sidebar](https://shawnkiser.com/opencode-quota/sidebar.webp)](https://github.com/slkiser/opencode-quota)

---

### Installation

```bash
# Automatic setup
npx @slkiser/opencode-quota init
```

> [!IMPORTANT]
> OpenCode `>= 1.4.3` and Node.js `>= 18` are required.

The installer is append-only and preserves existing config values. It asks where to install, which quota UI to enable, whether providers should be auto-detected, which quota display style to use, how percentages should be labeled, and whether session input/output tokens should appear in quota displays.

After install:

1. Restart OpenCode.
2. Run `/quota_status`.
3. Run `/quota`.
4. If you enabled the sidebar, open the session sidebar and confirm the `Quota` panel appears.

For a terminal-only quota glance:

```bash
npx @slkiser/opencode-quota show
# or, if installed/on PATH:
opencode-quota show --provider copilot
```

`show` is quota-only: no token/cost reports or `models.dev` refresh. Installer `None (commands and terminal only)` disables toast/sidebar but keeps `/quota`, `/tokens_*`, and terminal `show`.

### Manual Setup

Add the server plugin to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

If you also want the sidebar, add the same package to the `tui.json` or `tui.jsonc` file that OpenCode loads:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

All quota settings live in `opencode.json` or `opencode.jsonc`, not `tui.json`.

### What It Adds

- TUI sidebar panel with quota rows
- Popup quota toasts after assistant responses
- Manual `/quota`, `/quota_status`, and `/tokens_*` commands
- Terminal `opencode-quota show` command for a quota-only quick glance
- Local token reports using bundled and runtime `models.dev` pricing
- Cursor Auto/Composer and Cursor alias pricing that stays deterministic locally

<table>
  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/toast.webp" alt="OpenCode Quota popup toast" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/token.webp" alt="OpenCode Quota token report" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">Popup quota toast</td>
    <td width="50%" align="center"><code>/tokens_weekly</code> report</td>
  </tr>
</table>

### Providers

| Provider                | Auto setup?        | Setup / plugin order                                      | Quota source             |
| ----------------------- | ------------------ | --------------------------------------------------------- | ------------------------ |
| Anthropic (Claude)      | [Needs quick setup](#anthropic-claude-quick-setup) | Install and authenticate Claude CLI                       | Local CLI or OAuth usage |
| GitHub Copilot          | Usually automatic  | Existing OpenCode auth, or optional PAT config            | Remote API               |
| OpenAI                  | Automatic          | Existing OpenCode auth                                    | Remote API               |
| Cursor                  | [Needs quick setup](#cursor-quick-setup) | `["@playwo/opencode-cursor-oauth", "@slkiser/opencode-quota"]` | Local estimation         |
| Qwen Code               | [Needs quick setup](#qwen-code-quick-setup) | `["opencode-qwencode-auth", "@slkiser/opencode-quota"]`   | Local estimation         |
| Alibaba Coding Plan     | Automatic          | Existing OpenCode auth, global config, or env             | Local estimation         |
| MiniMax Coding Plan     | Automatic          | Existing OpenCode auth, global config, or env             | Remote API               |
| Kimi Code               | Automatic          | Existing OpenCode auth, global config, or env             | Remote API               |
| Chutes AI               | Usually automatic  | Existing OpenCode auth, global config, or env             | Remote API               |
| Synthetic               | Automatic          | Existing OpenCode auth, global config, or env             | Remote API               |
| Google Antigravity      | [Needs quick setup](#google-antigravity-quick-setup) | `["opencode-antigravity-auth", "@slkiser/opencode-quota"]` | Remote API               |
| Gemini CLI              | [Needs quick setup](#gemini-cli-quick-setup) | `["opencode-gemini-auth", "@slkiser/opencode-quota"]`    | Remote API               |
| Z.ai Coding Plan        | Automatic          | Existing OpenCode auth, global config, or env             | Remote API               |
| NanoGPT                 | Usually automatic  | Existing OpenCode auth, global config, or env             | Remote API               |
| OpenCode Go             | [Needs quick setup](#opencode-go-quick-setup) | Set workspace ID and `auth` cookie                        | Dashboard scraping       |

For companion auth providers, put the companion plugin first and `@slkiser/opencode-quota` second. The companion plugin handles login or token storage; OpenCode Quota reads that auth state and renders quota.

Providers are auto-detected by default. To choose providers explicitly:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-gemini-cli"],
    },
  },
}
```

### Display Options

Show every quota window instead of the default most-constrained window:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "formatStyle": "allWindows",
    },
  },
}
```

Show percentages as used instead of remaining in toasts and the sidebar:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "percentDisplayMode": "used",
    },
  },
}
```

Turn off popup toasts while keeping `/quota` and the sidebar:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enableToast": false,
    },
  },
}
```

### Commands

| Command               | What it shows                                      |
| --------------------- | -------------------------------------------------- |
| `opencode-quota show` | Terminal quota-only quick glance                   |
| `/quota`              | Detailed quota report                              |
| `/quota_status`       | Config, provider, auth, pricing, and live probes   |
| `/pricing_refresh`    | Refresh local runtime pricing from `models.dev`    |
| `/tokens_today`       | Tokens used today                                  |
| `/tokens_daily`       | Tokens used in the last 24 hours                   |
| `/tokens_weekly`      | Tokens used in the last 7 days                     |
| `/tokens_monthly`     | Tokens used in the last 30 days, including pricing |
| `/tokens_all`         | Tokens used across all local history               |
| `/tokens_session`     | Tokens used in the current session                 |
| `/tokens_session_all` | Current session plus descendant sessions           |
| `/tokens_between`     | Tokens used between `YYYY-MM-DD YYYY-MM-DD`        |

<a id="anthropic-claude-quick-setup"></a>

### Anthropic Quick Setup

Anthropic does not use a companion OpenCode plugin. Install Claude Code, authenticate it, and make sure `claude` is available on your `PATH`:

```bash
claude auth login
claude auth status
```

If Claude lives at a custom path, set `experimental.quotaToast.anthropicBinaryPath` in `opencode.json`.

### Companion Providers

Some providers need an auth companion plugin installed separately. Add the companion plugin first and `@slkiser/opencode-quota` second in `opencode.json` or `opencode.jsonc`.

<a id="cursor-quick-setup"></a>

#### Cursor

Companion plugin: `@playwo/opencode-cursor-oauth`

Add both plugins to `opencode.json`, with the Cursor auth plugin first:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@playwo/opencode-cursor-oauth", "@slkiser/opencode-quota"],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

Then authenticate Cursor once:

```bash
opencode auth login --provider cursor
```

<a id="qwen-code-quick-setup"></a>

#### Qwen Code

Companion plugin: `opencode-qwencode-auth`

Add both plugins to `opencode.json`, with the Qwen auth plugin first:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qwencode-auth", "@slkiser/opencode-quota"]
}
```

<a id="google-antigravity-quick-setup"></a>

#### Google Antigravity

Companion plugin: `opencode-antigravity-auth`

Add both plugins to `opencode.json`, with the Antigravity auth plugin first:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
}
```

<a id="gemini-cli-quick-setup"></a>

#### Gemini CLI

Companion plugin: `opencode-gemini-auth`

Add both plugins to `opencode.json`, with the Gemini auth plugin first. If you manually choose providers, include `google-gemini-cli`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-gemini-auth", "@slkiser/opencode-quota"],
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["google-gemini-cli"]
    }
  }
}
```

Then authenticate Google once:

```bash
opencode auth login --provider google
```

### OpenCode Go

<a id="opencode-go-quick-setup"></a>

OpenCode Go quota scrapes the dashboard and needs a workspace ID plus an `auth` cookie:

```bash
export OPENCODE_GO_WORKSPACE_ID="your-workspace-id"
export OPENCODE_GO_AUTH_COOKIE="your-auth-cookie"
```

Environment variables take precedence over the optional `opencode-go.json` config file. Run `/quota_status` to see the exact paths checked on your machine.

### Troubleshooting

If quota or token data looks wrong:

1. Run `/quota_status`.
2. Confirm the expected provider appears in the detected provider list.
3. Confirm OpenCode has already created `opencode.db` if token reports are empty.
4. Check companion plugins for Cursor, Qwen Code, Google Antigravity, and Gemini CLI.
5. Use the quick-setup link in the provider table for provider-specific auth and config notes.

### Provider Troubleshooting

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

Run `/quota_status` and check the Anthropic section.

| Symptom | Fix |
| --- | --- |
| `claude` not found | Install Claude Code and make sure `claude` is on your `PATH`. |
| Claude is installed at a custom path | Set `experimental.quotaToast.anthropicBinaryPath` in `opencode.json`. |
| Not authenticated | Run `claude auth login`, then confirm `claude auth status` works. |
| Auth works but no quota rows appear | Check `quota_source` and `message` in `/quota_status`; re-authenticate Claude if the OAuth credential fallback is missing or stale. |
| Provider not detected | Confirm OpenCode is configured to use the `anthropic` provider. |

</details>

<details>
<summary><strong>GitHub Copilot</strong></summary>

Run `/quota_status` and check `copilot_quota_auth`, `billing_mode`, `billing_scope`, and `quota_api`.

| Symptom | Fix |
| --- | --- |
| Personal quota missing | Confirm OpenCode Copilot auth works. The plugin can read OpenCode's Copilot OAuth token. |
| Business or Enterprise quota missing | Add `copilot-quota-token.json` in the OpenCode runtime config directory shown by `opencode debug paths`. |
| PAT config exists but quota fails | Fix `copilot-quota-token.json`; when present, it takes precedence over OAuth and does not silently fall back. |
| Enterprise usage missing | Use a classic PAT with the required billing access. Fine-grained PATs and GitHub App tokens are not supported for Enterprise premium usage. |

</details>

<details>
<summary><strong>OpenAI</strong></summary>

Run `/quota_status` and check the OpenAI auth source and token status.

| Symptom | Fix |
| --- | --- |
| OpenAI quota missing | Confirm OpenCode native OpenAI auth is present in `auth.json`. |
| Token expired | Re-run OpenCode's OpenAI auth flow. |
| Provider not detected | Confirm your OpenCode config uses the `openai` provider or a compatible OpenAI auth entry. |

</details>

<details>
<summary><strong>Cursor</strong></summary>

Run `/quota_status` and check the Cursor section.

| Symptom | Fix |
| --- | --- |
| Cursor not detected | Put `@playwo/opencode-cursor-oauth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Cursor auth missing | Run `opencode auth login --provider cursor`. |
| Quota appears but no remaining percentage | Set `experimental.quotaToast.cursorPlan` or `experimental.quotaToast.cursorIncludedApiUsd`. |
| Billing cycle looks wrong | Set `experimental.quotaToast.cursorBillingCycleStartDay` to your local billing anchor day. |
| Unknown Cursor pricing | Run `/pricing_refresh`; if still unknown, check `/quota_status` for unknown model ids. |

</details>

<details>
<summary><strong>Qwen Code</strong></summary>

Run `/quota_status` and check `qwen_oauth_source`, `qwen_local_plan`, and the `qwen_code` live probe section.

| Symptom | Fix |
| --- | --- |
| Qwen not detected | Put `opencode-qwencode-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Auth missing | Complete the Qwen companion plugin auth flow. |
| Counters do not move | Confirm the current model is `qwen-code/*`; Qwen quota is local request estimation for matching model usage. |
| Usage looks stale | Check the local state file path shown by `/quota_status`. |

</details>

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Run `/quota_status` and check the Alibaba auth, resolved tier, state-file path, and `alibaba_coding_plan` live probe section.

| Symptom | Fix |
| --- | --- |
| API key not detected | Use `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_API_KEY`, trusted user/global OpenCode config, or OpenCode auth. Repo-local provider secrets are ignored. |
| Wrong tier | Set `experimental.quotaToast.alibabaCodingPlanTier` to `lite` or `pro`. |
| Counters do not move | Confirm the current model is `alibaba/*` or `alibaba-cn/*`. |
| Quota seems stale | Check the state-file path shown in `/quota_status`. |

</details>

<details>
<summary><strong>MiniMax, Kimi, Chutes AI, Synthetic, Z.ai, and NanoGPT</strong></summary>

These providers use trusted env vars, trusted user/global OpenCode config, or native OpenCode auth. Run `/quota_status` and check the provider-specific API-key diagnostics.

| Provider | Useful checks |
| --- | --- |
| MiniMax Coding Plan | Use `MINIMAX_CODING_PLAN_API_KEY` or `MINIMAX_API_KEY`; repo-local provider secrets are ignored. |
| Kimi Code | Use `KIMI_API_KEY` or `KIMI_CODE_API_KEY`; repo-local provider secrets are ignored. |
| Chutes AI | Use `CHUTES_API_KEY` or trusted user/global config. |
| Synthetic | Use `SYNTHETIC_API_KEY`, trusted user/global config, or OpenCode auth. |
| Z.ai Coding Plan | Use `ZAI_API_KEY` or `ZAI_CODING_PLAN_API_KEY`; malformed fallback auth is surfaced as an auth error. |
| NanoGPT | Use `NANOGPT_API_KEY`, `NANO_GPT_API_KEY`, trusted user/global config, or OpenCode auth. |

For security, repo-local `opencode.json` / `opencode.jsonc` is ignored for provider secrets in these integrations. Put secrets in environment variables or trusted user/global config.

</details>

<details>
<summary><strong>Google Antigravity</strong></summary>

Run `/quota_status` and check the `google_antigravity` section.

| Symptom | Fix |
| --- | --- |
| Companion missing | Put `opencode-antigravity-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Accounts not found | Check the selected `antigravity-accounts.json` path shown by `/quota_status`. |
| Refresh tokens invalid | Re-authenticate with the companion plugin. |
| Provider returns no rows | Check `live_probe`, `live_entry_*`, and `live_error_*` in `/quota_status`. |

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

Run `/quota_status` and check the Gemini CLI live probe rows.

| Symptom | Fix |
| --- | --- |
| Companion missing | Put `opencode-gemini-auth` before `@slkiser/opencode-quota` in `opencode.json`. |
| Provider not enabled in manual mode | Include `google-gemini-cli` in `experimental.quotaToast.enabledProviders`. |
| Auth missing | Run `opencode auth login --provider google`. |
| Project missing | Set `provider.google.options.projectId`, `OPENCODE_GEMINI_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT`, or `GOOGLE_CLOUD_PROJECT_ID`. |

</details>

<details>
<summary><strong>OpenCode Go</strong></summary>

Run `/quota_status` and check the `opencode_go` section.

| Symptom | Fix |
| --- | --- |
| Config not detected | Set both `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE`, then rerun `/quota_status`. |
| Incomplete config | `workspaceId` and `authCookie` must come from the same source. |
| Scrape returns no data | Refresh the browser `auth` cookie from `opencode.ai`. |
| Dashboard format changed | This integration scrapes the dashboard, so it can break if the dashboard markup changes. |

</details>

<details>
<summary><strong>Token Reports</strong></summary>

Run `/quota_status` and check pricing snapshot health plus OpenCode database paths.

| Symptom | Fix |
| --- | --- |
| `/tokens_*` is empty | Start OpenCode once so it creates `opencode.db`, then run a session with model usage. |
| Pricing looks stale | Run `/pricing_refresh`. |
| Runtime pricing does not change output | Check `experimental.quotaToast.pricingSnapshot.source`; `bundled` keeps packaged pricing active. |
| Cursor model has unknown pricing | Run `/pricing_refresh`; Cursor `auto` and `composer*` use bundled deterministic pricing. |

</details>

### License

MIT

### Remarks

OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

### Star History

[![Star History Chart](https://api.star-history.com/chart?repos=slkiser/opencode-quota&type=date&legend=bottom-right)](https://www.star-history.com/?repos=slkiser%2Fopencode-quota&type=date&legend=bottom-right)
