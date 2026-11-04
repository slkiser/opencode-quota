<p align="center">
  <a href="https://github.com/slkiser/opencode-quota">
    <picture>
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="https://shawnkiser.com/opencode-quota/opencode-quota-logo-light.svg" alt="OpenCode Quota logo">
    </picture>
  </a>
</p>
<p align="center">Quota, usage and cost in OpenCode TUI and Desktop.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm" src="https://img.shields.io/npm/v/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@slkiser/opencode-quota"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40slkiser%2Fopencode-quota?style=flat-square" /></a>
  <a href="https://github.com/slkiser/opencode-quota/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/slkiser/opencode-quota/ci.yml?style=flat-square&branch=main&label=CI" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" /></a>
</p>
<p align="center">
  <a href="README.md">English</a> |
  <a href="docs/readme/i18n/README.zh.md">简体中文</a> |
  <a href="docs/readme/i18n/README.zht.md">繁體中文</a> |
  <a href="docs/readme/i18n/README.fr.md">Français</a> |
  <a href="docs/readme/i18n/README.de.md">Deutsch</a> |
  <a href="docs/readme/i18n/README.ja.md">日本語</a> |
  <a href="docs/readme/i18n/README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/slkiser/opencode-quota"><img src="https://shawnkiser.com/opencode-quota/opencode-quota-hero.webp" alt="OpenCode Quota in OpenCode: the sidebar, the quota window's Usage and Limits tabs, and its settings" /></a>
</p>

---

## Install

```bash
opencode plugin add @slkiser/opencode-quota
```

Restart OpenCode and type `/quota`. A window opens with your limits. Click a tab (Usage, Limits, Plugin, or a Settings tab) or press `tab` to move between them; click or press `esc` to close it.

> [!IMPORTANT]
> You need OpenCode `2.0.26+`; the terminal commands also need Node.js `22.13+` or `23.4+`.

> [!NOTE]
> Still on OpenCode 1? Run `npx @slkiser/opencode-quota@4 init` instead, and see the [OpenCode 1 README](https://github.com/slkiser/opencode-quota/blob/release/4.x/README.md).

<details>
<summary>Edit <code>opencode.json</code> yourself</summary>

Add the plugin to `opencode.jsonc` or `opencode.json`, and keep your other plugins. In `~/.config/opencode` it works in every project; in a project's folder, only there. This one entry loads both the server and the TUI:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

</details>

## What you get

- **TUI:** a `/quota` window, a sidebar panel, a status line and toasts.
- **Desktop (experimental, OpenCode `2.2.0+`):** a side tab, pills, a bottom strip, toasts, a usage window (**Quota** command) and a settings page. Turn it off in **Settings → Extensions → Plugins**.
  <details>
  <summary>Where each setting shows in the TUI and in Desktop</summary>
  <table>
  <tr><th>Setting group</th><th>TUI</th><th>Desktop</th></tr>
  <tr><td><code>sidebar</code></td><td>Quota panel in the sidebar</td><td>Quota side tab</td></tr>
  <tr><td><code>collapsed</code></td><td>Sidebar panel folded to one line per provider</td><td>Titlebar pill, and the Quota side tab when folded</td></tr>
  <tr><td><code>statusLine</code></td><td>Line under the message box</td><td>Strip at the bottom of the window, and the pill above the message box</td></tr>
  <tr><td><code>toast</code></td><td>Toasts with bars</td><td>Toasts with the Quota side tab's rows and bars; a reset notice is a sentence</td></tr>
  </table>
  <p><b>Note:</b> in the TUI the status line hides while the sidebar shows quota, unless <b>Next to the sidebar</b> (<code>statusLine.withSidebar</code>) is on. In Desktop the strip also shows next to the Quota side tab by default; <b>Next to the side panel</b> (<code>statusLine.withSidePanel</code>) turns that off. <code>statusLine.composerPill: false</code> (<b>Pill above the message box</b>) hides only the pill in Desktop.</p>
  </details>
- **Web:** `/quota`, `/quota_usage` and `/quota_status` post a report in the chat. The AI never sees it.
- **Terminal:** `npx @slkiser/opencode-quota@latest show`, even with OpenCode closed.
- **Scripts and status bars:** JSON, an export file and metrics ([how](docs/readme/external-integration.md)).
- **Live settings** in every open OpenCode.

## Commands

| Command                | What it shows                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/quota`               | Limits. Web and Desktop: limits next to the last 7 days of usage                                                              |
| `/quota_usage [range]` | Tokens and API cost: `today` (default), `24h`, `7d`, `30d`, `90d`, `all`, `session` (with its subagents), `between` two dates |
| `/quota_status`        | Setup check: logins, providers, pricing, and notices                                                                          |
| `/quota_settings`      | Settings tabs (TUI only)                                                                                                      |

For example `/quota_usage 30d` or `/quota_usage between 2026-09-01 2026-09-25`. In a terminal, with OpenCode open or closed, `npx @slkiser/opencode-quota@latest show` shows your quota and `npx @slkiser/opencode-quota@latest status` checks your setup ([how they differ](docs/readme/troubleshooting.md#terminal-commands)). Add `--help` to see all options.

## Settings

- Change settings in `/quota_settings` (TUI) or the Quota page in Desktop's settings. Both save to `opencode-quota/settings.jsonc` in OpenCode's config folder and keep your comments.
- Custom providers, the Claude CLI path and the export path are set only in the file.
- The `┃` in a bar marks even use until the reset. **Even-use mark** (`layout.evenUse`) turns it off.
- [Settings and defaults](docs/readme/configuration.md)

## Providers

Log in with `/connect` and the provider shows up. Switch providers on or off in `/quota_settings` → **Providers**.

<table>
<tr>
<td valign="top">

| American | Plans |
| --- | --- |
| [Anthropic (Claude)](docs/readme/providers.md#anthropic-claude)\* | Personal · Business |
| [Cursor](docs/readme/providers.md#cursor)\* | Personal · Business |
| [Gemini CLI](docs/readme/providers.md#gemini-cli)\* | Business |
| GitHub Copilot | Personal · [Business](docs/readme/providers.md#github-copilot)\* |
| [Google AGY](docs/readme/providers.md#google-agy-quick-setup)\* | Personal · Business |
| Ollama Cloud | Personal |
| OpenAI | Personal · Business |
| OpenCode Go | Personal |
| OpenCode Zen | Personal · Business |
| OpenRouter | Personal · Business |
| xAI | Personal · Business |

</td>
<td valign="top">

| Chinese | Plans |
| --- | --- |
| [Alibaba Coding Plan](docs/readme/providers.md#alibaba-coding-plan)\* | Personal |
| [Alibaba Token Plan](docs/readme/providers.md#alibaba-token-plan)\* | Personal · Business |
| DeepSeek | Personal |
| Kimi Code | Personal · Business |
| Kimi Code (CN) | Personal · Business |
| MiniMax Token Plan | Personal · Business |
| MiniMax Token Plan (CN) | Personal · Business |
| [Xiaomi MiMo](docs/readme/providers.md#xiaomi-mimo)\* | Personal |
| Z.ai Coding Plan | Personal |
| Zhipu Coding Plan | Personal · Business |

</td>
</tr>
</table>

\* Linked names need one more step; the rest work once you log in. [What each one reports](docs/readme/providers.md#pre-configured-providers).

- OpenAI ChatGPT needs a Codex login ([how](docs/readme/providers.md#openai-and-xai)).
- Gemini CLI works only with Gemini Code Assist Standard or Enterprise (organization) accounts. Personal Google accounts use Google AGY.
- Business plans of the Chinese providers show only your own API key's usage (Alibaba Token Plan: one Credits row per seat).
- API keys come from OpenCode or an [environment variable](docs/readme/providers.md#api-keys).

### Custom providers

Track any other provider, from its quota API or from a local estimate. Ask your agent to add a custom provider: it is saved switched off, and you switch it on in `/quota_settings` → **Providers**. [Copy-paste prompt](docs/readme/providers.md#custom-providers).

## Updating

```bash
opencode plugin update
```

Restart OpenCode. Coming from 4.x or 5.x? Your settings convert on the first start, and the old `/tokens_*` commands still work. See [Updating](docs/readme/updating.md).

## Troubleshooting

1. Run `/quota_status` in an OpenCode session, or `npx @slkiser/opencode-quota@latest status` in a terminal.
2. Provider missing? Log in to it again in OpenCode 2.
3. Using a companion plugin (Cursor, Google)? List it **before** `@slkiser/opencode-quota` in `opencode.json`.
4. `claude` or `bl` not found? See [Service environment](docs/readme/troubleshooting.md#service-environment).
5. `/quota_usage` empty? Start OpenCode once, then use a model.
6. No Quota GUI in Desktop? It needs OpenCode `2.2.0+` and its switch on in **Settings → Extensions → Plugins**. Web shows no plugin GUI.

More fixes: [Troubleshooting](docs/readme/troubleshooting.md).

## Reference

Guides: [Configuration](docs/readme/configuration.md) · [Providers](docs/readme/providers.md) · [Troubleshooting](docs/readme/troubleshooting.md) · [External integration](docs/readme/external-integration.md) · [Updating](docs/readme/updating.md)

Outside links: [OpenCode docs](https://opencode.ai/docs/) · [OpenCode config](https://opencode.ai/docs/config/) · [OpenCode plugins](https://opencode.ai/docs/plugins/) · [OpenCode TUI](https://opencode.ai/docs/tui/) · [models.dev pricing data](https://models.dev/) · [Node.js downloads](https://nodejs.org/en/download)

## Contributors

Thanks to everyone who has contributed to OpenCode Quota.

<a href="https://github.com/slkiser/opencode-quota/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=slkiser/opencode-quota" />
</a>

## License

MIT. OpenCode Quota is not built by the OpenCode team and is not affiliated with OpenCode or any provider listed above.
