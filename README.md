<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage, and token visibility in OpenCode and your terminal.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/issues/38281"><img alt="Help us get listed: opencode#38281" src="https://img.shields.io/badge/%F0%9F%91%8D_help_us_get_listed-opencode%2338281-blue?style=flat-square" /></a>
</p>

[![OpenCode Quota sidebar](https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp)](https://github.com/slkiser/opencode-quota)

---

## Quick start

```bash
npx @slkiser/opencode-quota init
```

Then restart OpenCode and type `/quota`.

> [!IMPORTANT]
> You need OpenCode `2.0.16+` and Node.js `22.13+` or `23.4+`. Still on OpenCode 1? Run `npx @slkiser/opencode-quota@4 init` instead.

Upgrading from 4.x? Read [what changed in 5.0](#breaking-changes-in-500).

## What you get

<table>
  <tr>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-sidebar.webp" alt="OpenCode Quota TUI sidebar panel" /><br /><strong>Sidebar panel</strong></td>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-toast.webp" alt="OpenCode Quota popup toast" /><br /><strong>Popup toast</strong></td>
  </tr>
  <tr>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-statusbar.webp" alt="OpenCode Quota TUI status line" /><br /><strong>Status line</strong></td>
    <td width="50%" align="center"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-tokens-command.webp" alt="OpenCode Quota token report" /><br /><strong>Token reports</strong></td>
  </tr>
</table>

Also:

- **Terminal:** `npx @slkiser/opencode-quota@latest show` works even with OpenCode closed.
- **Web and Desktop:** slash commands post the report in the chat.
- **Scripts and status bars:** JSON, an export file, and metrics. See [External integration](docs/readme/external-integration.md).
- **Your look:** used or left, reset style, a runs-out estimate, and more. See [Configuration](docs/readme/configuration.md).
- **Retry at the reset:** when a request hits a limit and that provider's quota shows a used-up window, OpenCode retries after it resets. Turn off with `waitForQuotaReset: false`.

## Updating

Close OpenCode, then preview and apply the update:

```bash
npx @slkiser/opencode-quota@latest update --dry-run
npx @slkiser/opencode-quota@latest update
```

Restart OpenCode. The updater never moves or deletes secrets. See [Updating safely](docs/readme/updating.md).

### Breaking changes in 5.0.0

> [!WARNING]
> - OpenCode 1 is no longer supported. `init` and `update` keep OpenCode 1 users on 4.x (`@slkiser/opencode-quota@4`).
> - Logins come from OpenCode 2, never from `auth.json`. If a provider is missing, log in again.
> - Web and Desktop get the slash commands, but no toasts or panels.
> - TUI reports open in a popup. To keep them in the chat, set `tuiCommandDisplay: "inline"`.
> - OpenCode Zen uses your OpenCode Console sign-in: `opencode auth login opencode`.

Full list: [Moving to OpenCode 2](docs/readme/updating.md#moving-to-opencode-2).

## Commands

### Slash commands

Type these in OpenCode. Add dates after the command, like `/tokens_between 2026-09-01 2026-09-25`.

| Command                                 | What it shows                                        |
| --------------------------------------- | ---------------------------------------------------- |
| `/quota`                                | Current quota                                        |
| `/quota_status`                         | Setup check: logins, providers, pricing, and notices |
| `/quota_announcements`                  | Maintainer notices                                   |
| `/pricing_refresh`                      | Refreshes token pricing from `models.dev`            |
| `/tokens_today`                         | Tokens used today                                    |
| `/tokens_daily`                         | Tokens used in the last 24 hours                     |
| `/tokens_weekly`                        | Tokens used in the last 7 days                       |
| `/tokens_monthly`                       | Tokens used in the last 30 days, with pricing        |
| `/tokens_all`                           | Tokens used across all local history                 |
| `/tokens_session`                       | Tokens used in this session                          |
| `/tokens_session_all`                   | This session plus its subagent sessions              |
| `/tokens_between YYYY-MM-DD YYYY-MM-DD` | Tokens used between two dates                        |

### CLI commands

| Command                                           | What it does                      |
| ------------------------------------------------- | --------------------------------- |
| `npx @slkiser/opencode-quota@latest init`         | Set up OpenCode Quota             |
| `npx @slkiser/opencode-quota@latest provider add` | Add or update a custom provider   |
| `npx @slkiser/opencode-quota@latest show`         | Show current quota                |
| `npx @slkiser/opencode-quota@latest status`       | Check setup and provider problems |
| `npx @slkiser/opencode-quota@latest update`       | Update an existing installation   |

`show` and `status` work with OpenCode closed ([how they differ](docs/readme/troubleshooting.md#terminal-commands)). Add `--help` to see all options.

## Providers

Most providers work automatically once you log in through OpenCode. **Needs setup** links show the extra step.
OpenAI ChatGPT quota requires an OAuth login; stored API keys show "ChatGPT quota unavailable for API key" without a ChatGPT request.

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
| Kilo Gateway       | Automatic                                                      | Remote API         | Quota and balance  |
| NanoGPT            | Automatic                                                      | Remote API         | Quota and balance  |
| Ollama Cloud       | Automatic                                                      | Remote API         | Quota and usage    |
| OpenAI             | Automatic                                                      | Remote API         | Quota              |
| OpenCode Go        | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen       | Automatic                                                      | Remote API         | Budget and balance |
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
| Gemini CLI              | [Needs setup](docs/readme/providers.md#gemini-cli)             | Remote API         | Quota              |
| GitHub Copilot          | [Needs setup](docs/readme/providers.md#github-copilot)         | Remote API         | Budget and usage   |
| Google AGY              | [Needs setup](docs/readme/providers.md#google-agy-quick-setup) | Remote API         | Quota              |
| NanoGPT                 | Automatic                                                      | Remote API         | Quota and balance  |
| OpenAI                  | Automatic                                                      | Remote API         | Quota              |
| OpenCode Zen            | Automatic                                                      | Remote API         | Budget and balance |
| OpenRouter              | Automatic                                                      | Remote API         | Budget and spend   |
| Synthetic               | Automatic                                                      | Remote API         | Quota              |
| xAI SuperGrok           | Automatic                                                      | Remote API         | Quota              |

Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Personal Google users should use Google AGY.

</details>

### Pre-configured Chinese providers

<details open>
<summary><strong>Personal</strong></summary>

| Provider                      | Auth/setup                                                                   | Data from      | Reports            |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------- | ------------------ |
| Alibaba Coding Plan           | Automatic                                                                    | Local estimate | Quota              |
| Alibaba Personal Token Plan   | [Needs setup](docs/readme/providers.md#alibaba-personal-token-plan)          | Official CLI   | Quota              |
| DeepSeek                      | Automatic                                                                    | Remote API     | Balance and status |
| Kimi Code                     | Automatic                                                                    | Remote API     | Quota              |
| Kimi Code (CN)                | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan            | Automatic                                                                    | Remote API     | Quota              |
| MiniMax Token Plan (CN)       | Automatic                                                                    | Remote API     | Quota              |
| Xiaomi MiMo                   | [Needs setup](docs/readme/providers.md#xiaomi-mimo)                          | Dashboard API  | Quota and balance  |
| Z.ai Coding Plan              | Automatic                                                                    | Remote API     | Quota              |
| Zhipu Coding Plan             | Automatic                                                                    | Remote API     | Quota              |

</details>

<details>
<summary><strong>Business / Team</strong></summary>

| Provider                 | Auth/setup | Data from  | Reports |
| ------------------------ | ---------- | ---------- | ------- |
| Kimi Code                | Automatic  | Remote API | Quota   |
| Kimi Code (CN)           | Automatic  | Remote API | Quota   |
| MiniMax Token Plan       | Automatic  | Remote API | Quota   |
| MiniMax Token Plan (CN)  | Automatic  | Remote API | Quota   |
| Zhipu Coding Plan        | Automatic  | Remote API | Quota   |

These show only your own member API key's usage, not the whole organization's.

</details>

### Custom providers

Track a provider that is not listed, from its quota API or from a local estimate:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It previews the change before saving. See the [custom-provider guide](docs/readme/providers.md#custom-providers).

## Troubleshooting

1. Run `/quota_status` in OpenCode, or `npx @slkiser/opencode-quota@latest status` in a terminal.
2. Provider missing? Log in to it again in OpenCode 2.
3. Using a companion plugin (Cursor, Google)? List it **before** `@slkiser/opencode-quota` in `opencode.json`.
4. `claude` or `bl` not found? See [Service environment](docs/readme/troubleshooting.md#service-environment).
5. Token reports empty? Start OpenCode once, then use a model.

More fixes: [Troubleshooting](docs/readme/troubleshooting.md).

## Reference

Guides: [Manual install](docs/readme/manual-install.md) · [Configuration](docs/readme/configuration.md) · [Providers](docs/readme/providers.md) · [Troubleshooting](docs/readme/troubleshooting.md) · [External integration](docs/readme/external-integration.md) · [Updating safely](docs/readme/updating.md)

Outside links: [OpenCode docs](https://opencode.ai/docs/) · [OpenCode config](https://opencode.ai/docs/config/) · [OpenCode plugins](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev pricing data](https://models.dev/) · [Node.js downloads](https://nodejs.org/en/download)

## Contributors

Thanks to everyone who has contributed to OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## License

MIT. OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.

[![Star History Chart](https://api.star-history.com/svg?repos=slkiser/opencode-quota&type=date&legend=top-left)](https://www.star-history.com/#slkiser/opencode-quota&Date)
