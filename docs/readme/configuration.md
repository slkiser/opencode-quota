# Configuration

[← Back to README](../../README.md)

UI surface choices, common recipes, and the full configuration reference.

## Choose your UI surfaces

All UI surfaces use the same quota data. Put these settings in `opencode-quota/quota-toast.json`, not `tui.json`.

| UI surface                     | Config                                                                                    | Notes                                                                                                                                                                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sidebar panel                  | `tuiSidebarPanel.enabled: true`                                                           | Full `Quota` panel in OpenCode's session sidebar. Requires the TUI plugin entry above.                                                                                                                                                                                         |
| Toast                          | `enableToast: true`                                                                       | Popup toast after idle/question/compact events. Requires the server plugin entry above.                                                                                                                                                                                        |
| Compact status line            | `tuiCompactStatus.enabled: true`                                                          | Short text-only quota line at the home bottom and chat/session prompt locations, for example `Copilot 94% \| OpenAI Pro 5h 100%, 7d 100%`. Requires the TUI plugin entry above.                                                                                                |
| Maintainer announcement notice | `maintainerAnnouncements.enabled: true`, `maintainerAnnouncements.home: true`             | Prefers the TUI home notice when the quota TUI plugin is configured. Without the TUI plugin, shows the same count-only notice once after the first visible quota toast.                                                                                                        |
| Inline slash commands          | Server plugin entry in `opencode.json`                                                    | `/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, and `/tokens_*` are registered once and shared by TUI and Desktop/server. They inject deterministic ignored/no-reply output without calling the model. The TUI plugin does not register command popups. |
| No automatic UI surfaces       | `enableToast: false`, `tuiSidebarPanel.enabled: false`, `tuiCompactStatus.enabled: false` | Skips toast/sidebar/compact surfaces while keeping inline slash commands and `opencode-quota show` available. Maintainer announcements use the separate installer question/config and can be opted out if desired.                                                             |

Selecting Compact status line in the installer enables both compact surfaces by default. To keep compact status home-only, set `tuiCompactStatus.sessionPrompt: false`.

In the sidebar panel, click the `Quota` header to switch between the compact summary (`▶ Quota`) and the detailed all-windows view (`▼ Quota`). OpenCode remembers the last sidebar state for the plugin.

For more examples, see [Common configuration](#common-configuration). For every option, see [Full configuration reference](#full-configuration-reference).

## Common configuration

Customize these settings in `opencode-quota/quota-toast.json`, next to the OpenCode config for your install scope.

Common locations:

- Project install: `<your-repo>/opencode-quota/quota-toast.json`
- Global install: usually `~/.config/opencode/opencode-quota/quota-toast.json`
- Custom config dir: `$OPENCODE_CONFIG_DIR/opencode-quota/quota-toast.json`

If you are unsure, run `/quota_status` or check the install-scope paths above.

### Maintainer announcements and privacy

Announcements are bundled only: no remote fetches, announcement telemetry, or persisted dismiss state. Use `/quota_announcements` to read active notices and `/quota_status` for counts/diagnostics. See **Configure maintainer announcements** below for options.

<details>
<summary><strong>Choose providers explicitly</strong></summary>

```jsonc
{
  "enabledProviders": ["copilot", "openai", "google-gemini-cli"],
}
```

</details>

<details>
<summary><strong>Show all quota reset periods</strong></summary>

```jsonc
{
  "formatStyle": "allWindows",
}
```

</details>

<details>
<summary><strong>Show used percentages</strong></summary>

```jsonc
{
  "percentDisplayMode": "used",
}
```

</details>

<details>
<summary><strong>Show finer-grained reset countdowns</strong></summary>

By default the reset countdown rounds to integer days and half-hour steps (`6d`, `2h`, `1h`, `0.5h`). Set `resetTimeDecimals` to render fractional durations instead, for example `5.7d` or `1.4h`. Applies to the Sidebar panel, popup toasts, and `opencode-quota show`.

```jsonc
{
  "resetTimeDecimals": 1,
}
```

Allowed values are integers `0`–`4`. Unset keeps the legacy compact rounding exactly.

</details>

<details>
<summary><strong>Turn off popup toasts</strong></summary>

Keeps terminal checks, any enabled UI surfaces, and `/quota`/`/quota_status`.

```jsonc
{
  "enableToast": false,
}
```

</details>

<details>
<summary><strong>Configure maintainer announcements</strong></summary>

```jsonc
{
  "maintainerAnnouncements": {
    "enabled": true,
    "home": true,
  },
}
```

Set `enabled: false` to disable automatic announcement surfaces. `/quota_announcements` lists active bundled notices while announcements are enabled.

</details>

<details>
<summary><strong>Turn off the Sidebar panel</strong></summary>

Useful when you want Compact status line only, toasts only, or inline slash commands without the Sidebar panel.

```jsonc
{
  "tuiSidebarPanel": {
    "enabled": false,
  },
}
```

</details>

<details>
<summary><strong>Keep Compact status line on home only</strong></summary>

Useful when you want the compact line on the home screen but not in the chat/session prompt area.

```jsonc
{
  "tuiCompactStatus": {
    "enabled": true,
    "homeBottom": true,
    "sessionPrompt": false,
  },
}
```

</details>

<details>
<summary><strong>Increase provider request timeout</strong></summary>

```jsonc
{
  "requestTimeoutMs": 12000,
}
```

</details>

<details>
<summary><strong>Write quota export file</strong></summary>

Writes a JSON file after each TUI background refresh for consumption by external tools (tmux, scripts, CI). See [External integration](external-integration.md).

```jsonc
{
  "export": {
    "enabled": true,
  },
}
```

</details>

<details>
<summary><strong>Advanced: legacy config sync</strong></summary>

By default, the installer writes quota settings only to `opencode-quota/quota-toast.json`. If you also want it to write the legacy OpenCode block, run:

```bash
npx @slkiser/opencode-quota init --sync-legacy-config
```

This is only for users who intentionally want `experimental.quotaToast` mirrored into `opencode.json` / `opencode.jsonc`.

</details>

## Full configuration reference

Settings go in the same `opencode-quota/quota-toast.json` sidecar described above.

Existing `experimental.quotaToast` settings still work when no sidecar file exists. Quota settings do not live in `tui.json`.

<details>
<summary><strong>All settings</strong></summary>

### Core/shared settings

| Option                        | Default        | Meaning                                                                                                                                                                                                                                                                                            |
| ----------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | `true`         | Master switch for quota collection and handled slash commands. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are handled as no-ops.                                                                                                                                 |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or set an explicit provider list.                                                                                                                                                                                                                                           |
| `minIntervalMs`               | `300000`       | Minimum fetch interval between provider updates.                                                                                                                                                                                                                                                   |
| `requestTimeoutMs`            | `5000`         | Remote provider request timeout in milliseconds.                                                                                                                                                                                                                                                   |
| `formatStyle`                 | `singleWindow` | Shared quota reset-period display for popup toasts, the Sidebar panel, and Compact status line unless a TUI surface override is set: `singleWindow` shows one reset period per provider; `allWindows` shows all reset periods per provider. Legacy `classic`/`grouped` aliases are still accepted. |
| `percentDisplayMode`          | `remaining`    | Shared quota percentage meaning for popup toasts, the Sidebar panel, and `/quota`: `remaining` shows quota left; `used` shows quota consumed.                                                                                                                                                      |
| `resetTimeDecimals`           | unset          | Decimal places for compact reset-countdown labels. Unset keeps legacy rounding (`6d`, `2h`, `0.5h`); an integer `0`–`4` renders fractional durations like `5.7d` or `1.4h`.                                                                                                                        |
| `onlyCurrentModel`            | `false`        | Filter quota rows to the current model/provider when that session selection can be resolved.                                                                                                                                                                                                       |
| `showSessionTokens`           | `true`         | Show the `Session input/output tokens` section when session token data is available. When cached input is present, the section keeps the legacy `in/out` layout and appends cached input in parentheses next to the input amount.                                                                  |
| `pricingSnapshot.source`      | `"auto"`       | Token pricing snapshot selection for `/tokens_*`: `auto`, `bundled`, or `runtime`.                                                                                                                                                                                                                 |
| `pricingSnapshot.autoRefresh` | `7`            | Refresh stale local pricing data after this many days.                                                                                                                                                                                                                                             |

### Toast settings

| Option            | Default | Meaning                                                                                       |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `enableToast`     | `true`  | Show popup toasts. Disabling this does not disable terminal checks, UI surfaces, or `/quota`. |
| `toastDurationMs` | `9000`  | Toast duration in milliseconds.                                                               |
| `showOnIdle`      | `true`  | Show a toast on the idle trigger.                                                             |
| `showOnQuestion`  | `true`  | Show a toast after a question/assistant response.                                             |
| `showOnCompact`   | `true`  | Show a toast after session compaction.                                                        |
| `showOnBothFail`  | `true`  | Show a fallback toast when providers attempted quota reads and all failed.                    |
| `layout.maxWidth` | `50`    | Toast formatting width target.                                                                |
| `layout.narrowAt` | `42`    | Toast compact-layout breakpoint.                                                              |
| `layout.tinyAt`   | `32`    | Toast tiny-layout breakpoint.                                                                 |
| `debug`           | `false` | Append toast debug context when troubleshooting.                                              |

### TUI settings

| Option                                             | Default              | Meaning                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tuiSidebarPanel.enabled`                          | `true`               | Show the Sidebar `Quota` panel when the TUI plugin is installed. Click the panel header to toggle between compact summary and detailed all-windows views; OpenCode remembers the last state. |
| `tuiSidebarPanel.formatStyle`                      | (root `formatStyle`) | Override `formatStyle` for the Sidebar panel only. Useful when you want `allWindows` detail in the sidebar but a different style elsewhere.                                                  |
| `tuiCompactStatus.enabled`                         | `false`              | Opt in to Compact status line UI surfaces.                                                                                                                                                   |
| `tuiCompactStatus.homeBottom`                      | `true`               | Show the Compact status line at the home bottom location.                                                                                                                                    |
| `tuiCompactStatus.sessionPrompt`                   | `true`               | Show the Compact status line by wrapping the TUI session prompt. Disable this if you only want the home-bottom line.                                                                         |
| `tuiCompactStatus.suppressWhenNativeProviderQuota` | `true`               | Hide the Compact status line when OpenCode exposes native provider-quota support.                                                                                                            |
| `tuiCompactStatus.maxWidth`                        | `96`                 | Maximum Compact status line text width.                                                                                                                                                      |
| `tuiCompactStatus.formatStyle`                     | (root `formatStyle`) | Override `formatStyle` for the Compact status line only. Useful when you want `singleWindow` on the compact line while the sidebar shows `allWindows`.                                       |

### Maintainer announcement settings

| Option                            | Default | Meaning                                                                                                                                                     |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maintainerAnnouncements.enabled` | `true`  | Enable bundled maintainer announcements.                                                                                                                    |
| `maintainerAnnouncements.home`    | `true`  | Show the count-only notice on TUI home when the quota TUI plugin is configured, or as a one-shot toast fallback after a visible quota toast when it is not. |

### Provider-specific settings

| Option                       | Default                            | Meaning                                                                                              |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `anthropicBinaryPath`        | `"claude"`                         | Command/path used for local Claude CLI probing.                                                      |
| `googleModels`               | `["CLAUDE"]`                       | Google model keys to query: `CLAUDE`, `G3PRO`, `G3FLASH`, `G3IMAGE`, `GPTOSS`.                       |
| `opencodeGoWindows`          | `["rolling", "weekly", "monthly"]` | OpenCode Go usage windows to display.                                                                |
| `alibabaCodingPlanTier`      | `"lite"`                           | Fallback Alibaba Coding Plan tier when auth does not include `tier`.                                 |
| `cursorPlan`                 | `"none"`                           | Cursor included API budget preset: `none`, `pro`, `pro-plus`, `ultra`.                               |
| `cursorIncludedApiUsd`       | unset                              | Override Cursor monthly included API budget in USD.                                                  |
| `cursorBillingCycleStartDay` | unset                              | Local billing-cycle anchor day `1..28`; when unset, Cursor usage resets on the local calendar month. |

### Export settings

| Option           | Default | Meaning                                                                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `export.enabled` | `false` | Write a JSON export file after each TUI background refresh.                                                                 |
| `export.path`    | `""`    | Export file path. Empty string uses the XDG default: `$XDG_CACHE_HOME/opencode/quota-export.json`. Supports `~/` expansion. |

</details>
