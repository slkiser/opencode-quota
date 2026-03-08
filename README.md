# Opencode Quota

`opencode-quota` gives you two things:

- Automatic quota toasts after assistant responses
- Manual `/quota` and `/tokens_*` commands for deeper local reporting with zero context window pollution

**Quota provider supports**: GitHub Copilot, OpenAI (Plus/Pro), Qwen Code, Chutes AI, Firmware AI, Google Antigravity, and Z.ai coding plan.

**Token provider supports**: All models and providers in [models.dev](https://models.dev).


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
- `/quota` for a grouped manual quota report such as `[OpenAI] (Pro)` or `[Copilot] (business)`
- `/tokens_*` commands backed by local OpenCode history and a local pricing snapshot
- No model calls to compute the toast or report output

## Common Install Patterns

### Basic install

If you already use Copilot, OpenAI, Firmware, Chutes, or Z.ai in OpenCode, start here:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

### Google Antigravity

Google quota support depends on the companion auth plugin:

```jsonc
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
}
```

### Qwen Code

Qwen quota support depends on the companion auth plugin:

```jsonc
{
  "plugin": ["opencode-qwencode-auth", "@slkiser/opencode-quota"]
}
```

## Commands

| Command | What it shows |
| --- | --- |
| `/quota` | Manual grouped quota report |
| `/quota_status` | Diagnostics: config, provider availability, account detection, pricing snapshot health |
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

`/quota` already uses grouped formatting by default, even if toast style stays `classic`.

## Provider Setup At A Glance

| Provider | Works automatically | Extra setup when needed |
| --- | --- | --- |
| GitHub Copilot | Personal usage via existing OpenCode auth | Add `copilot-quota-token.json` for managed org or enterprise billing |
| OpenAI | Yes | None |
| Qwen Code | Needs `opencode-qwencode-auth` | Local-only quota estimation, no remote Qwen quota API |
| Firmware AI | Usually yes | Optional API key |
| Chutes AI | Usually yes | Optional API key |
| Google Antigravity | Needs `opencode-antigravity-auth` | Multi-account account file lives in OpenCode runtime config |
| Z.ai | Yes | None |

## Provider-Specific Notes

<details>
<summary><strong>GitHub Copilot</strong></summary>

Personal Copilot quota works automatically when OpenCode is already signed in.

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
- If the PAT config is invalid, the plugin reports that error and does not silently fall back to OAuth.
- `business` requires `organization`.
- Enterprise premium usage does not support fine-grained PATs or GitHub App tokens. Use a supported enterprise token such as a classic PAT.

Useful checks:

- Run `/quota_status` and inspect `copilot_quota_auth`.
- Look for `billing_mode`, `billing_scope`, `effective_source`, and `billing_api_access_likely`.

</details>

<details>
<summary><strong>OpenAI</strong></summary>

No extra setup is required if OpenCode already has OpenAI or ChatGPT auth configured.

</details>

<details>
<summary><strong>Qwen Code</strong></summary>

Qwen support is local-only estimation. The plugin does not call an Alibaba quota API.

Current behavior:

- 1000 requests per UTC day
- 60 requests per rolling minute
- Counters increment on successful question-tool completions while the current model is `qwen-code/*`

State file path:

- `.../opencode/opencode-quota/qwen-local-quota.json`

Run `/quota_status` to verify auth detection and local counter status.

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
| `debug` | `false` | Include debug context in toast output |

## Token Pricing Snapshot

`/tokens_*` uses a local `models.dev` pricing snapshot.

Behavior:

- A bundled snapshot ships with the plugin for offline use.
- The plugin can refresh the local runtime snapshot when the data is stale.
- Reports continue to work if refresh fails.

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
5. If Google or Qwen support is expected, confirm the companion auth plugin is installed.

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

Only add explicit `enabledProviders` if you want to limit which providers are queried. Only add companion plugins when the user actually uses Google Antigravity or Qwen Code.

## License

MIT

## Remarks

Opencode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.
