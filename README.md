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

## Updating

1. Close OpenCode.
2. Preview the update:

   ```bash
   npx @slkiser/opencode-quota@latest update --dry-run
   ```

3. Inspect the safe setting/cache changes and manual credential findings, then apply:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

4. Restart OpenCode.

The updater prints the complete preview before its own config or cache changes. `--yes` authorizes only the previewed safe config edits and manifest-verified cache cleanup; it never moves or deletes secrets. See [Updating safely](docs/readme/updating.md) for detailed behavior and manual credential steps.

## Choose your setup

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

- Check quota anywhere: use `opencode-quota show` in a terminal or the same slash commands in the TUI, Web, and Desktop.
- Automate quota checks with JSON output for scripts, status bars, and CI. Optional OpenTelemetry metrics support monitoring tools.
- Customize the display with [`tuiPromptBar.enabled`](docs/readme/configuration.md#tui-settings), OpenCode Go's preferred collapsed-sidebar window, reset precision, and [`accountingDetail`](docs/readme/configuration.md#show-accounting-detail).
- Choose current-session or descendant-tree token totals. Get reset popups for selected windows with [`resetNotifications`](docs/readme/configuration.md#notify-when-quota-becomes-available-again).
- Troubleshoot authentication, quota sources, pricing, and maintainer notices.

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

Use the CLI for setup, updates, terminal checks, and custom providers.

| Command                                                  | What it does                                |
| -------------------------------------------------------- | ------------------------------------------- |
| `npx @slkiser/opencode-quota@latest init`                | Set up OpenCode Quota                       |
| `npx @slkiser/opencode-quota@latest provider add`        | Add or update a custom provider             |
| `npx @slkiser/opencode-quota@latest show`                | Show current quota                          |
| `npx @slkiser/opencode-quota@latest status`              | Check configuration and provider problems  |
| `npx @slkiser/opencode-quota@latest update`              | Update an existing installation             |

Run `npx @slkiser/opencode-quota@latest --help` for command options. See [External integration](docs/readme/external-integration.md#1-get-json-from-a-command) for JSON, scripts, and CI examples.

## Providers

### Pre-configured American providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider           | Auth/setup                                                     | Data from          | Reports            |
| ------------------ | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude) | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI          | Automatic                                                      | Remote API         | Quota              |
| Cursor             | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| GitHub Copilot     | Automatic                                                      | Remote API         | Budget and usage   |
| Google AGY         | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| Google Antigravity | [Needs setup](docs/readme/providers.md#google-antigravity)     | Remote API         | Quota              |
| Kilo Gateway       | Automatic                                                      | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                                                      | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                                                      | Remote API         | Quota and usage    |
| OpenAI             | Automatic                                                      | Remote API         | Quota              |
| OpenCode Go        | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen       | [Needs setup](docs/readme/providers.md#opencode-zen)           | Dashboard scraping | Budget and balance |
| OpenRouter         | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic          | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok      | Automatic                                                      | Remote API         | Quota              |

</details>

<details>
<summary><strong>Business / Enterprise</strong></summary>

| Provider                | Auth/setup                                                     | Data from          | Reports            |
| ----------------------- | -------------------------------------------------------------- | ------------------ | ------------------ |
| Anthropic (Claude)      | [Needs setup](docs/readme/providers.md#anthropic-claude)       | Local CLI/OAuth    | Quota              |
| Chutes AI               | Automatic                                                      | Remote API         | Quota              |
| Cursor                  | [Needs setup](docs/readme/providers.md#cursor)                 | Local estimate     | Budget and spend   |
| Gemini CLI (deprecated) | [Existing setups only](docs/readme/providers.md#gemini-cli)    | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](docs/readme/providers.md#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| Google Antigravity      | [Needs setup](docs/readme/providers.md#google-antigravity)     | Remote API         | Quota              |
| NanoGPT                 | Automatic                                                      | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen            | [Needs setup](docs/readme/providers.md#opencode-zen)           | Dashboard scraping | Budget and balance |
| OpenRouter              | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic               | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok           | Automatic                                                      | Remote API         | Quota              |

Gemini CLI quota support is deprecated for new installs. Existing v4 configurations still work, with removal planned for v5.0.0. See the [provider guide](docs/readme/providers.md#gemini-cli) before choosing a replacement.

</details>

### Pre-configured Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                 | Auth/setup                                          | Data from      | Reports            |
| ------------------------ | --------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan      | Automatic                                           | Local estimate | Quota              |
| DeepSeek                 | Automatic                                           | Remote API     | Balance and status |
| Kimi Code                | Automatic                                           | Remote API     | Quota              |
| MiniMax Coding Plan      | Automatic                                           | Remote API     | Quota              |
| MiniMax Coding Plan (CN) | Automatic                                           | Remote API     | Quota              |
| Qwen Code                | [Needs setup](docs/readme/providers.md#qwen-code)   | Local estimate | Quota              |
| Xiaomi MiMo              | [Needs setup](docs/readme/providers.md#xiaomi-mimo) | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan         | Automatic                                           | Remote API     | Quota              |
| Zhipu Coding Plan        | Automatic                                           | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| MiniMax Coding Plan      | Automatic  | Remote API | Quota   |
| MiniMax Coding Plan (CN) | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These vendors offer team or business plans, but the current integrations report only the configured member API key rather than organization-wide usage.

</details>

### Custom providers

Add a provider that uses a remote quota API or tracks a local usage estimate:

```bash
npx @slkiser/opencode-quota@latest provider add
```

The guided setup previews the change before saving. See the [custom-provider guide](docs/readme/providers.md#custom-providers) for details.

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

![Star History Chart](https://shawnkiser.com/opencode-quota/star-history-2026813.svg)
