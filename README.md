# OpenCode Quota

`opencode-quota` gives you two things:

- Automatic quota toasts after assistant responses
- Manual `/quota`, `/pricing_refresh`, and `/tokens_*` commands for deeper local reporting with zero context window pollution

**Quota providers**: Anthropic (Claude), GitHub Copilot, OpenAI (Plus/Pro), Cursor, Qwen Code, Alibaba Coding Plan, Chutes AI, Firmware AI, Google Antigravity, Z.ai coding plan, and NanoGPT.

**Token reports**: All models and providers in [models.dev](https://models.dev), plus deterministic local pricing for Cursor Auto/Composer and Cursor model aliases that are not on models.dev.

<table>
  <tr>
    <td width="50%" align="center">Example of toast</td>
    <td width="50%" align="center">Example of <code>/tokens_weekly</code></td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/slkiser/opencode-quota/blob/main/toasts.webp" alt="Image of opencode-quota toast" />
    </td>
    <td width="50%">
      <img src="https://github.com/slkiser/opencode-quota/blob/main/tokens.webp" alt="Image of opencode-quota /tokens_weekly output" />
    </td>
  </tr>
</table>

`/tokens_*` output is computed from local OpenCode session history. Quota rows use each provider's existing local auth plus deterministic local state or live provider quota endpoints, depending on the provider.

## Quick Start

OpenCode `>= 1.2.0` is required. Add the plugin to your `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

Then:

1. Restart or reload OpenCode.
2. Run `/quota_status` to confirm provider detection.
3. Run `/quota` or `/tokens_today`.

That is enough for most installs. Providers are auto-detected from your existing OpenCode setup, and most providers work from your existing OpenCode auth. If a provider needs anything extra, use the setup table below.

<details>
<summary><strong>Example: Turn off auto-detection and choose providers</strong></summary>

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-antigravity"]
    }
  }
}
```

</details>

<details>
<summary><strong>Example: Grouped toast layout instead of the default classic toast</strong></summary>

```jsonc
{
  "experimental": {
    "quotaToast": {
      "toastStyle": "grouped"
    }
  }
}
```

</details>

### Provider Setup At A Glance

| Provider | Auto setup | How it works |
| --- | --- | --- |
| **Anthropic (Claude)** | Needs [quick setup](#anthropic-quick-setup) | Claude Code credentials or env. |
| **GitHub Copilot** | Usually | OpenCode auth; PAT only for managed billing. |
| **OpenAI** | Yes | OpenCode auth. |
| **Cursor** | Needs [quick setup](#cursor-quick-setup) | Companion auth plugin + `provider.cursor`. |
| **Qwen Code** | Needs [quick setup](#qwen-code-quick-setup) | Companion auth plugin. |
| **Alibaba Coding Plan** | Yes | OpenCode auth + local request estimation. |
| **Firmware AI** | Usually | User/global OpenCode config or env. |
| **Chutes AI** | Usually | User/global OpenCode config or env. |
| **NanoGPT** | Usually | User/global OpenCode config, env, or auth.json. |
| **Google Antigravity** | Needs [quick setup](#google-antigravity-quick-setup) | Companion auth plugin. |
| **Z.ai** | Yes | OpenCode auth. |

<a id="anthropic-quick-setup"></a>
<details>
<summary><strong>Quick setup: Anthropic (Claude)</strong></summary>

Anthropic quota support uses Claude Code credentials and surfaces the 5-hour and 7-day rate-limit windows.

Credential resolution order:

1. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
2. `CLAUDE_CODE_OAUTH_TOKEN` environment variable

OpenCode `auth.json` is not used for Anthropic quota resolution.

If Claude Code is already installed and authenticated, this usually works automatically. Otherwise:

1. Run Claude Code once so it writes `~/.claude/.credentials.json`.
2. If needed, set `CLAUDE_CODE_OAUTH_TOKEN` manually as a fallback.
3. Confirm OpenCode is configured with the `anthropic` provider.

For behavior details and troubleshooting, see [Anthropic notes](#anthropic-notes).

</details>

<a id="cursor-quick-setup"></a>
<details>
<summary><strong>Quick setup: Cursor</strong></summary>

Cursor quota support requires the `opencode-cursor-oauth` [plugin](https://github.com/ephraimduncan/opencode-cursor):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-cursor-oauth", "@slkiser/opencode-quota"],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  },
  "experimental": {
    "quotaToast": {
      "cursorPlan": "pro",
      "cursorBillingCycleStartDay": 7
    }
  }
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

Google quota support requires the `opencode-antigravity-auth` [plugin](https://github.com/NoeFabris/opencode-antigravity-auth):

```jsonc
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
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
  "plugin": ["opencode-qwencode-auth", "@slkiser/opencode-quota"]
}
```

For behavior details and troubleshooting, see [Qwen Code notes](#qwen-code-notes).

</details>

## Commands

| Command | What it shows |
| --- | --- |
| `/quota` | Manual grouped quota report with a local call timestamp |
| `/quota_status` | Concise diagnostics for config, provider availability, account detection, and pricing snapshot health |
| `/pricing_refresh` | Pull the local runtime pricing snapshot from `models.dev` on demand |
| `/tokens_today` | Tokens used today (calendar day) |
| `/tokens_daily` | Tokens used in the last 24 hours |
| `/tokens_weekly` | Tokens used in the last 7 days |
| `/tokens_monthly` | Tokens used in the last 30 days, including pricing sections |
| `/tokens_all` | Tokens used across all local history |
| `/tokens_session` | Tokens used in the current session |
| `/tokens_between` | Tokens used between two dates: `YYYY-MM-DD YYYY-MM-DD` |

There is no `/token` command. The reporting commands are the `/tokens_*` family.

## Provider-Specific Notes

<a id="anthropic-notes"></a>
<details>
<summary><strong>Anthropic (Claude)</strong></summary>

Quota is fetched from `GET https://api.anthropic.com/api/oauth/usage` using a Claude Code OAuth access token.

**Troubleshooting:**

| Problem | Solution |
| --- | --- |
| "No credentials found" | Run Claude Code once so it writes `~/.claude/.credentials.json`, or set `CLAUDE_CODE_OAUTH_TOKEN` |
| "Invalid or expired token" | Refresh `~/.claude/.credentials.json` by re-authenticating Claude Code, or update `CLAUDE_CODE_OAUTH_TOKEN` |
| Plugin not detected | Confirm OpenCode is configured with the `anthropic` provider |

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

See [Cursor quick setup](#cursor-quick-setup) for auth. Quota and token reporting stays local to OpenCode history and local pricing data.

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
      "cursorIncludedApiUsd": 120
    }
  }
}
```

</details>

<a id="qwen-code-notes"></a>
<details>
<summary><strong>Qwen Code</strong></summary>

See [Qwen Code quick setup](#qwen-code-quick-setup) for auth. Usage is local-only estimation for the free plan; the plugin does not call an Alibaba quota API.

- Free tier limits: `1000` requests per UTC day and `60` requests per rolling minute.
- Counters increment on successful question-tool completions while the current model is `qwen-code/*`.
- State file: `.../opencode/opencode-quota/qwen-local-quota.json`.
- Check `/quota_status` for auth detection, `qwen_local_plan`, and local counter state.

</details>

<a id="alibaba-coding-plan-notes"></a>
<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Uses native OpenCode auth from `alibaba` or `alibaba-coding-plan`. Quota is local request-count estimation with rolling windows.

- `lite`: `1200 / 5h`, `9000 / week`, `18000 / month`
- `pro`: `6000 / 5h`, `45000 / week`, `90000 / month`
- If auth omits `tier`, the plugin uses `experimental.quotaToast.alibabaCodingPlanTier`, which defaults to `lite`.
- Counters increment on successful question-tool completions while the current model is `alibaba/*` or `alibaba-cn/*`.
- State file: `.../opencode/opencode-quota/alibaba-coding-plan-local-quota.json`.
- `/quota_status` shows auth detection, resolved tier, state-file path, and current 5h/weekly/monthly usage.

Example fallback tier:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "alibabaCodingPlanTier": "lite"
    }
  }
}
```

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
        "apiKey": "{env:FIRMWARE_API_KEY}"
      }
    }
  }
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
        "apiKey": "{env:CHUTES_API_KEY}"
      }
    }
  }
}
```

</details>

<a id="google-antigravity-notes"></a>
<details>
<summary><strong>Google Antigravity</strong></summary>

See [Google Antigravity quick setup](#google-antigravity-quick-setup). Credentials live under the OpenCode runtime config directory.

If detection looks wrong, `/quota_status` prints the candidate paths checked for `antigravity-accounts.json`.

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
        "apiKey": "{env:NANOGPT_API_KEY}"
      }
    }
  }
}
```

</details>

## Configuration Reference

All plugin settings live under `experimental.quotaToast`.

Workspace-local config can still customize display/report behavior, but user/global config is authoritative for network-affecting settings such as `enabled`, `enabledProviders`, `minIntervalMs`, `pricingSnapshot`, `showOnIdle`, `showOnQuestion`, and `showOnCompact`.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the plugin. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are no-ops. |
| `enableToast` | `true` | Show popup toasts |
| `toastStyle` | `classic` | Toast layout: `classic` or `grouped` |
| `enabledProviders` | `"auto"` | Auto-detect providers, or set an explicit provider list |
| `minIntervalMs` | `300000` | Minimum fetch interval between provider updates |
| `toastDurationMs` | `9000` | Toast duration in milliseconds |
| `showOnIdle` | `true` | Show toast on idle trigger |
| `showOnQuestion` | `true` | Show toast after a question/assistant response |
| `showOnCompact` | `true` | Show toast after session compaction |
| `showOnBothFail` | `true` | Show a fallback toast when providers attempt and all fail |
| `onlyCurrentModel` | `false` | Filter to the current model when possible |
| `showSessionTokens` | `true` | Append current-session token totals to toast output |
| `layout.maxWidth` | `50` | Main formatting width target |
| `layout.narrowAt` | `42` | Compact layout breakpoint |
| `layout.tinyAt` | `32` | Tiny layout breakpoint |
| `googleModels` | `["CLAUDE"]` | Google model keys: `CLAUDE`, `G3PRO`, `G3FLASH`, `G3IMAGE` |
| `alibabaCodingPlanTier` | `"lite"` | Fallback Alibaba Coding Plan tier when auth does not include `tier` |
| `cursorPlan` | `"none"` | Cursor included API budget preset: `none`, `pro`, `pro-plus`, `ultra` |
| `cursorIncludedApiUsd` | unset | Override Cursor monthly included API budget in USD |
| `cursorBillingCycleStartDay` | unset | Local billing-cycle anchor day `1..28`; when unset, Cursor usage resets on the local calendar month |
| `pricingSnapshot.source` | `"auto"` | Token pricing snapshot selection: `auto`, `bundled`, or `runtime` |
| `pricingSnapshot.autoRefresh` | `5` | Refresh stale local pricing data after this many days |
| `debug` | `false` | Include debug context in toast output |

## Token Pricing Snapshot

`/tokens_*` uses a local `models.dev` pricing snapshot. A bundled snapshot ships for offline use, and Cursor `auto` and `composer*` pricing stays bundled because those ids are not on `models.dev`.

| `pricingSnapshot.source` | Active pricing behavior |
| --- | --- |
| `auto` | Newer runtime snapshot wins; otherwise bundled pricing stays active. |
| `bundled` | Packaged bundled snapshot stays active. |
| `runtime` | Runtime snapshot stays active when present; bundled pricing is fallback until one exists. |

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

The Anthropic provider uses the documented OAuth usage endpoint with Claude Code credentials from `~/.claude/.credentials.json` or `CLAUDE_CODE_OAUTH_TOKEN`.

## Star History

<a href="https://www.star-history.com/?repos=slkiser%2Fopencode-quota&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
 </picture>
</a>
