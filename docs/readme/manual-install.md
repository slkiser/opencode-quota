[← Back to README](../../README.md)

# Manual install

The guided installer is easier and safer:

```bash
npx @slkiser/opencode-quota@latest init
```

Use this page only if you want to edit OpenCode files yourself.

## Requirements

- OpenCode `2.0.16` or newer. On OpenCode 1, use `npx @slkiser/opencode-quota@4 init`.
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

## 2. Add quota settings

Create `opencode-quota/quota-toast.jsonc` next to that OpenCode config:

```jsonc
{
  // Find providers from your OpenCode config and logins.
  "enabledProviders": "auto",

  // Show the Quota panel in the TUI sidebar.
  "tuiSidebarPanel": { "enabled": true },

  // Keep the other automatic TUI displays off.
  "enableToast": false,
  "tuiCompactStatus": { "enabled": false },

  // Show the count of maintainer notices on Home, once a day for 10 minutes.
  "maintainerAnnouncements": { "enabled": true, "home": true },
}
```

Restart OpenCode, then run `/quota` and `/quota_status` in the TUI. `/quota_status` shows the exact files OpenCode Quota loaded.

## Choose what appears in the TUI

| You want                   | Setting                                   |
| -------------------------- | ----------------------------------------- |
| Sidebar panel              | `tuiSidebarPanel.enabled: true`           |
| Popup quota notifications  | `enableToast: true`                       |
| Compact quota line         | `tuiCompactStatus.enabled: true`          |
| Quota bar under the prompt | `tuiPromptBar.enabled: true`              |
| Slash commands only        | Turn off sidebar, toast, and compact line |

Web and Desktop show none of these. See [Configuration](configuration.md) for every setting.

## Web and Desktop notes

- Slash commands work in the TUI, Web, and Desktop. Add arguments after the command, like `/tokens_between 2026-09-01 2026-09-25`.
- **TUI:** a slash command opens the report in a popup and leaves no chat message (default `tuiCommandDisplay: "dialog"`). Set `"inline"` to keep it in the chat. The command palette runs the same commands, always in a popup, and asks for missing dates.
- **Web and Desktop:** `/quota` posts the report in the chat as your message. The AI never answers it, and the plugin filters it out of every AI request. If you uninstall the plugin, old reports in past chats are no longer filtered.
- Each report starts with `[OpenCode Quota report]` and ends with `[End of OpenCode Quota report]`, which also keeps it out of compaction summaries.
- Web uses a proportional font, so columns may not line up. Use the TUI or `npx @slkiser/opencode-quota show` for aligned columns.
- If the AI is busy, the report appears after it finishes. A new session whose first message is a report keeps its default title.
- The AI can call the `quota_status` tool to check your setup.

To update later, see [Updating safely](updating.md).
