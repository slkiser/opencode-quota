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

| You want                                   | Setting                       |
| ------------------------------------------ | ----------------------------- |
| Find providers automatically               | `enabledProviders: "auto"`    |
| Show every reset period                    | `formatStyle: "allWindows"`   |
| Show one quota window per provider         | `formatStyle: "singleWindow"` |
| Show quota used instead of left            | `percentDisplayMode: "used"`  |
| Show supplementary accounting facts        | `accountingDetail: "detailed"` |
| Show slash results with messages           | `tuiCommandDisplay: "inline"` |
| Show slash results in a TUI popup          | `tuiCommandDisplay: "dialog"` |
| Turn the TUI sidebar on or off             | `tuiSidebarPanel.enabled`     |
| Prefer an OpenCode Go collapsed row        | `tuiSidebarPanel.opencodeGoPreferredWindow` |
| Turn popup quota notifications on or off   | `enableToast`                 |
| Notify when weekly quota resets            | `resetNotifications.enabled`  |
| Turn the compact quota line on or off      | `tuiCompactStatus.enabled`    |
| Show a quota progress bar under the prompt | `tuiPromptBar.enabled`        |
| Show or hide session input/output tokens   | `showSessionTokens`           |
| Include descendant/subagent session tokens | `sessionTokenScope: "tree"`   |

The installer chooses `allWindows` by default. If the setting is absent, the built-in default is `singleWindow`.

### Example

```jsonc
{
  // Find providers from OpenCode configuration and authentication.
  "enabledProviders": "auto",

  // Show every quota reset period as percentage remaining.
  "formatStyle": "allWindows",
  "percentDisplayMode": "remaining",
  "accountingDetail": "summary",

  // Keep TUI slash-command results with normal messages.
  "tuiCommandDisplay": "inline",

  // Show the sidebar and prefer OpenCode Go's Five-hour row while collapsed.
  "tuiSidebarPanel": {
    "enabled": true,
    "opencodeGoPreferredWindow": "rolling",
  },
  "enableToast": false,
  "resetNotifications": { "enabled": false, "windows": ["weekly"] },
  "tuiCompactStatus": { "enabled": false },
  // Show a quota progress bar under the prompt.
  "tuiPromptBar": { "enabled": true },
}
```

Restart OpenCode after changing the file.

### Show accounting detail

`accountingDetail` is a root setting with two values:

- `"summary"` (default) keeps primary accounting rows and shows at most one supporting basis expression per percentage row.
- `"detailed"` also admits supplementary rows and, on wide output, can show separate `Used`, `Limit`, and `Remaining` facts.

It applies to human output from `/quota`, terminal `show`, popup toasts, the TUI sidebar, Compact status, and the prompt bar below the input. Narrow, tiny, 36-column sidebar, and compact layouts can omit basis or supplementary detail rather than truncate a financial value. The prompt bar always keeps one primary row and omits supplementary rows and basis details.

This setting is independent of `formatStyle`, which selects quota windows, and `percentDisplayMode`, which selects used or remaining percentage direction. Those display settings do not change provider input or cache identity. Changing only `accountingDetail` reprojects an available snapshot immediately; later collection still follows normal cache expiry, disabled-cache, and refresh rules. The words `Used`, `Limit`, and `Remaining` always keep their literal meanings in either percentage mode.

### Notify when quota becomes available again

Reset notifications are opt-in. They reuse provider snapshots already collected by OpenCode
Quota, so enabling them does not add provider requests.

```jsonc
{
  "resetNotifications": {
    "enabled": true,
    "windows": ["weekly"],
  },
}
```

The first observation establishes a baseline. A success toast appears only after OpenCode Quota
observes the advertised reset boundary, a newer reset timestamp, and an increase in remaining
quota. A local acknowledgment prevents the same reset from being announced again after restart.
The state file stores pseudonymous SHA-256 identity keys plus remaining percentages and reset,
observation, and acknowledgment timestamps. Literal account source identifiers, display labels, and
credentials are not written to it.

Reset notifications use the server popup-toast surface. They do not appear in slash-command or CLI
output, Sidebar, Compact status, status collection, telemetry, or JSON exports, and require a host
that supports `tui.showToast`. Supported window names are `fiveHour`, `hourly`, `daily`, `weekly`,
`monthly`, and `yearly`.

### Include subagent session tokens

Session totals use only the current session by default. To include the current session and every descendant or subagent session once:

```jsonc
{
  "showSessionTokens": true,
  "sessionTokenScope": "tree",
}
```

This scope applies to the embedded session-token output in `/quota` on Web and TUI, popup toasts, the TUI sidebar, and the compact line below the message input. It does not change `/tokens_session` or `/tokens_session_all`; those commands keep their explicit current-session and session-tree meanings.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or lets you tune a maintained local estimate.

Use the guided command:

```bash
npx @slkiser/opencode-quota@latest provider add
```

It asks what kind of provider you have, previews the complete canonical merged global config, and asks before writing. It never asks for a response body, credential, or secret value. For `json-v1`, it guides you through the optional rows path and each mapping one field at a time. The same schema validator used at startup checks the constructed adapter before the preview.

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
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key entries in OpenCode `opencode.db`.
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
  "enabledProviders": ["copilot", "openai", "google-agy"],
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
<summary><strong>Show finer-grained reset countdowns</strong></summary>

By default, toast, Sidebar, and terminal `show` countdowns keep the compact display (`6d`, `2h`, `0.5h`). Set `resetTimeDecimals` to an integer from `0` to `4` to show fractional durations such as `5.7d` or `1.4h`.

```jsonc
{
  "resetTimeDecimals": 1,
}
```

Leave it unset to preserve the default display exactly.

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

| Option                        | Default        | Meaning                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                     | `true`         | Master switch for quota collection and handled slash commands. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` are handled as no-ops.                                                                                                                                                  |
| `resetNotifications.enabled`  | `false`        | Emit a one-shot success toast when an observed configured quota window resets. Requires popup toasts to be enabled and adds no provider requests.                                                                                                                                                                   |
| `resetNotifications.windows`  | `["weekly"]`   | Window classes eligible for reset notifications: `fiveHour`, `hourly`, `daily`, `weekly`, `monthly`, or `yearly`.                                                                                                                                                                                                   |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or set an explicit provider list. Use the aggregate ID `quota-providers` for configured definitions.                                                                                                                                                                                         |
| `quotaProviders`              | `[]`           | Ordered global-only `remote-api` or `local-estimate` definitions maintained in global OpenCode JSONC/JSON. Each item has a stable `id`; `providerId` is only needed when different.                                                                                                                                 |
| `minIntervalMs`               | `300000`       | Minimum fetch interval between provider updates.                                                                                                                                                                                                                                                                    |
| `requestTimeoutMs`            | `5000`         | Remote provider request timeout in milliseconds.                                                                                                                                                                                                                                                                    |
| `formatStyle`                 | `singleWindow` | Shared quota reset-period display for TUI popup toasts, the Sidebar panel, and Compact status line unless a TUI surface override is set: `singleWindow` shows one reset period per provider; `allWindows` shows all reset periods per provider. Legacy `classic`/`grouped` aliases are still accepted.              |
| `percentDisplayMode`          | `remaining`    | Percentage/bar direction across human surfaces: `remaining` shows the percentage left; `used` shows the percentage consumed. It does not rename literal basis facts.                                                                                                                                               |
| `accountingDetail`            | `summary`      | Provider-neutral accounting detail across human surfaces: `summary` keeps primary rows; `detailed` also admits supplementary rows and fuller basis detail when width allows. Independent of `formatStyle` and `percentDisplayMode`.                                                                                |
| `resetTimeDecimals`           | unset          | Decimal places for compact reset countdowns in popup toasts, the Sidebar panel, and terminal `show`. Accepts integers `0`–`4`; unset preserves the default integer-day and half-hour-step display.                                                                                                                  |
| `onlyCurrentModel`            | `false`        | Filter quota rows to the current model/provider when that session selection can be resolved.                                                                                                                                                                                                                        |
| `showSessionTokens`           | `true`         | Show the `Session input/output tokens` section when session token data is available. When cached input is present, the section keeps the legacy `in/out` layout and appends cached input in parentheses next to the input amount.                                                                                   |
| `sessionTokenScope`           | `"current"`    | Choose `current` for the active session only or `tree` for the active session plus recursive descendants/subagents, counted once. Applies to `/quota`, popup toasts, the Sidebar panel, and the compact input line when `showSessionTokens` is enabled. Does not change `/tokens_session` or `/tokens_session_all`. |
| `pricingSnapshot.source`      | `"auto"`       | Token pricing snapshot selection for `/tokens_*`: `auto`, `bundled`, or `runtime`.                                                                                                                                                                                                                                  |
| `pricingSnapshot.autoRefresh` | `7`            | Refresh stale local pricing data after this many days.                                                                                                                                                                                                                                                              |

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
| `tuiSidebarPanel.enabled`                          | `true`               | Show the Sidebar `Quota` panel when the TUI plugin is installed. Click the panel header to toggle its collapsed/expanded window layout; OpenCode remembers the last state. This is not an `accountingDetail` override. |
| `tuiSidebarPanel.formatStyle`                      | (root `formatStyle`) | Override `formatStyle` for the Sidebar panel only. Useful when you want `allWindows` detail in the sidebar but a different style elsewhere.                                                                   |
| `tuiSidebarPanel.opencodeGoPreferredWindow`        | unset                | Prefer `rolling` (Five-hour), `weekly`, or `monthly` for OpenCode Go only while the sidebar is collapsed. If unset or unavailable, the lowest-remaining window is used. Expanded rows still follow `opencodeGoWindows`. |
| `tuiCompactStatus.enabled`                         | `false`              | Opt in to Compact status line UI surfaces.                                                                                                                                                                    |
| `tuiCompactStatus.homeBottom`                      | `true`               | Show the Compact status line at the home bottom location.                                                                                                                                                     |
| `tuiCompactStatus.sessionPrompt`                   | `true`               | Show the Compact status line by wrapping the TUI session prompt. Disable this if you only want the home-bottom line.                                                                                          |
| `tuiCompactStatus.suppressWhenNativeProviderQuota` | `true`               | Hide the Compact status line when OpenCode exposes native provider-quota support.                                                                                                                             |
| `tuiCompactStatus.maxWidth`                        | `96`                 | Maximum Compact status line text width.                                                                                                                                                                       |
| `tuiCompactStatus.formatStyle`                     | (root `formatStyle`) | Override `formatStyle` for the Compact status line only. Useful when you want `singleWindow` on the compact line while the sidebar shows `allWindows`.                                                        |
| `tuiPromptBar.enabled`                             | `false`              | Show one opt-in primary quota/accounting result below the TUI prompt and replace the Compact line there. Rich results use the first projected primary row; legacy-only results keep the existing 5h percentage preference. Basis and supplementary rows are omitted. |

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
| `opencodeGoWindows`          | `["rolling", "weekly", "monthly"]` | Choose which validated OpenCode Go API results are available across surfaces and in the expanded sidebar: Five-hour, Weekly, and Monthly. |
| `opencodeMonthlyLimit`       | unset                              | Override the OpenCode Zen monthly budget in USD.                                                     |
| `cursorPlan`                 | `"none"`                           | Cursor included API budget preset: `none`, `pro`, `pro-plus`, `ultra`.                               |
| `cursorIncludedApiUsd`       | unset                              | Override Cursor monthly included API budget in USD.                                                  |
| `cursorBillingCycleStartDay` | unset                              | Local billing-cycle anchor day `1..28`; when unset, Cursor usage resets on the local calendar month. |

Kilo Gateway has no `quota-toast.json` credential setting. Use `KILO_API_KEY`, trusted user/global `provider.kilo.options.apiKey`, or a strict `kilo` API-key entry in OpenCode `opencode.db`; project-local OpenCode config is not read for this secret. See [Kilo Gateway setup](providers.md#kilo-gateway).

Ollama Cloud has no `quota-toast.json` credential setting. Use `OLLAMA_API_KEY`, trusted user/global `provider.ollama-cloud.options.apiKey`, or a strict `ollama-cloud` API-key entry in OpenCode `opencode.db`; project-local OpenCode config is not read for this secret. See [Ollama Cloud setup](providers.md#ollama-cloud).

OpenCode Go has no `quota-toast.json` workspace ID, cookie, endpoint, credential, or token setting. It automatically uses `OPENCODE_API_KEY`, trusted user/global `provider.opencode-go.options.apiKey`, trusted user/global fallback `provider.opencode.options.apiKey`, a strict `opencode-go` API-key entry in OpenCode `opencode.db`, or a strict legacy `opencode` auth entry as the final fallback. `opencodeGoWindows` filters the Five-hour, Weekly, and Monthly rows returned by the official usage API, including the expanded sidebar. Use `tuiSidebarPanel.opencodeGoPreferredWindow` to prefer one available row only while the sidebar is collapsed. See [OpenCode Go setup](providers.md#opencode-go).

Xiaomi MiMo has no `quota-toast.json` credential or endpoint setting. Use `MIMO_USAGE_COOKIE` or trusted user/global `opencode-quota/mimo.json`; see [Xiaomi MiMo setup](providers.md#xiaomi-mimo).

**Removed Zen setting:** `opencodeZenDisplay` is no longer supported. Runtime loading stays diagnostic-only: if a file-backed, SDK, or legacy config source contains the key, `/quota_status` reports a nonfatal migration issue and does not translate it. The explicit `update` command migrates recognized file-backed `"default"` to root `accountingDetail: "summary"` and `"detailed"` to `"detailed"`. If a valid `accountingDetail` already exists, it stays authoritative and the ignored old key is removed. Unknown or invalid values, invalid replacements, duplicate keys, ambiguous structures, and SDK-only sources remain unchanged for manual review. See [Updating safely](updating.md#what-can-change-automatically).

### Export settings

| Option           | Default | Meaning                                                                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `export.enabled` | `false` | Write a JSON export file after each TUI background refresh.                                                                 |
| `export.path`    | `""`    | Export file path. Empty string uses the XDG default: `$XDG_CACHE_HOME/opencode/quota-export.json`. Supports `~/` expansion. |

### Telemetry settings

| Option              | Default | Meaning                                                                                                                         |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.enabled` | `false` | Publish quota consumption and cache-age gauges through the host's global OpenTelemetry `MeterProvider`; adds no provider calls. |

See [External integration](external-integration.md#3-send-opentelemetry-metrics) for metric names, attributes, setup, and privacy behavior.

</details>
