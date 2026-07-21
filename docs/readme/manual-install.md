[← Back to README](../../README.md)

# Manual install

The guided installer is easier and safer:

```bash
npx @slkiser/opencode-quota@latest init
```

Use this guide only if you want to edit OpenCode files yourself.

## Choose where to install

- **Global:** works in every project. Files usually live in `~/.config/opencode`.
- **Project:** works only in the current repo or worktree.
- **Custom:** if `OPENCODE_CONFIG_DIR` is set, use that directory.

Use `.jsonc` files if you want comments. Use `.json` files if another tool requires strict JSON.

## 1. Add the main plugin

Add OpenCode Quota to `opencode.jsonc` or `opencode.json`. This is required for both TUI and Web:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

Keep any existing plugins and settings.

## 2. Add the TUI plugin

Skip this step if you use Web only.

Add OpenCode Quota to `tui.jsonc` or `tui.json`. This enables TUI slash commands, the sidebar, toasts, and the compact line:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

Keep any existing TUI plugins and settings.

## 3. Add quota settings

Create `opencode-quota/quota-toast.jsonc` beside the OpenCode config for your chosen scope:

```jsonc
{
  // Find providers from OpenCode configuration and authentication.
  "enabledProviders": "auto",

  // Show slash-command results with normal TUI messages.
  "tuiCommandDisplay": "inline",

  // Show the detailed Quota panel in the TUI sidebar.
  "tuiSidebarPanel": {
    "enabled": true,
  },

  // Keep the other automatic TUI displays off.
  "enableToast": false,
  "tuiCompactStatus": {
    "enabled": false,
  },

  // Show bundled maintainer notices on TUI Home.
  "maintainerAnnouncements": {
    "enabled": true,
    "home": true,
  },
}
```

Use `quota-toast.json` instead if you need strict JSON. Remove the comments and trailing commas.

Restart OpenCode, then run:

```text
/quota
/quota_status
```

`/quota_status` shows the exact files OpenCode Quota loaded.

## Change what appears in the TUI

Put these settings in `quota-toast.jsonc`, not `tui.jsonc`.

| You want                    | Setting                                  |
| --------------------------- | ---------------------------------------- |
| Sidebar panel               | `tuiSidebarPanel.enabled: true`          |
| Popup quota notifications   | `enableToast: true`                      |
| Compact quota line          | `tuiCompactStatus.enabled: true`         |
| Slash results with messages | `tuiCommandDisplay: "inline"`            |
| Slash results in a popup    | `tuiCommandDisplay: "dialog"`            |
| Manual slash commands only  | Disable sidebar, toast, and compact line |

Web slash commands always appear with messages. TUI popup dialogs and automatic TUI displays are not available in Web.

See [Configuration](configuration.md) for more examples and every setting.

## Update safely

Close OpenCode, preview the update, then apply it:

```bash
npx @slkiser/opencode-quota@latest update --dry-run
npx @slkiser/opencode-quota@latest update
```

The updater preserves unrelated settings, comments, and plugins. Restart OpenCode when it finishes.
