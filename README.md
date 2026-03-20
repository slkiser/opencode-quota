# OpenCode Quota

`opencode-quota` gives you two things:

- Automatic quota toasts after assistant responses
- Manual `/quota`, `/pricing_refresh`, and `/tokens_*` commands for deeper local reporting with zero context window pollution

**Quota providers**: GitHub Copilot, OpenAI (Plus/Pro), Cursor, Qwen Code, Alibaba Coding Plan, Chutes AI, Firmware AI, Google Antigravity, and Z.ai coding plan.

**Token reports**: All models and providers in [models.dev](https://models.dev), plus deterministic local pricing for Cursor Auto/Composer and Cursor model aliases that are not on models.dev.

<table>
  <tr>
    <td width="50%" align="center">Quota toast and list of commands</td>
    <td width="50%" align="center"><code>/tokens_daily</code> output</td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/slkiser/opencode-quota/blob/main/toast.png" alt="Image of quota toasts" />
    </td>
    <td width="50%">
      <img src="https://github.com/slkiser/opencode-quota/blob/main/quota.png" alt="Image of /quota and /tokens_daily outputs" />
    </td>
  </tr>
</table>

Quota and `/tokens_*` output are computed from local OpenCode session history.

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
| GitHub Copilot | Usually | OpenCode auth; PAT only for managed billing. [Notes](#github-copilot-notes) |
| OpenAI | Yes | OpenCode auth. [Notes](#openai-notes) |
| Cursor | Needs quick setup. [Quick setup](#cursor-quick-setup) | OAuth companion plugin + `provider.cursor`. [Notes](#cursor-notes) |
| Qwen Code | Needs quick setup. [Quick setup](#qwen-code-quick-setup) | Companion auth plugin. [Notes](#qwen-code-notes) |
| Alibaba Coding Plan | Yes | Native OpenCode auth with local request estimation. [Notes](#alibaba-coding-plan-notes) |
| Firmware AI | Usually | OpenCode config; API key optional. [Notes](#firmware-ai-notes) |
| Chutes AI | Usually | OpenCode config; API key optional. [Notes](#chutes-ai-notes) |
| Google Antigravity | Needs quick setup. [Quick setup](#google-antigravity-quick-setup) | Companion auth plugin. [Notes](#google-antigravity-notes) |
| Z.ai | Yes | OpenCode auth. [Notes](#zai-notes) |

<a id="cursor-quick-setup"></a>
<details>
<summary><strong>Quick setup: Cursor</strong></summary>

Cursor quota support requires the [`opencode-cursor-oauth` companion auth plugin](https://github.com/ephraimduncan/opencode-cursor):

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

Google quota support requires the `opencode-antigravity-auth` [companion auth plugin](https://github.com/NoeFabris/opencode-antigravity-auth):

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

Qwen quota support requires the `opencode-qwencode-auth` [companion auth plugin](https://github.com/gustavodiasdev/opencode-qwencode-auth):

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

<a id="github-copilot-notes"></a>
<details>
<summary><strong>GitHub Copilot</strong></summary>

Personal Copilot quota works automatically when OpenCode is already signed in. When no `copilot-quota-token.json` exists, the plugin reads the OpenCode Copilot OAuth token from `~/.local/share/opencode/auth.json` and queries `GET https://api.github.com/copilot_internal/user` with `Authorization: Bearer <access token>`.

For managed billing, create `copilot-quota-token.json` under the OpenCode runtime config directory. You can find the directory with `opencode debug paths`.

Organization example:

```json
{
  "token": "github_pat_...",
  "tier": "business",
  "organization": "your-org-slug"
}
```

Enterprise example:

```json
{
  "token": "ghp_...",
  "tier": "enterprise",
  "enterprise": "your-enterprise-slug",
  "organization": "optional-org-filter",
  "username": "optional-user-filter"
}
```

Behavior notes:

- Personal output is labeled `[Copilot] (personal)`.
- Managed organization and enterprise output is labeled `[Copilot] (business)`.
- Managed output includes the org or enterprise slug in the value line so the billing scope is still visible.
- If both OpenCode OAuth and `copilot-quota-token.json` exist, the PAT config wins.
- If no PAT config exists, OpenCode Copilot OAuth is treated as personal quota auth via `/copilot_internal/user`.
- If the PAT config is invalid, the plugin reports that error and does not silently fall back to OAuth.
- `business` requires `organization`.
- Enterprise premium usage does not support fine-grained PATs or GitHub App tokens. Use a supported enterprise token such as a classic PAT.

Useful checks:

- Run `/quota_status` and inspect `copilot_quota_auth`.
- Look for `billing_mode`, `billing_scope`, `quota_api`, `effective_source`, and `billing_api_access_likely`.

</details>

<a id="openai-notes"></a>
<details>
<summary><strong>OpenAI</strong></summary>

No extra setup is required if OpenCode already has OpenAI or ChatGPT auth configured.

</details>

<a id="cursor-notes"></a>
<details>
<summary><strong>Cursor</strong></summary>

Cursor support targets the OAuth-based [`opencode-cursor`](https://github.com/ephraimduncan/opencode-cursor) plugin. For the fastest setup, use the combined Cursor config from Quick Start, then run `opencode auth login --provider cursor` once.

Restart or reload OpenCode, then run `/quota_status`.

Current behavior:

- Detects Cursor usage from local OpenCode history when the current provider is `cursor` or the stored/current model id is `cursor/*`
- `/tokens_*` maps Cursor API-pool models into official pricing and uses bundled static rates for `auto` and `composer*`
- `/quota` and toasts estimate the current billing-cycle spend from local OpenCode history
- Percentage remaining is shown only when you configure `cursorPlan` or `cursorIncludedApiUsd`
- Billing cycle defaults to the local calendar month unless you set `cursorBillingCycleStartDay`

Notes:

- If you only want usage tracking and do not care about Cursor budget percentage remaining, you can omit the `experimental.quotaToast` block or set `"cursorPlan": "none"`
- Cursor OAuth and proxy traffic are used by OpenCode itself, but this plugin still computes quota and token output only from local `opencode.db`, local `auth.json`, and the bundled/runtime pricing snapshot
- Session cookies and Cursor team APIs are not required for this local reporting path
- Legacy `cursor-acp/*` history remains readable for older installs, but new installs should use the OAuth plugin workflow
- Unknown future Cursor model ids are surfaced in `/quota_status` under Cursor diagnostics and `unknown_pricing`

If you need a custom included API budget, override it directly:

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

Qwen support is local-only estimation for the free plan. The plugin does not call an Alibaba quota API.

Current behavior:

- Free tier only: 1000 requests per UTC day
- Free tier only: 60 requests per rolling minute
- Counters increment on successful question-tool completions while the current model is `qwen-code/*`

State file path:

- `.../opencode/opencode-quota/qwen-local-quota.json`

Run `/quota_status` to verify auth detection, `qwen_local_plan`, and local counter status.

</details>

<a id="alibaba-coding-plan-notes"></a>
<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Alibaba Coding Plan uses native OpenCode auth from either `alibaba` or `alibaba-coding-plan` in `auth.json`, instead of the Qwen companion plugin. Quota estimation is request-count based with rolling windows.

Supported tiers:

- `lite`: 1200 requests / 5 hours, 9000 / week, 18000 / month
- `pro`: 6000 requests / 5 hours, 45000 / week, 90000 / month
- If `tier` is missing from auth, the plugin uses `experimental.quotaToast.alibabaCodingPlanTier` and defaults that setting to `lite`
- Counters increment on successful question-tool completions while the current model is `alibaba/*` or `alibaba-cn/*`

If Alibaba Coding Plan auth does not include a `tier`, you can set the fallback tier here:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "alibabaCodingPlanTier": "lite"
    }
  }
}
```

State file path:

- `.../opencode/opencode-quota/alibaba-coding-plan-local-quota.json`

`/quota_status` shows whether Alibaba auth is configured, the resolved Alibaba coding-plan tier, the Alibaba state-file path, and the current 5h/weekly/monthly usage when this plan is active.

</details>

<a id="firmware-ai-notes"></a>
<details>
<summary><strong>Firmware AI</strong></summary>

If OpenCode already has Firmware configured, it usually works automatically. You can also provide an API key:

```jsonc
{
  "provider": {
    "firmware": {
      "options": {
        "apiKey": "{env:FIRMWARE_API_KEY}"
      }
    }
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["firmware"]
    }
  }
}
```

`{env:VAR_NAME}` and direct keys are both supported.

</details>

<a id="chutes-ai-notes"></a>
<details>
<summary><strong>Chutes AI</strong></summary>

If OpenCode already has Chutes configured, it usually works automatically. You can also provide an API key:

```jsonc
{
  "provider": {
    "chutes": {
      "options": {
        "apiKey": "{env:CHUTES_API_KEY}"
      }
    }
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["chutes"]
    }
  }
}
```

</details>

<a id="google-antigravity-notes"></a>
<details>
<summary><strong>Google Antigravity</strong></summary>

This provider requires the `opencode-antigravity-auth` plugin. Account credentials are stored under the OpenCode runtime config directory.

If you are debugging detection, `/quota_status` prints the candidate paths checked for `antigravity-accounts.json`.

</details>

<a id="zai-notes"></a>
<details>
<summary><strong>Z.ai</strong></summary>

No extra setup is required if OpenCode already has Z.ai configured.

</details>

## Configuration Reference

All plugin settings live under `experimental.quotaToast`.

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

`/tokens_*` uses a local `models.dev` pricing snapshot plus bundled static Cursor pricing for Cursor-only pool models.

Behavior:

- A bundled snapshot ships with the plugin for offline use.
- `pricingSnapshot.source: "auto"` keeps the current default behavior: newer runtime snapshot wins, otherwise the bundled snapshot stays active.
- `pricingSnapshot.source: "bundled"` pins the packaged snapshot and ignores the runtime snapshot for active pricing.
- `pricingSnapshot.source: "runtime"` pins the local runtime snapshot when present and falls back to the bundled snapshot until a runtime snapshot exists.
- `pricingSnapshot.autoRefresh` controls how many days a local snapshot can age before the plugin refreshes it in the background.
- Run `/pricing_refresh` to pull a fresh local runtime snapshot from `models.dev` on demand.
- `/pricing_refresh` updates only the local runtime snapshot under the OpenCode cache directory. It does not rewrite the packaged bundled snapshot shipped in the plugin.
- When `pricingSnapshot.source` is `"bundled"`, `/pricing_refresh` still refreshes the local runtime cache, but active reports remain pinned to bundled pricing until you switch selection mode.
- Reports continue to work if refresh fails.
- Cursor `auto` and `composer*` pricing is bundled in the plugin because those ids are not on `models.dev`.
- Snapshot selection stays local and deterministic. This does not add custom remote URLs or arbitrary pricing sources.

Maintainer refresh commands:

```sh
npm run pricing:refresh
npm run pricing:refresh:if-stale
npm run build
```

## Troubleshooting

If something is missing or looks wrong:

1. Run `/quota_status`.
2. Confirm the expected provider appears in the detected provider list.
3. If token reports are empty, make sure OpenCode has already created `opencode.db`.
4. If Copilot managed billing is expected, confirm `copilot-quota-token.json` is present and valid.
5. If provider setup looks wrong, check [Provider Setup At A Glance](#provider-setup-at-a-glance) and [Provider-Specific Notes](#provider-specific-notes). For Google Antigravity or Qwen Code, confirm the companion auth plugin is installed. For Alibaba Coding Plan, confirm OpenCode `alibaba` or `alibaba-coding-plan` auth is configured; `tier` may be `lite` or `pro`, and if it is missing the plugin falls back to `experimental.quotaToast.alibabaCodingPlanTier`.

If `opencode.db` is missing, start OpenCode once and let its local migration complete.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

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
