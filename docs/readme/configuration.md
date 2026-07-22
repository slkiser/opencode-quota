[← Back to README](../../README.md)

# Configuration

Most people only need the examples on this page. The full option list is at the bottom.

## Where settings live

OpenCode Quota normally keeps its settings in one separate file:

- Project install: `<your-repo>/opencode-quota/quota-toast.jsonc`
- Global install: usually `~/.config/opencode/opencode-quota/quota-toast.jsonc`
- Custom config directory: `$OPENCODE_CONFIG_DIR/opencode-quota/quota-toast.jsonc`

Strict `.json` files also work. Run `/quota_status` if you are unsure which file is active.

`opencode.jsonc` loads the main plugin. `tui.jsonc` loads TUI features. Put the settings below in `quota-toast.jsonc`, not `tui.jsonc`.

## Common changes

| You want                                 | Setting                       |
| ---------------------------------------- | ----------------------------- |
| Find providers automatically             | `enabledProviders: "auto"`    |
| Show every reset period                  | `formatStyle: "allWindows"`   |
| Show one quota window per provider       | `formatStyle: "singleWindow"` |
| Show quota used instead of left          | `percentDisplayMode: "used"`  |
| Show slash results with messages         | `tuiCommandDisplay: "inline"` |
| Show slash results in a TUI popup        | `tuiCommandDisplay: "dialog"` |
| Turn the TUI sidebar on or off           | `tuiSidebarPanel.enabled`     |
| Turn popup quota notifications on or off | `enableToast`                 |
| Turn the compact quota line on or off    | `tuiCompactStatus.enabled`    |
| Show or hide session input/output tokens | `showSessionTokens`           |

The installer chooses `allWindows` by default. If the setting is absent, the built-in default is `singleWindow`.

### Example

```jsonc
{
  // Find providers from OpenCode configuration and authentication.
  "enabledProviders": "auto",

  // Show every quota reset period as percentage remaining.
  "formatStyle": "allWindows",
  "percentDisplayMode": "remaining",

  // Keep TUI slash-command results with normal messages.
  "tuiCommandDisplay": "inline",

  // Show the sidebar, but not toast or compact status.
  "tuiSidebarPanel": { "enabled": true },
  "enableToast": false,
  "tuiCompactStatus": { "enabled": false },
}
```

Restart OpenCode after changing the file.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or lets you tune a maintained local estimate.

Use the guided command:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It asks what kind of provider you have, previews the complete canonical merged global config, and asks before writing. It never asks for a secret. For `json-v1`, paste one strict JSON adapter object; the same schema validator used at startup checks it before the preview.

The command updates the active global quota config. If a global `quota-toast.jsonc` or `.json` exists, it uses that file. Otherwise it uses the global `opencode.jsonc` or `.json`. Project custom-provider definitions are not allowed.

<details>
<summary><strong>How custom providers work</strong></summary>

- **Remote API:** reads real quota data from a supported HTTPS endpoint.
- **Local estimate:** counts matching OpenCode requests and can estimate spend.
- OpenCode Quota tries models.dev pricing automatically.
- Add `pricingModelMap` only when automatic matching cannot find one clear model.
- Generated counters live under `~/.local/state/opencode/opencode-quota/`.

A custom model provider still needs its normal OpenCode `provider` block. That block tells OpenCode how to use the model; `quotaProviders` tells OpenCode Quota how to measure it.

</details>

<details>
<summary><strong>Complete fallback example</strong></summary>

When no separate quota settings file exists, the guided command uses the global OpenCode config.

The command writes the `experimental.quotaToast.quotaProviders` section. Configure the normal OpenCode `provider` block separately:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": {
    "quotaToast": {
      "enabledProviders": "auto",
      "quotaProviders": [
        {
          "id": "openrouter-primary",
          "providerId": "openrouter",
          "label": "OpenRouter Primary",
          "mode": "remote-api",
          "url": "https://openrouter.ai/api/v1/key",
          "format": "openrouter-key-v1",
          "apiKeyEnv": "OPENROUTER_API_KEY",
        },
        {
          "id": "private-gateway",
          "label": "Private Gateway Estimate",
          "mode": "local-estimate",
          "modelIds": ["model-a"],
          "windows": [
            {
              "id": "daily",
              "label": "Daily",
              "type": "utc-day",
              "requestLimit": 1000,
              "usdBudget": 25,
            },
          ],
        },
      ],
    },
  },
  "provider": {
    "private-gateway": {
      "models": {
        "model-a": {},
      },
    },
  },
}
```

</details>

<details>
<summary><strong>Custom-provider rules</strong></summary>

- `quotaProviders` is global-only and keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` affects only `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Supported formats are `quota-v1`, `json-v1`, and `openrouter-key-v1`.
- `json-v1` requires an `adapter` with 1–16 mappings. Paths are literal own-property segment arrays, not JSONPath.
- Local estimates support 1–16 UTC-day or rolling request windows.
- Automatic models.dev matching runs first. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key entries in OpenCode `auth.json`.
- Definitions run automatically with `enabledProviders: "auto"`. A manual list must include `quota-providers` and every built-in provider you still want.
- To tune maintained estimates, use the reserved `qwen-code` or `alibaba-coding-plan` ID and its maintained window shape. Do not add a duplicate normal provider block.
- Project secrets, scripts, custom headers, executable mappings, regular expressions, and JSONPath are not accepted.

Run `/quota_status` to see the exact state path and safe authentication source without exposing secrets.

</details>

See [Providers](providers.md#custom-providers) for response formats and setup details.

## More recipes

<details>
<summary><strong>Choose providers yourself</strong></summary>

```jsonc
{
  "enabledProviders": ["copilot", "openai", "google-gemini-cli"],
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
<summary><strong>Keep compact status on Home only</strong></summary>

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
<summary><strong>Change maintainer notices</strong></summary>

```jsonc
{
  "maintainerAnnouncements": {
    "enabled": true,
    "home": true,
  },
}
```

Set `enabled` to `false` to turn automatic notices off.

</details>

<details>
<summary><strong>Allow more time for provider requests</strong></summary>

```jsonc
{
  "requestTimeoutMs": 12000,
}
```

</details>

<details>
<summary><strong>Write quota JSON for another tool</strong></summary>

```jsonc
{
  "export": {
    "enabled": true,
  },
}
```

See [External integration](external-integration.md).

</details>

<details>
<summary><strong>Advanced: also write the older OpenCode settings block</strong></summary>

```bash
npx @slkiser/opencode-quota init --sync-legacy-config
```

Use this only if another tool needs `experimental.quotaToast` mirrored into `opencode.jsonc` or `.json`.

</details>

## Full configuration reference

Most settings go in the same `opencode-quota/quota-toast.jsonc` or `.json` sidecar described above. The guided editor maintains `quotaProviders` in that authoritative sidecar when one exists; otherwise it uses the global OpenCode `experimental.quotaToast` section; do not duplicate it in a second file.

Existing `experimental.quotaToast` settings remain supported. Quota settings do not live in `tui.json`.

<details>
<summary><strong>All settings</strong></summary>

### Core/shared settings

| Option                        | Default        | Meaning                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                     | `true`         | Master switch for quota collection and handled slash commands. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are handled as no-ops.                                                                                                                                     |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or set an explicit provider list. Use the aggregate ID `quota-providers` for configured definitions.                                                                                                                                                                            |
| `quotaProviders`              | `[]`           | Ordered global-only `remote-api` or `local-estimate` definitions maintained in global OpenCode JSONC/JSON. Each item has a stable `id`; `providerId` is only needed when different.                                                                                                                    |
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

| Option                                             | Default              | Meaning                                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tuiCommandDisplay`                                | `"inline"`           | Choose where deterministic native TUI command output appears. `inline` adds an ignored/no-reply plain-text message to the active transcript and uses a dialog on Home; `dialog` always opens the local popup. |
| `tuiSidebarPanel.enabled`                          | `true`               | Show the Sidebar `Quota` panel when the TUI plugin is installed. Click the panel header to toggle between compact summary and detailed all-windows views; OpenCode remembers the last state.                  |
| `tuiSidebarPanel.formatStyle`                      | (root `formatStyle`) | Override `formatStyle` for the Sidebar panel only. Useful when you want `allWindows` detail in the sidebar but a different style elsewhere.                                                                   |
| `tuiCompactStatus.enabled`                         | `false`              | Opt in to Compact status line UI surfaces.                                                                                                                                                                    |
| `tuiCompactStatus.homeBottom`                      | `true`               | Show the Compact status line at the home bottom location.                                                                                                                                                     |
| `tuiCompactStatus.sessionPrompt`                   | `true`               | Show the Compact status line by wrapping the TUI session prompt. Disable this if you only want the home-bottom line.                                                                                          |
| `tuiCompactStatus.suppressWhenNativeProviderQuota` | `true`               | Hide the Compact status line when OpenCode exposes native provider-quota support.                                                                                                                             |
| `tuiCompactStatus.maxWidth`                        | `96`                 | Maximum Compact status line text width.                                                                                                                                                                       |
| `tuiCompactStatus.formatStyle`                     | (root `formatStyle`) | Override `formatStyle` for the Compact status line only. Useful when you want `singleWindow` on the compact line while the sidebar shows `allWindows`.                                                        |

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
| `cursorPlan`                 | `"none"`                           | Cursor included API budget preset: `none`, `pro`, `pro-plus`, `ultra`.                               |
| `cursorIncludedApiUsd`       | unset                              | Override Cursor monthly included API budget in USD.                                                  |
| `cursorBillingCycleStartDay` | unset                              | Local billing-cycle anchor day `1..28`; when unset, Cursor usage resets on the local calendar month. |

### Export settings

| Option           | Default | Meaning                                                                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `export.enabled` | `false` | Write a JSON export file after each TUI background refresh.                                                                 |
| `export.path`    | `""`    | Export file path. Empty string uses the XDG default: `$XDG_CACHE_HOME/opencode/quota-export.json`. Supports `~/` expansion. |

</details>
