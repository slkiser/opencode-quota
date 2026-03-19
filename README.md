# Opencode Quota

`opencode-quota` gives you two things:

- Automatic quota toasts after assistant responses
- Manual `/quota` and `/tokens_*` commands for deeper local reporting with zero context window pollution

**Quota provider supports**: GitHub Copilot, OpenAI (Plus/Pro), Cursor (ACP), Qwen Code, Alibaba Coding Plan, Chutes AI, Firmware AI, Google Antigravity, and Z.ai coding plan.

**Token provider supports**: All models and providers in [models.dev](https://models.dev), plus deterministic local pricing for Cursor Auto/Composer and Cursor model aliases that are not on models.dev.


![Image of quota toasts](https://github.com/slkiser/opencode-quota/blob/main/toast.png)

![Image of /quota and /tokens_daily outputs](https://github.com/slkiser/opencode-quota/blob/main/quota.png)

## Quick Start

OpenCode `>= 1.2.0` is required.

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

Then:

1. Restart or reload OpenCode.
2. Run `/quota_status` to confirm provider detection.
3. Run `/quota` to see the manual grouped report.

That is enough for most installs. Providers are auto-detected from your existing OpenCode setup.

## What You Get

- Toasts after assistant responses, idle transitions, and compaction events
- `/quota` for a grouped manual quota report such as `[OpenAI] (Pro)` or `[Copilot] (business)`, with a local call timestamp in the heading
- `/tokens_*` commands backed by local OpenCode history and a local pricing snapshot, each with a local call timestamp in the heading
- No model calls to compute the toast or report output

## Common Install Patterns

### Basic install

If you already use Copilot, OpenAI, Firmware, Chutes, or Z.ai in OpenCode, start here:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

### Cursor

Cursor model support requires the `opencode-cursor` [companion ACP plugin](https://github.com/Nomadcxx/opencode-cursor):

```jsonc
{
  "plugin": ["@rama_nigg/open-cursor", "@slkiser/opencode-quota"]
}
```

### Google Antigravity

Google quota support requires the `opencode-antigravity-auth` [companion auth plugin](https://github.com/NoeFabris/opencode-antigravity-auth):

```jsonc
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
}
```

### Qwen Code

Qwen quota support requires the `opencode-qwencode-auth` [companion auth plugin](https://github.com/gustavodiasdev/opencode-qwencode-auth):

```jsonc
{
  "plugin": ["opencode-qwencode-auth", "@slkiser/opencode-quota"]
}
```

Quota and `/tokens_*` output are computed from local OpenCode session history.

## Commands

| Command | What it shows |
| --- | --- |
| `/quota` | Manual grouped quota report with a local call timestamp |
| `/quota_status` | Concise diagnostics for config, provider availability, account detection, and pricing snapshot health |
| `/tokens_today` | Tokens used today (calendar day) |
| `/tokens_daily` | Tokens used in the last 24 hours |
| `/tokens_weekly` | Tokens used in the last 7 days |
| `/tokens_monthly` | Tokens used in the last 30 days, including pricing sections |
| `/tokens_all` | Tokens used across all local history |
| `/tokens_session` | Tokens used in the current session |
| `/tokens_between` | Tokens used between two dates: `YYYY-MM-DD YYYY-MM-DD` |

There is no `/token` command. The reporting commands are the `/tokens_*` family.

## Minimal Config

You do not need extra config to get started. If you want to narrow the plugin to specific providers, use:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-antigravity"]
    }
  }
}
```

If you want grouped toast layout instead of the default classic toast:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "toastStyle": "grouped"
    }
  }
}
```

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

`/quota` already uses grouped formatting by default, even if toast style stays `classic`.

## Provider Setup At A Glance

| Provider | Works automatically | Extra setup when needed |
| --- | --- | --- |
| GitHub Copilot | Usually yes | Add `copilot-quota-token.json` only for managed org or enterprise billing |
| OpenAI | Yes | None |
| Cursor | Needs `opencode-cursor` | Optional `cursorPlan`, `cursorIncludedApiUsd`, and `cursorBillingCycleStartDay` for monthly API budget tracking |
| Qwen Code | Needs `opencode-qwencode-auth` | Local free-tier request estimation |
| Alibaba Coding Plan | Yes | Local request-count estimation |
| Firmware AI | Usually yes | Optional API key |
| Chutes AI | Usually yes | Optional API key |
| Google Antigravity | Needs `opencode-antigravity-auth` | Multi-account account file lives in OpenCode runtime config |
| Z.ai | Yes | None |

## Provider-Specific Notes

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

<details>
<summary><strong>OpenAI</strong></summary>

No extra setup is required if OpenCode already has OpenAI or ChatGPT auth configured.

</details>

<details>
<summary><strong>Cursor</strong></summary>

Cursor support requires the `opencode-cursor` plugin and stays local-only and deterministic once `@rama_nigg/open-cursor` is installed in OpenCode.

Recommended install path:

- Follow Option B from the upstream [`opencode-cursor` README](https://github.com/Nomadcxx/opencode-cursor).
- Keep the Cursor model list in sync with `cursor-agent models`.

Current behavior:

- Detects Cursor usage from OpenCode history when the current model or stored message model is `cursor-acp/*`
- `/tokens_*` maps Cursor API-pool models into official pricing and uses bundled static rates for `auto` and `composer*`
- `/quota` and toasts estimate the current billing-cycle spend from local OpenCode history
- Percentage remaining is shown only when you configure `cursorPlan` or `cursorIncludedApiUsd`
- Billing cycle defaults to the local calendar month unless you set `cursorBillingCycleStartDay`

Notes:

- Session cookies and Cursor team APIs are not required for this local reporting path
- Unknown future Cursor model ids are surfaced in `/quota_status` under Cursor diagnostics and `unknown_pricing`

Example config for a personal Pro account:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "cursorPlan": "pro",
      "cursorBillingCycleStartDay": 7
    }
  }
}
```

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

<details>
<summary><strong>Alibaba Coding Plan</strong></summary>

Alibaba Coding Plan uses native OpenCode auth from either `alibaba` or `alibaba-coding-plan` in `auth.json`, instead of the Qwen companion plugin. Quota estimation is request-count based with rolling windows.

Supported tiers:

- `lite`: 1200 requests / 5 hours, 9000 / week, 18000 / month
- `pro`: 6000 requests / 5 hours, 45000 / week, 90000 / month
- If `tier` is missing from auth, the plugin uses `experimental.quotaToast.alibabaCodingPlanTier` and defaults that setting to `lite`
- Counters increment on successful question-tool completions while the current model is `alibaba/*` or `alibaba-cn/*`

State file path:

- `.../opencode/opencode-quota/alibaba-coding-plan-local-quota.json`

`/quota_status` shows whether Alibaba auth is configured, the resolved Alibaba coding-plan tier, the Alibaba state-file path, and the current 5h/weekly/monthly usage when this plan is active.

</details>

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

<details>
<summary><strong>Google Antigravity</strong></summary>

This provider requires the `opencode-antigravity-auth` plugin. Account credentials are stored under the OpenCode runtime config directory.

If you are debugging detection, `/quota_status` prints the candidate paths checked for `antigravity-accounts.json`.

</details>

<details>
<summary><strong>Z.ai</strong></summary>

No extra setup is required if OpenCode already has Z.ai configured.

</details>

## Configuration Reference

All plugin settings live under `experimental.quotaToast`.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the plugin. When `false`, `/quota`, `/quota_status`, and `/tokens_*` are no-ops. |
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
| `debug` | `false` | Include debug context in toast output |

## Token Pricing Snapshot

`/tokens_*` uses a local `models.dev` pricing snapshot plus bundled static Cursor pricing for Cursor-only pool models.

Behavior:

- A bundled snapshot ships with the plugin for offline use.
- The plugin can refresh the local runtime snapshot when the data is stale.
- Reports continue to work if refresh fails.
- Cursor `auto` and `composer*` pricing is bundled in the plugin because those ids are not on `models.dev`.

Useful environment variables:

```sh
OPENCODE_QUOTA_PRICING_AUTO_REFRESH=0
OPENCODE_QUOTA_PRICING_MAX_AGE_DAYS=5
```

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
5. If Google or Qwen support is expected, confirm the companion auth plugin is installed. If Alibaba Coding Plan support is expected, confirm OpenCode `alibaba` or `alibaba-coding-plan` auth is configured; `tier` may be `lite` or `pro`, and if it is missing the plugin falls back to `experimental.quotaToast.alibabaCodingPlanTier`.

If `opencode.db` is missing, start OpenCode once and let its local migration complete.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution workflow and repository policy.

## LLM Agent Installation Notes

If you are using an agent to install the plugin for you, the safe default is:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

Then verify with `/quota_status`.

Only add explicit `enabledProviders` if you want to limit which providers are queried. Only add companion plugins when the user actually uses Google Antigravity or Qwen Code, and only add `@rama_nigg/open-cursor` when the user actually uses Cursor models in OpenCode.

## License

MIT

## Remarks

Opencode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

## Star History

<a href="https://www.star-history.com/?repos=slkiser%2Fopencode-quota&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=slkiser/opencode-quota&type=date&legend=bottom-right" />
 </picture>
</a>
