# Configuration

[← Back to README](../../README.md)

UI surface choices, common recipes, and the full configuration reference.

## Choose your UI surfaces

All UI surfaces use the same quota data. Put these settings in `opencode-quota/quota-toast.json`, not `tui.json`.

| UI surface                     | Config                                                                                    | Notes                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar panel                  | `tuiSidebarPanel.enabled: true`                                                           | Full `Quota` panel in OpenCode's session sidebar. Requires the TUI plugin entry above.                                                                                                                                                                                             |
| TUI toast                      | `enableToast: true`                                                                       | Popup toast after idle/question/compact events in the TUI. Requires the server plugin entry above; OpenCode 1.17.20 Web does not surface the TUI toast event.                                                                                                                      |
| Compact status line            | `tuiCompactStatus.enabled: true`                                                          | Short text-only quota line at the home bottom and chat/session prompt locations, for example `Copilot 94% \| OpenAI Pro 5h 100%, 7d 100%`. Requires the TUI plugin entry above.                                                                                                    |
| Maintainer announcement notice | `maintainerAnnouncements.enabled: true`, `maintainerAnnouncements.home: true`             | Prefers the TUI home notice when the quota TUI plugin is configured. Without the TUI plugin, shows the same count-only notice once after the first visible TUI quota toast.                                                                                                        |
| Inline slash commands          | Server plugin entry in `opencode.json`                                                    | `/quota`, `/quota_status`, `/quota_announcements`, `/pricing_refresh`, and `/tokens_*` are registered once and shared by TUI and Web/Desktop server. They inject deterministic ignored/no-reply output without calling the model. The TUI plugin does not register command popups. |
| No automatic UI surfaces       | `enableToast: false`, `tuiSidebarPanel.enabled: false`, `tuiCompactStatus.enabled: false` | Skips toast/sidebar/compact surfaces while keeping inline slash commands and `opencode-quota show` available. Maintainer announcements use the separate installer question/config and can be opted out if desired.                                                                 |

In OpenCode 1.17.20, `/quota` works in TUI and Web without calling a model. Web can show a false `Failed to send command` notification after the deterministic output appears; do not retry automatically after output is visible. This predates v4 and is also reproducible with v3.11.2. Safari/macOS notification permissions do not add TUI toast support to Web.

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

### OpenCode provider declaration precedence

An OpenCode `provider` declaration tells OpenCode how a provider is configured; it is separate from the OpenCode Quota sidecar above. Detection reads the selected global `opencode.jsonc` or `opencode.json` first, then the selected project file. A project declaration overrides the same global provider only for that project.

In auto-detect mode, working auth for a built-in provider can add a missing empty declaration to the selected global OpenCode config. The write uses the existing global JSON or JSONC format; when the global file does not exist, it uses the selected project format and otherwise defaults to JSONC. Project config is never automatically written, and an existing project declaration counts as configured for that project.

<a id="custom-accounting-sources"></a>

### Custom providers

`customSources` is the exception to ordinary config layering: it is accepted only in the canonical global `<OpenCode user config dir>/opencode-quota/quota-toast.json`. The usual path is `~/.config/opencode/opencode-quota/quota-toast.json`; when `OPENCODE_CONFIG_DIR` is set, use `$OPENCODE_CONFIG_DIR/opencode-quota/quota-toast.json`. Project/workspace sidecars, `experimental.quotaToast`, SDK config, and alternate global plugin files cannot define custom sources.

Copy this complete example into that canonical global file:

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
      "modelIds": ["openrouter/anthropic/claude-sonnet-4"],
    },
    {
      "id": "internal-accounting",
      "providerId": "internal_gateway",
      "url": "https://gateway.example/accounting",
      "preset": "accounting-v1",
    },
  ],
}
```

- `id` is the stable source identity. Labels may repeat; IDs may not.
- `providerId` must exactly match an OpenCode runtime provider ID. It also selects trusted global OpenCode config and `auth.json` lookup.
- `modelIds` is optional and affects only `onlyCurrentModel`: omission covers every model for that `providerId`; a present list contains exact, case-sensitive full `<providerId>/<modelId>` values. It does not filter response rows or select pricing.
- Credentials resolve as: explicit `apiKeyEnv` → trusted global `provider.<providerId>.options.apiKey` → strict `{ "type": "api", "key": "..." }` in OpenCode `auth.json`.
- `accounting-v1` and `openrouter-key-v1` are the only presets. Add `custom-sources` to `enabledProviders` in manual mode.
- In `singleWindow`, each source contributes its limiting percentage row, or its first value row when it has no percentage row. `allWindows` keeps all rows.

See [Providers](providers.md#custom-accounting-sources) for the response contract and security limits.

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
<summary><strong>Turn off TUI popup toasts</strong></summary>

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

| Option                        | Default        | Meaning                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                     | `true`         | Master switch for quota collection and handled slash commands. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are handled as no-ops.                                                                                                                                     |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or set an explicit provider list. Use the aggregate ID `custom-sources` for configured accounting sources.                                                                                                                                                                      |
| `customSources`               | `[]`           | Global-only ordered custom accounting definitions. Each source uses `id`, `providerId`, `url`, `preset`, and optional `label`, `apiKeyEnv`, `modelIds`.                                                                                                                                                |
| `minIntervalMs`               | `300000`       | Minimum fetch interval between provider updates.                                                                                                                                                                                                                                                       |
| `requestTimeoutMs`            | `5000`         | Remote provider request timeout in milliseconds.                                                                                                                                                                                                                                                       |
| `formatStyle`                 | `singleWindow` | Shared quota reset-period display for TUI popup toasts, the Sidebar panel, and Compact status line unless a TUI surface override is set: `singleWindow` shows one reset period per provider; `allWindows` shows all reset periods per provider. Legacy `classic`/`grouped` aliases are still accepted. |
| `percentDisplayMode`          | `remaining`    | Shared quota percentage meaning for TUI popup toasts, the Sidebar panel, and `/quota`: `remaining` shows quota left; `used` shows quota consumed.                                                                                                                                                      |
| `onlyCurrentModel`            | `false`        | Filter quota rows to the current model/provider when that session selection can be resolved.                                                                                                                                                                                                           |
| `showSessionTokens`           | `true`         | Show the `Session input/output tokens` section when session token data is available. When cached input is present, the section keeps the legacy `in/out` layout and appends cached input in parentheses next to the input amount.                                                                      |
| `pricingSnapshot.source`      | `"auto"`       | Token pricing snapshot selection for `/tokens_*`: `auto`, `bundled`, or `runtime`.                                                                                                                                                                                                                     |
| `pricingSnapshot.autoRefresh` | `7`            | Refresh stale local pricing data after this many days.                                                                                                                                                                                                                                                 |

### TUI toast settings

| Option            | Default | Meaning                                                                                                                                                     |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enableToast`     | `true`  | Show TUI popup toasts. OpenCode 1.17.20 Web does not surface these events. Disabling this does not disable terminal checks, other UI surfaces, or `/quota`. |
| `toastDurationMs` | `9000`  | Toast duration in milliseconds.                                                                                                                             |
| `showOnIdle`      | `true`  | Show a toast on the idle trigger.                                                                                                                           |
| `showOnQuestion`  | `true`  | Show a toast after a question/assistant response.                                                                                                           |
| `showOnCompact`   | `true`  | Show a toast after session compaction.                                                                                                                      |
| `showOnBothFail`  | `true`  | Show a fallback toast when providers attempted quota reads and all failed.                                                                                  |
| `layout.maxWidth` | `50`    | Toast formatting width target.                                                                                                                              |
| `layout.narrowAt` | `42`    | Toast compact-layout breakpoint.                                                                                                                            |
| `layout.tinyAt`   | `32`    | Toast tiny-layout breakpoint.                                                                                                                               |
| `debug`           | `false` | Append toast debug context when troubleshooting.                                                                                                            |

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
