# opencode-quota

Quota and token tracking for OpenCode providers via Toasts and Commands with no LLM calls.

## What It Does

**Quota Toasts** - See your remaining quota at a glance after each assistant response.

![Image of quota toasts](https://github.com/slkiser/opencode-quota/blob/main/toast.png)

**Token Report Commands** - Track token usage and estimated costs across sessions.

![Image of /quota and /quota_daily outputs](https://github.com/slkiser/opencode-quota/blob/main/quota.png)

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

## Quick Start

Enable the providers you use:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-antigravity"],
    },
  },
}
```

That's it. Toasts appear automatically after main agent responses.

## Commands

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `/quota`         | Show current quota (verbose)                |
| `/quota_today`   | Token + cost report (today, local timezone) |
| `/quota_daily`   | Token + cost report (last 24 hours)         |
| `/quota_weekly`  | Token + cost report (last 7 days)           |
| `/quota_monthly` | Token + cost report (last 30 days)          |
| `/quota_all`     | Token + cost report (all history)           |
| `/quota_session` | Token + cost report (current session only)  |
| `/quota_status`  | Diagnostics (config, paths, pricing)        |

## Supported Providers

| Provider           | Config id            | Notes                                         |
| ------------------ | -------------------- | --------------------------------------------- |
| GitHub Copilot     | `copilot`            | Uses OpenCode auth\*                          |
| OpenAI (Plus/Pro)  | `openai`             | Uses OpenCode auth                            |
| Firmware AI        | `firmware`           | Uses OpenCode auth or API key                 |
| Chutes AI          | `chutes`             | Uses OpenCode auth or API key                 |
| Google Antigravity | `google-antigravity` | Multi-account via `opencode-antigravity-auth` |

### Firmware AI Setup

Firmware works automatically if OpenCode has Firmware configured. Alternatively, you can provide an API key in your `opencode.json`:

```jsonc
{
  "provider": {
    "firmware": {
      "options": {
        "apiKey": "{env:FIRMWARE_API_KEY}",
      },
    },
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["firmware"],
    },
  },
}
```

The `apiKey` field supports the `{env:VAR_NAME}` syntax to reference environment variables, or you can provide the key directly.

### Chutes AI Setup

Chutes works automatically if OpenCode has Chutes configured. Alternatively, you can provide an API key in your `opencode.json`:

```jsonc
{
  "provider": {
    "chutes": {
      "options": {
        "apiKey": "{env:CHUTES_API_KEY}",
      },
    },
  },
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["chutes"],
    },
  },
}
```

### GitHub Copilot Setup (optional)

Copilot works with no extra setup as long as OpenCode already has Copilot configured and logged in.

_Optional:_ if Copilot quota does not show up (or you want more reliable quota reporting), you can provide a fine-grained PAT so the plugin can use GitHub's public billing API:

1. Create a fine-grained PAT at GitHub with **Account permissions > Plan > Read**
2. Create `~/.config/opencode/copilot-quota-token.json`:

```json
{
  "token": "github_pat_...",
  "username": "your-username",
  "tier": "pro"
}
```

Tier options: `free`, `pro`, `pro+`, `business`, `enterprise`

\* The plugin reads Copilot auth from OpenCode. The PAT file is only a fallback for reliability.

## Configuration Reference

All options go under `experimental.quotaToast` in `opencode.json`:

| Option              | Default      | Description                                 |
| ------------------- | ------------ | ------------------------------------------- |
| `enabled`           | `true`       | Enable/disable plugin                       |
| `enableToast`       | `true`       | Show popup toasts                           |
| `enabledProviders`  | `[]`         | Provider ids to query                       |
| `minIntervalMs`     | `300000`     | Min ms between fetches (5 min)              |
| `toastDurationMs`   | `9000`       | Toast display time                          |
| `onlyCurrentModel`  | `false`      | Only show current model's quota             |
| `showSessionTokens` | `true`       | Show per-model input/output tokens in toast |
| `googleModels`      | `["CLAUDE"]` | Google models: `CLAUDE`, `G3PRO`, `G3FLASH` |
| `debug`             | `false`      | Show debug info in toasts                   |

### Example Configuration

Here's a complete example `opencode.json` with all common options:

```jsonc
{
  "plugin": ["@slkiser/opencode-quota"],
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai"],
      "showSessionTokens": true,
      "minIntervalMs": 300000,
      "toastDurationMs": 9000,
    },
  },
}
```

## Troubleshooting

Toast not appearing? Run `/quota_status` to check config and provider availability.

## License

MIT
