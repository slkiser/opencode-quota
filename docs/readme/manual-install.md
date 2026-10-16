[← Back to README](../../README.md)

# Manual install

The easy way is one command:

```bash
opencode plugin add @slkiser/opencode-quota
```

Use this page only if you want to edit OpenCode files yourself.

## Requirements

- OpenCode `2.0.26` or newer. On OpenCode 1, use `npx @slkiser/opencode-quota@4 init`.
- Node.js `22.13+` is required for `npx @slkiser/opencode-quota ...` (on Node 23, `23.4+`).

## Choose where to install

- **Global:** works in every project. Files live in `~/.config/opencode` on every OS (`$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set).
- **Project:** works only in the current repo or worktree.
- **Custom:** if `OPENCODE_CONFIG_DIR` is set, OpenCode uses that folder instead of the global one.

Use `.jsonc` files if you want comments, or `.json` if another tool needs strict JSON (no comments, no trailing commas).

## 1. Add the plugin

Add OpenCode Quota to `opencode.jsonc` or `opencode.json`, and keep your other plugins. This one entry loads both the server and the TUI; no `tui.json` entry is needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

## 2. Add quota settings (optional)

OpenCode Quota works without settings. To change something, create `opencode-quota/settings.jsonc` in the global OpenCode folder (or in `$OPENCODE_CONFIG_DIR`), also for a project install:

```jsonc
{
  // Find providers from your OpenCode config and logins.
  "providers": { "off": [] },
}
```

Restart OpenCode, open a session, then run `/quota` and `/quota_status` in the TUI. `/quota_status` shows the settings file OpenCode Quota read.

## What appears in the TUI

The TUI shows the `Quota` panel in the session sidebar, a status line under the message box when the sidebar is not on screen, and toasts after compaction and after a reply once a limit is getting low. Change their look in the Settings tabs of `/quota_settings`; see [TUI surfaces](configuration.md#tui-surfaces). Web and Desktop show none of these. See [Configuration](configuration.md) for every setting.

## Web and Desktop notes

- Slash commands work in the TUI, Web, and Desktop. Add a range after `/quota_usage`, like `/quota_usage between 2026-09-01 2026-09-25`.
- **TUI:** `/quota`, `/quota_usage`, `/quota_status` and `/quota_settings` open the quota window above the message box on the Limits, Usage, Plugin or first Settings tab. On Limits, `c` copies every provider's limits as the short text Web and Desktop `/quota` post, without the usage and notices. Plugin has the maintainer notices, the quota file and OpenTelemetry switches, and the status report with a Copy button. On Home, which has no message box, they say to open a session first. The Settings tabs are Layout (All places, then a page each for the sidebar, the collapsed panel, the status line and toasts), Colors and Providers. None of them leaves a chat message. The command palette has the same commands.
- **Web and Desktop:** `/quota` posts each provider's limits next to what OpenCode used in the last 7 days as short text, ending with all active maintainer notices, in the chat as your message; `/quota_usage` and `/quota_status` post their report the same way. `/quota_settings` exists only in the TUI. The AI never answers a report, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`, which also keeps it out of compaction summaries.
- Web uses a proportional font, so columns may not line up. Use the TUI or `npx @slkiser/opencode-quota show` for aligned columns.
- If the AI is busy, the report appears after it finishes. A new session whose first message is a report keeps its default title.
- The AI can call the `quota_status` tool to check your setup.

To update later, see [Updating](updating.md).
