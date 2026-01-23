# opencode-quota

Quota and token tracking for OpenCode providers, via Toasts and Commands with no LLM calls.

## What It Does

**Quota Toasts** - See your remaining quota at a glance after each assistant response.

![Image of quota toasts](https://github.com/slkiser/opencode-quota/blob/main/toast.png)

**Token Reports** - Track token usage and estimated costs across sessions.

![Image of /quota and /quota_daily outputs](https://github.com/slkiser/opencode-quota/blob/main/quota.png)


## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-quota"]
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

| Command          | Description                          |
| ---------------- | ------------------------------------ |
| `/quota`         | Show current quota (verbose)         |
| `/quota_daily`   | Token + cost report (last 24 hours)  |
| `/quota_weekly`  | Token + cost report (last 7 days)    |
| `/quota_monthly` | Token + cost report (last 30 days)   |
| `/quota_all`     | Token + cost report (all history)    |
| `/quota_status`  | Diagnostics (config, paths, pricing) |

## Supported Providers

| Provider           | Config id            | Notes                                         |
| ------------------ | -------------------- | --------------------------------------------- |
| GitHub Copilot     | `copilot`            | Requires PAT setup (see below)                |
| OpenAI (Plus/Pro)  | `openai`             | Uses OpenCode auth                            |
| Firmware AI        | `firmware`           | Uses OpenCode auth                            |
| Google Antigravity | `google-antigravity` | Multi-account via `opencode-antigravity-auth` |

### GitHub Copilot Setup

Copilot requires a fine-grained PAT for reliable quota access:

1. Create a PAT at GitHub with **Account permissions > Plan > Read**
2. Create `~/.config/opencode/copilot-quota-token.json`:

```json
{
  "token": "github_pat_...",
  "username": "your-username",
  "tier": "pro"
}
```

Tier options: `free`, `pro`, `pro+`, `business`, `enterprise`

## Configuration Reference

All options go under `experimental.quotaToast` in `opencode.json`:

| Option             | Default      | Description                                 |
| ------------------ | ------------ | ------------------------------------------- |
| `enabled`          | `true`       | Enable/disable plugin                       |
| `enableToast`      | `true`       | Show popup toasts                           |
| `enabledProviders` | `[]`         | Provider ids to query                       |
| `minIntervalMs`    | `300000`     | Min ms between fetches (5 min)              |
| `toastDurationMs`  | `9000`       | Toast display time                          |
| `onlyCurrentModel` | `false`      | Only show current model's quota             |
| `googleModels`     | `["CLAUDE"]` | Google models: `CLAUDE`, `G3PRO`, `G3FLASH` |
| `debug`            | `false`      | Show debug info in toasts                   |

## Troubleshooting

Toast not appearing? Run `/quota_status` to check config and provider availability.

## License

MIT
