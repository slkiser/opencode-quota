<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility in OpenCode and your terminal.</p>
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

Upgrading from v3? Read the [v4 migration guide](docs/readme/v4-migration.md).

After installation:

1. Restart OpenCode.
2. Run a slash command in OpenCode, or use `opencode-quota show` from your terminal.
3. If you enabled the sidebar, open the session sidebar and look for `Quota`.
4. If you enabled the compact status line, look at the bottom of Home or below the message input.
5. If something looks wrong, run `/quota_status` in OpenCode or see [Troubleshooting](docs/readme/troubleshooting.md).

## Updating

1. Close OpenCode.
2. Run:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

3. Review the exact config edits and cache directories, then confirm.
4. Restart OpenCode.

Use `--dry-run` to preview without changing anything. Otherwise, `update` shows the OpenCode Quota config and cache changes and asks before applying them. It leaves your other plugins and settings alone. Use `--yes` only when you intentionally need a noninteractive run.

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
    <td width="50%" align="center"><strong>TUI toast</strong><br />Quota checks can appear automatically while you work.</td>
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
    <td width="50%" align="center"><strong>Compact status line</strong><br />Short quota text on Home and below the message input.</td>
    <td width="50%" align="center"><strong>Token reports</strong><br /><code>/tokens_today</code>, <code>/tokens_weekly</code>, session reports, and more.</td>
  </tr>
</table>

More ways to use it:

- Check quota from a terminal with `opencode-quota show`
- Use JSON output in scripts, status bars, CI checks, and other tools
- Run the same slash commands in the TUI, Web, and Desktop
- Tune reset countdown precision without changing the default compact display
- Diagnose authentication, quota sources, pricing, and maintainer notices

See [Configuration](docs/readme/configuration.md) for UI options and [Manual install](docs/readme/manual-install.md) for setup details.

## Commands

### Core slash commands

| Command                                 | Use when                                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| `/quota`                                | Show current quota                                              |
| `/quota_status`                         | Diagnose setup, authentication, providers, pricing, and notices |
| `/quota_announcements`                  | Read active bundled maintainer notices                          |
| `/pricing_refresh`                      | Refresh local runtime pricing from `models.dev`                 |
| `/tokens_today`                         | Show tokens used today                                          |
| `/tokens_daily`                         | Show tokens used in the last 24 hours                           |
| `/tokens_weekly`                        | Show tokens used in the last 7 days                             |
| `/tokens_monthly`                       | Show tokens used in the last 30 days, including pricing         |
| `/tokens_all`                           | Show tokens used across all local history                       |
| `/tokens_session`                       | Show tokens used in the current session                         |
| `/tokens_session_all`                   | Show current session plus descendant sessions                   |
| `/tokens_between YYYY-MM-DD YYYY-MM-DD` | Show tokens used between two dates                              |

### CLI commands

Use the CLI for scripts, CI, or a quick terminal check outside OpenCode.

| Command                                        | Use when                                                     |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `opencode-quota init --dry-run`                | Validate and preview installer changes without writing files |
| `opencode-quota update`                        | Preview, confirm, and apply a scoped OpenCode Quota update   |
| `opencode-quota update --dry-run`              | Preview exact config and cache targets without changing them |
| `opencode-quota show`                          | Check quota from your terminal                               |
| `opencode-quota show --provider <id>`          | Check one provider only, such as `copilot` or `openai`       |
| `opencode-quota show --json`                   | Print JSON for scripts, status bars, and other tools         |
| `opencode-quota show --json --threshold <pct>` | Fail when quota is low; return exit 2 for incomplete results |
| `opencode-quota status`                        | Run the same diagnostics as `/quota_status` from a terminal  |
| `opencode-quota status --provider <id>`        | Diagnose one provider by canonical ID or synonym             |
| `opencode-quota status --json`                 | Print secret-safe JSON diagnostics for scripts and CI        |

## Providers

### Pre-configured providers

Most providers work automatically. If a provider has a “Needs setup” link, open that setup note only if you use that provider.

| Provider                 | Auth/setup                                                     | Data from          | Reports            |
| ------------------------ | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)       | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| GitHub Copilot           | [Needs setup](docs/readme/providers.md#github-copilot)         | Remote API         | Usage and budget   |
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
| Gemini CLI (deprecated)  | [Existing setups only](docs/readme/providers.md#gemini-cli)    | Remote API         | Quota              |
| Z.ai Coding Plan         | OpenCode config                                                | Remote API         | Quota              |
| Zhipu Coding Plan        | OpenCode config                                                | Remote API         | Quota              |
| NanoGPT                  | API key/config                                                 | Remote API         | Quota and balance  |
| DeepSeek                 | API key/config                                                 | Remote API         | Balance and status |
| xAI SuperGrok            | OpenCode OAuth (`/connect` xAI)                                | Remote API         | Quota              |
| Ollama Cloud             | [Needs setup](docs/readme/providers.md#ollama-cloud)           | Dashboard scraping | Quota              |
| OpenCode Go              | [Needs setup](docs/readme/providers.md#opencode-go)            | Dashboard scraping | Quota              |
| OpenCode Zen             | [Needs setup](docs/readme/providers.md#opencode-zen)           | Dashboard scraping | Budget and balance |

Gemini CLI quota support is deprecated for new installs. Existing v4 configurations still work, with removal planned for v5.0.0. See the [provider guide](docs/readme/providers.md#gemini-cli) before choosing a replacement.

The quota view uses short labels such as `Day quota`, `5h quota`, `Day budget`, and `Balance`. Bar width varies by surface. JSON keeps the precise accounting type for scripts.

### Custom providers

A quota provider definition tells OpenCode Quota how to obtain accounting data for an OpenCode provider. Run the guided command. It asks only structural questions, previews the exact global OpenCode config change, and asks before writing:

```bash
npx @slkiser/opencode-quota@latest provider add
```

For remote APIs, choose `quota-v1` for the standard envelope, `json-v1` to map a strict JSON response, or `openrouter-key-v1` for OpenRouter's key endpoint. For `json-v1`, the command builds the adapter with friendly field-by-field questions; it never asks for a response body, credential, or secret value. The command previews the complete canonical merged config before it writes anything.

Setup details live in the [Provider setup guide](docs/readme/providers.md#custom-providers).

## Troubleshooting

If quota or token data looks wrong:

1. Run `/quota_status` in OpenCode, or `opencode-quota status` from a terminal for the same diagnostics. Use `opencode-quota show` for a quick quota glance.
2. Confirm the expected provider appears in the detected provider list.
3. Confirm companion auth plugins are before `@slkiser/opencode-quota` in `opencode.json`.
4. If token reports are empty, start OpenCode once so it creates `opencode.db`, then run a session with model usage.
5. Check [Troubleshooting](docs/readme/troubleshooting.md) for common symptoms and provider-specific fixes.

## Reference

Project guides:

- [Manual install](docs/readme/manual-install.md)
- [Configuration](docs/readme/configuration.md)
- [Providers](docs/readme/providers.md)
- [Troubleshooting](docs/readme/troubleshooting.md)
- [External integration](docs/readme/external-integration.md)

External references:

- [OpenCode docs](https://opencode.ai/docs/)
- [OpenCode config](https://opencode.ai/docs/config/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode TUI](https://opencode.ai/docs/tui/)
- [models.dev pricing data](https://models.dev/)
- [Node.js downloads](https://nodejs.org/en/download)

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
