# Opencode Quota

Monitor quota and tokens for OpenCode providers via Toasts and Commands. Zero LLM calls, zero context pollution.

## What It Does

**Quota Toasts** - See your remaining quota at a glance after each assistant response.

![Image of quota toasts](https://github.com/slkiser/opencode-quota/blob/main/toast.png)

**Token Report Commands** - Track token usage and estimated costs across sessions.

![Image of /quota and /tokens_daily outputs](https://github.com/slkiser/opencode-quota/blob/main/quota.png)

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

That's it. Providers are auto-detected based on your OpenCode configuration. Toasts appear automatically after assistant responses.

**Optional:** To restrict which providers are queried, set `enabledProviders` explicitly:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "openai", "google-antigravity"],
    },
  },
}
```

> **LLM Agents:** Ask your agent to install `https://github.com/slkiser/opencode-quota` with the providers you have enabled. See [LLM Agent Installation Instructions](#llm-agent-installation-instructions) for details.

## Commands

| Command                  | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `/quota`                 | Show quota toast (verbose)                       |
| `/quota_status`          | Show diagnostics (config, providers, accounts)   |
|                          |                                                  |
| `/tokens_today`          | Tokens used today (calendar day)                 |
| `/tokens_daily`          | Tokens used in last 24 hours                     |
| `/tokens_weekly`         | Tokens used in last 7 days                       |
| `/tokens_monthly`        | Tokens used in last 30 days                      |
| `/tokens_all`            | Tokens used all time                             |
| `/tokens_session`        | Tokens used in current session                   |
| `/tokens_between`        | Tokens between two dates (YYYY-MM-DD)            |
|                          |                                                  |
| `/firmware_reset_window` | Resets Firmware 5-hour window (requires confirm) |

## Supported Providers

| Provider           | Config ID            | Auth Source                                   |
| ------------------ | -------------------- | --------------------------------------------- |
| GitHub Copilot     | `copilot`            | OpenCode auth (automatic)                     |
| OpenAI (Plus/Pro)  | `openai`             | OpenCode auth (automatic)                     |
| Firmware AI        | `firmware`           | OpenCode auth or API key                      |
| Chutes AI          | `chutes`             | OpenCode auth or API key                      |
| Google Antigravity | `google-antigravity` | Multi-account via `opencode-antigravity-auth` |

### Provider-Specific Setup

<details>
<summary><strong>GitHub Copilot</strong> (usually no setup needed)</summary>

Copilot works automatically if OpenCode has Copilot configured and logged in.

**Optional:** For more reliable quota reporting, provide a fine-grained PAT:

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

</details>

<details>
<summary><strong>OpenAI</strong> (no setup needed)</summary>

OpenAI works automatically if OpenCode has OpenAI/ChatGPT configured.

</details>

<details>
<summary><strong>Firmware AI</strong></summary>

Works automatically if OpenCode has Firmware configured. Alternatively, provide an API key:

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

The `apiKey` field supports `{env:VAR_NAME}` syntax or a direct key.

**Firmware-specific command:** Use `/firmware_reset_window confirm` to reset your 5-hour spending window (consumes 1 of 2 weekly resets). Running without `confirm` shows a warning first.

</details>

<details>
<summary><strong>Chutes AI</strong></summary>

Works automatically if OpenCode has Chutes configured. Alternatively, provide an API key:

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

</details>

<details>
<summary><strong>Google Antigravity</strong></summary>

Requires the `opencode-antigravity-auth` plugin for multi-account support:

```json
{
  "plugin": ["opencode-antigravity-auth", "@slkiser/opencode-quota"]
}
```

Account credentials are stored in `~/.config/opencode/antigravity-accounts.json`.

</details>

## Configuration Reference

All options go under `experimental.quotaToast` in `opencode.json`:

| Option              | Default      | Description                                     |
| ------------------- | ------------ | ----------------------------------------------- |
| `enabled`           | `true`       | Enable/disable plugin                           |
| `enableToast`       | `true`       | Show popup toasts                               |
| `enabledProviders`  | `"auto"`     | Provider IDs to query, or `"auto"` to detect    |
| `minIntervalMs`     | `300000`     | Minimum ms between API fetches (default: 5 min) |
| `toastDurationMs`   | `9000`       | How long toasts display (ms)                    |
| `onlyCurrentModel`  | `false`      | Only show quota for the current model           |
| `showSessionTokens` | `true`       | Show per-model input/output tokens in toast     |
| `googleModels`      | `["CLAUDE"]` | Google models: `CLAUDE`, `G3PRO`, `G3FLASH`     |
| `debug`             | `false`      | Show debug info in toasts                       |

## Troubleshooting

Toast not appearing? Run `/quota_status` to check config and provider availability.

---

<details id="llm-agent-installation-instructions">
<summary><strong>LLM Agent Installation Instructions</strong></summary>

### For LLM Agents: How to Install and Configure

This section provides instructions for LLM agents to install and configure `opencode-quota` based on the user's current OpenCode setup.

#### Step 1: Check Current Configuration

First, determine what providers the user has connected. You can:

1. Read the user's `opencode.json` (typically at `~/.config/opencode/opencode.json`)
2. Run `/connected` in OpenCode to see active providers
3. Ask the user which providers they use

#### Step 2: Install the Plugin

Add the plugin to the user's `opencode.json`:

```json
{
  "plugin": ["@slkiser/opencode-quota"]
}
```

If the user already has plugins, append to the existing array.

#### Step 3: Configure Providers (Optional)

By default, providers are auto-detected. If the user wants to restrict which providers are queried, add explicit `enabledProviders`:

```jsonc
{
  "experimental": {
    "quotaToast": {
      "enabledProviders": [
        // Add only the providers the user has configured:
        // "copilot"            - if using GitHub Copilot
        // "openai"             - if using OpenAI/ChatGPT
        // "firmware"           - if using Firmware AI
        // "chutes"             - if using Chutes AI
        // "google-antigravity" - if using Google Antigravity (requires opencode-antigravity-auth)
      ],
    },
  },
}
```

#### Provider Detection Guide

| If user's config has...                     | Add to enabledProviders |
| ------------------------------------------- | ----------------------- |
| `github-copilot` provider or Copilot models | `"copilot"`             |
| `openai` / `chatgpt` provider               | `"openai"`              |
| `firmware` / `firmware-ai` provider         | `"firmware"`            |
| `chutes` provider                           | `"chutes"`              |
| `google` provider with antigravity models   | `"google-antigravity"`  |
| `opencode-antigravity-auth` in plugins      | `"google-antigravity"`  |

#### Example: Full Configuration

For a user with Copilot and Google Antigravity:

```jsonc
{
  "plugin": [
    "opencode-antigravity-auth", // Required for google-antigravity
    "@slkiser/opencode-quota",
  ],
  "experimental": {
    "quotaToast": {
      "enabledProviders": ["copilot", "google-antigravity"],
      "googleModels": ["CLAUDE"], // Options: CLAUDE, G3PRO, G3FLASH
      "minIntervalMs": 300000, // 5 minutes between fetches
      "toastDurationMs": 9000, // Toast shows for 9 seconds
    },
  },
}
```

#### Step 4: Verify Installation

After configuration, instruct the user to:

1. Restart OpenCode (or reload the window)
2. Run `/quota_status` to verify providers are detected
3. Run `/quota` to manually trigger a toast

#### Common Issues

- **Toast not showing**: Run `/quota_status` to diagnose
- **Google Antigravity not working**: Ensure `opencode-antigravity-auth` plugin is installed and accounts are configured
- **Copilot quota unreliable**: Consider setting up a fine-grained PAT (see Provider-Specific Setup above)

</details>

## License

MIT
