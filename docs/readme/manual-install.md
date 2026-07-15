# Manual install

[← Back to README](../../README.md)

Manual setup details for users who prefer editing OpenCode config themselves.

## Update OpenCode Quota safely

1. Close OpenCode.
2. Run:

   ```bash
   npx @slkiser/opencode-quota@latest update
   ```

3. Review the exact config edits and cache directories, then confirm.
4. Restart OpenCode.

Use `opencode-quota update --dry-run` to preview an update without changing anything. Use `opencode-quota init --dry-run` to run the guided choices, validate the planned JSON/JSONC files, print the preview, and stop without writing. Use `--yes` only for explicit noninteractive update confirmation. The update command changes only canonical OpenCode Quota plugin entries and removes only verified OpenCode Quota cache directories; it preserves the existing JSON/JSONC filename, settings, JSONC comments, tuple options, and other plugins.

## Manual Install

Use the installer when possible. For manual install, use the same OpenCode config location you would pick in the installer:

- **Project install:** files live in your repo/worktree.
- **Global install:** files live in your OpenCode config directory, usually `~/.config/opencode`.
- If you set `OPENCODE_CONFIG_DIR`, use that directory instead.

**`opencode.jsonc` and `tui.jsonc`** are OpenCode-owned configuration files that allow comments and trailing commas. The guided OpenCode Quota installer recommends and creates these by default because the added comments explain why each plugin entry exists. **`opencode.json` and `tui.json`** are the strict-JSON alternatives; choose them in the installer when another tool requires comment-free JSON.

When JSONC is selected and an existing JSON file is present, the installer previews the conversion, copies every existing setting, adds only the required OpenCode Quota configuration and managed comments, validates and atomically writes the JSONC target, then removes the old JSON. Existing JSONC keeps its filename, comments, and unrelated settings even if JSON is later selected; the JSON choice applies to new files or preserves an existing JSON file. Reruns do not duplicate managed comments.

### 1. Add the server plugin (required)

This enables providers, terminal checks, TUI popup toasts, the inline slash commands shared by TUI and Web/Desktop server, and the `tool.quota_status` tool. Add this to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

> [!NOTE]
> With OpenCode 1.17.20, Web `/quota` renders deterministic output without calling a model, but can then show a false `Failed to send command` notification. Do not retry automatically after output appears. This predates v4 and also occurs with v3.11.2. Web does not receive the TUI toast event, and Safari/macOS notification permissions do not change that.

### 2. Add the TUI plugin (for TUI surfaces)

Add this to `tui.json` or `tui.jsonc` for the Sidebar panel, Compact status line, and maintainer announcement home notices. Slash commands remain owned by the server plugin and render deterministic inline output; the TUI plugin does not register command popups:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@slkiser/opencode-quota"],
}
```

### 3. Add quota settings

Create or edit `opencode-quota/quota-toast.json` **next to the `opencode.json` / `tui.json` file above**. For a project install, that means:

```text
<your-repo>/opencode-quota/quota-toast.json
```

Start with this, then adjust the UI choices in the next section:

```jsonc
{
  "enabledProviders": "auto",
  "enableToast": true,
  "tuiSidebarPanel": {
    "enabled": true,
  },
  "tuiCompactStatus": {
    "enabled": false,
  },
  "maintainerAnnouncements": {
    "enabled": true,
    "home": true,
  },
}
```

> [!TIP]
> Run `/quota_status` to see the exact config paths OpenCode Quota loaded.

## Choose your UI surfaces

All UI surfaces use the same quota data. Put these settings in `opencode-quota/quota-toast.json`, not `tui.json`.

| I want...                                           | Enable/configure                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Full `Quota` sidebar panel                          | `tuiSidebarPanel.enabled: true`                                                           |
| Popup quota notifications in the TUI                | `enableToast: true`                                                                       |
| Compact status line                                 | `tuiCompactStatus.enabled: true`                                                          |
| Inline slash commands in TUI and Web/Desktop server | Server plugin entry in `opencode.json`                                                    |
| Sidebar, compact status, and home notice            | TUI plugin entry in `tui.json`                                                            |
| No automatic UI surfaces                            | `enableToast: false`, `tuiSidebarPanel.enabled: false`, `tuiCompactStatus.enabled: false` |

For every option and more recipes, see [Configuration](configuration.md).
