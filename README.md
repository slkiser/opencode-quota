<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility for OpenCode and CLI.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>

[![OpenCode Quota sidebar](https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp)](https://github.com/slkiser/opencode-quota)

---

## Quick start

```bash
npx @slkiser/opencode-quota init
```

> [!IMPORTANT]
> Node.js `>= 22` is required.

The installer recommends **JSONC** because comments make the generated plugin entries easier to understand; strict JSON is also available. Before writing, it previews every target. Use `npx @slkiser/opencode-quota init --dry-run` to validate and stop after that preview. If you choose JSONC for an existing `opencode.json`, it copies all settings into `opencode.jsonc`, adds only the required OpenCode Quota entries and comments, validates the result, writes it atomically, and removes the old JSON only after success. Existing JSONC comments and unrelated settings are preserved.

In auto-detect mode, when OpenCode Quota finds working auth for a built-in provider but no matching OpenCode `provider` declaration, it adds an empty declaration to the selected global `opencode.jsonc` or `opencode.json`. It preserves that file's format; if the global file is new, it uses the selected project format. Project declarations are read as project-only overrides and are never automatically written.

Upgrading from v3? Read the [v4 migration guide](docs/readme/v4-migration.md).

1. Restart OpenCode.
2. Run Slash commands in OpenCode, or use `opencode-quota show` from your terminal.
3. If you enabled the Sidebar panel, open the session sidebar and look for `Quota`.
4. If you enabled Compact status line, look for the home-bottom quota line and the chat/session prompt quota line.
5. If something looks wrong, run `/quota_status` in OpenCode or see [Troubleshooting](docs/readme/troubleshooting.md).

## Updating

1. Close OpenCode.
2. Run:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

3. Review the exact config edits and cache directories, then confirm.
4. Restart OpenCode.

Use `--dry-run` to preview without changing anything. Without it, `update` prints the preview and asks for confirmation before applying changes; use `--yes` only for explicit noninteractive confirmation. The update command changes only canonical OpenCode Quota plugin entries and removes only verified OpenCode Quota cache directories; it preserves the selected existing JSON/JSONC filename, settings, JSONC comments, tuple options, and other plugins.

## What you get

<table>
  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp" alt="OpenCode Quota TUI sidebar panel" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-toast.webp" alt="OpenCode Quota popup toast" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Sidebar panel</strong><br />A full quota view in OpenCode's session sidebar.</td>
    <td width="50%" align="center"><strong>TUI toast</strong><br />Quota checks can pop up in the TUI after idle, question, or compact events.</td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-statusbar.webp" alt="OpenCode Quota TUI status line" />
    </td>
    <td width="50%">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-tokens-command.webp" alt="OpenCode Quota token report" />
    </td>
  </tr>
  <tr>
    <td width="50%" align="center"><strong>Compact status line</strong><br />Short quota text on home and chat/session prompt surfaces.</td>
    <td width="50%" align="center"><strong>Token reports</strong><br /><code>/tokens_today</code>, <code>/tokens_weekly</code>, session reports, and more.</td>
  </tr>
</table>

More ways to use it:

- Terminal checks with `opencode-quota show` before or without opening OpenCode
- JSON output for scripts, status bars, CI checks, and external tools
- Deterministic inline slash-command output shared by TUI and Web/Desktop server
- Provider diagnostics for auth, quota sources, pricing, and bundled maintainer announcements

See [Configuration](docs/readme/configuration.md) for UI options and [Manual install](docs/readme/manual-install.md) for setup details.

## Commands

### Core slash commands

The server plugin registers each command once for TUI and Desktop/server. Each command injects one ignored, no-reply inline message, does not call the model, and does not add output to model context. `/tokens_between` requires both dates inline and does not open a prompt dialog.

| Command                                 | Use when                                                             |
| --------------------------------------- | -------------------------------------------------------------------- |
| `/quota`                                | Show your quota and usage details                                    |
| `/quota_status`                         | Diagnose setup, auth, provider detection, pricing, and announcements |
| `/quota_announcements`                  | Read active bundled maintainer notices                               |
| `/pricing_refresh`                      | Refresh local runtime pricing from `models.dev`                      |
| `/tokens_today`                         | Show tokens used today                                               |
| `/tokens_daily`                         | Show tokens used in the last 24 hours                                |
| `/tokens_weekly`                        | Show tokens used in the last 7 days                                  |
| `/tokens_monthly`                       | Show tokens used in the last 30 days, including pricing              |
| `/tokens_all`                           | Show tokens used across all local history                            |
| `/tokens_session`                       | Show tokens used in the current session                              |
| `/tokens_session_all`                   | Show current session plus descendant sessions                        |
| `/tokens_between YYYY-MM-DD YYYY-MM-DD` | Show tokens used between two dates                                   |

### CLI commands

Use the CLI for scripts, CI, or a quick terminal check outside OpenCode.

| Command                                        | Use when                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------- |
| `opencode-quota init --dry-run`                | Validate and preview installer changes without writing files          |
| `opencode-quota update`                        | Preview, confirm, and apply a scoped OpenCode Quota update            |
| `opencode-quota update --dry-run`              | Preview exact config and cache targets without changing them          |
| `opencode-quota show`                          | Check quota from your terminal                                        |
| `opencode-quota show --provider <id>`          | Check one provider only, such as `copilot` or `openai`                |
| `opencode-quota show --json`                   | Print JSON for scripts, status bars, and other tools                  |
| `opencode-quota show --json --threshold <pct>` | Fail the command when cached quota drops below your chosen percentage |

## Providers

### Pre-configured providers

Most providers work automatically. If a provider has a “Needs setup” link, open that setup note only if you use that provider.

| Provider                 | Auth/setup                                                     | Data from          | Reports            |
| ------------------------ | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)       | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| GitHub Copilot           | OpenCode OAuth or PAT                                          | Remote API         | Quota and usage    |
| OpenAI                   | Automatic                                                      | Remote API         | Quota              |
| Cursor                   | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| Qwen Code                | [Needs setup](docs/readme/providers.md#qwen-code)              | Local estimate     | Quota              |
| Alibaba Coding Plan      | OpenCode config                                                | Local estimate     | Quota              |
| MiniMax Coding Plan      | OpenCode config                                                | Remote API         | Quota              |
| MiniMax Coding Plan (CN) | OpenCode config                                                | Remote API         | Quota              |
| Kimi Code                | OpenCode config                                                | Remote API         | Quota              |
| Chutes AI                | API key/config                                                 | Remote API         | Quota              |
| Synthetic                | Automatic                                                      | Remote API         | Quota              |
| Google Antigravity       | [Needs setup](docs/readme/providers.md#google-antigravity)     | Remote API         | Quota              |
| Google AGY               | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| Gemini CLI               | [Needs setup](docs/readme/providers.md#gemini-cli)             | Remote API         | Quota              |
| Z.ai Coding Plan         | OpenCode config                                                | Remote API         | Quota              |
| Zhipu Coding Plan        | OpenCode config                                                | Remote API         | Quota              |
| NanoGPT                  | API key/config                                                 | Remote API         | Quota and balance  |
| DeepSeek                 | API key/config                                                 | Remote API         | Balance and status |
| Ollama Cloud             | [Needs setup](docs/readme/providers.md#ollama-cloud)           | Dashboard scraping | Quota              |
| OpenCode Go              | [Needs setup](docs/readme/providers.md#opencode-go)            | Dashboard scraping | Quota              |

The friendly `Quota` label covers quota and rate-limit windows; v4 JSON distinguishes them.

### Custom providers

Custom providers can report quota, rate limit, usage, spend, budget, balance, or status.

An OpenCode `provider` block is the part of `opencode.json` that tells OpenCode which provider and models are available and how to reach them. OpenCode creates this knowledge for its built-in providers, so they do not need a provider block. When adding a provider OpenCode does not already know, you create the provider and model configuration so OpenCode can use it. `/connect` → **Other** stores the credential, but you still configure the provider and models in `opencode.json`. Write that configuration manually with the [OpenCode provider guide](https://opencode.ai/docs/providers), or use the planned guided OpenCode Quota command when it becomes available.

Add safe preset-based endpoints for gateways that OpenCode already knows. `customSources` is accepted **only** in the canonical global `<OpenCode user config dir>/opencode-quota/quota-toast.json` (usually `~/.config/opencode/opencode-quota/quota-toast.json`, or under `$OPENCODE_CONFIG_DIR`). It is rejected from project/workspace, legacy, and SDK config.

```jsonc
{
  "enabledProviders": ["custom-sources"],
  "customSources": [
    {
      "id": "openrouter-primary",
      "providerId": "openrouter",
      "label": "OpenRouter Primary",
      "url": "https://openrouter.ai/api/v1/key",
      "preset": "openrouter-key-v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
    },
  ],
}
```

```bash
export OPENROUTER_API_KEY="your-api-key"
```

Credentials resolve in this order: the explicitly named environment variable, trusted global `provider.<providerId>.options.apiKey`, then strict `{ "type": "api", "key": "..." }` OpenCode auth. Run `/quota_status` for safe, live per-source diagnostics. See [Provider setup](docs/readme/providers.md#custom-accounting-sources), [Configuration](docs/readme/configuration.md#custom-accounting-sources), and [JSON export v2](docs/readme/external-integration.md#json-export-v2).

Setup details live in the [Provider setup guide](docs/readme/providers.md).

## Troubleshooting

Start here when quota or token data looks wrong:

1. Run `/quota_status`, or start with `opencode-quota show` for a terminal quota summary.
2. Confirm the expected provider appears in the detected provider list.
3. Confirm companion auth plugins are before `@slkiser/opencode-quota` in `opencode.json`.
4. If token reports are empty, start OpenCode once so it creates `opencode.db`, then run a session with model usage.
5. Check [Troubleshooting](docs/readme/troubleshooting.md) for common symptoms and provider-specific fixes.

## Reference

- [Manual install](docs/readme/manual-install.md)
- [Configuration](docs/readme/configuration.md)
- [Providers](docs/readme/providers.md)
- [Troubleshooting](docs/readme/troubleshooting.md)
- [External integration](docs/readme/external-integration.md)

## Contributors

Thanks to everyone who has contributed to OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## License

MIT

## Remarks

OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

## Star history

![Star History Chart](https://shawnkiser.com/opencode-quota/star-history-2026710.webp)
