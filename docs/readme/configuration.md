[← Back to README](../../README.md)

# Configuration

Most people only need the table below. Every option is listed at the bottom.

## Where settings live

Settings go in one separate file:

- Project install: `<your-repo>/opencode-quota/quota-toast.jsonc`
- Global install: `~/.config/opencode/opencode-quota/quota-toast.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- Custom config folder: `$OPENCODE_CONFIG_DIR/opencode-quota/quota-toast.jsonc` (replaces the global folder, like OpenCode 2)

Strict `.json` files also work. Not sure which file is active? Run `/quota_status`. Restart OpenCode after changing the file.

## Common changes

| You want                                    | Setting                                     |
| ------------------------------------------- | ------------------------------------------- |
| Find providers automatically                | `enabledProviders: "auto"`                  |
| Pick providers yourself                     | `enabledProviders: ["copilot", "openai"]`   |
| Show every reset period                     | `formatStyle: "allWindows"`                 |
| Show one quota window per provider          | `formatStyle: "singleWindow"`               |
| Show quota used instead of left             | `percentDisplayMode: "used"`                |
| Estimate when fixed quota runs out          | `quotaProjection: "runway"`                 |
| Show `81%` instead of `81% left`            | `percentLabelStyle: "bare"`                 |
| Show `2d5h14m` instead of `2d 5h 14m`       | `resetTimeSpaced: false`                    |
| Show reset countdowns as decimals (`5.7d`)  | `resetTimeDecimals: 1`                      |
| Show extra accounting rows                  | `accountingDetail: "detailed"`              |
| Keep TUI slash reports in the chat          | `tuiCommandDisplay: "inline"`               |
| Turn the TUI sidebar on or off              | `tuiSidebarPanel.enabled`                   |
| Pick OpenCode Go's collapsed-sidebar row    | `tuiSidebarPanel.opencodeGoPreferredWindow` |
| Turn popup quota notifications on or off    | `enableToast`                               |
| Get a popup when weekly quota resets        | `resetNotifications.enabled`                |
| Turn the compact quota line on or off       | `tuiCompactStatus.enabled`                  |
| Show a quota bar under the prompt           | `tuiPromptBar.enabled`                      |
| Show or hide session input/output tokens    | `showSessionTokens`                         |
| Include subagent session tokens             | `sessionTokenScope: "tree"`                 |
| Allow more time for provider requests       | `requestTimeoutMs: 12000`                   |
| Write quota JSON for another tool           | `export.enabled: true`                      |
| Keep OpenCode's normal retry after a limit  | `waitForQuotaReset: false`                  |

The installer picks `allWindows`. If the setting is missing, the default is `singleWindow`.

Example:

```jsonc
{
  "enabledProviders": ["copilot", "openai", "google-agy"],
  "formatStyle": "allWindows",
  "percentDisplayMode": "remaining",
  "quotaProjection": "runway",
  "tuiCommandDisplay": "inline",
  "tuiSidebarPanel": { "enabled": true, "opencodeGoPreferredWindow": "rolling" },
  "enableToast": false,
  "tuiCompactStatus": { "enabled": true, "homeBottom": true, "sessionPrompt": false },
  "tuiPromptBar": { "enabled": true },
}
```

### Show accounting detail

`accountingDetail` has two values:

- `"summary"` (default): main rows only, with at most one supporting detail per percentage row.
- `"detailed"`: also shows supplementary rows and, on wide output, separate `Used`, `Limit`, and `Remaining` values.

It applies to `/quota`, terminal `show`, popup toasts, the sidebar, the compact line, and the prompt bar. Narrow layouts may drop detail rather than cut off a money value; the prompt bar always shows one main row. It is separate from `formatStyle` (which windows) and `percentDisplayMode` (used or left). `Used`, `Limit`, and `Remaining` always mean exactly that, in either mode. A change applies right away to data already fetched.

### Estimate when fixed quota runs out

`quotaProjection: "runway"` (off by default) adds a **Runs out** estimate to eligible rows on `/quota`, terminal `show`, popup toasts, the expanded sidebar, the compact line, and the prompt bar.

- It is a straight-line average since the fixed window began: used percentage divided by time passed. It is not a recent-rate forecast. `percentDisplayMode` does not change it.
- Full displays say **Runs out ≈ 1h 50m**; the compact line and prompt bar say **r/o ≈ 1h 50m**. Partial minutes round up. If your current pace lasts past the reset, it says **lasts past reset**. The reset countdown stays separate.
- It uses cached data, makes no extra provider requests, and adds nothing to the JSON export.

Only rows with a known fixed window start, end, and full reset qualify. Labels such as Five-hour, Weekly, Monthly, or RPM never qualify a row by themselves:

- **OpenAI:** known 5-hour, weekly, or monthly rate-limit windows with `limit_window_seconds` and an exact reset. Spend-control rows, code-review rows, and unknown durations are excluded.
- **xAI:** credit periods with both `currentPeriod.start` and `currentPeriod.end`. A billing-end date without a start is excluded.
- **Cursor:** the included API budget when `cursorBillingCycleStartDay` is set. The calendar-month fallback, partial or unknown model spend, and spend-only rows are excluded.
- **Custom local estimates:** `utc-day` request and priced budget percentages. `rolling` windows and unpriced rows are excluded.

Everything else (rolling windows, RPM, balance, status, unlimited rows) is left unchanged.

### Notify when quota becomes available again

```jsonc
{
  "resetNotifications": { "enabled": true, "windows": ["weekly"] },
}
```

- Off by default. It reuses data already fetched, so it adds no provider requests.
- A popup appears only after OpenCode Quota sees the reset time pass, a newer reset time, and more quota left. The same reset is never announced twice, even after a restart.
- It shows as a second popup right after the quota toast, so it needs `enableToast` and a toast trigger (`showOnIdle`, `showOnCompact`, or `showOnQuestion`). It never appears anywhere else.
- Windows: `fiveHour`, `hourly`, `daily`, `weekly`, `monthly`, and `yearly`.
- Its state file stores only hashed (SHA-256) account keys, remaining percentages, and timestamps, never account names, labels, or credentials.

### Include subagent session tokens

Session totals count only the current session by default. `sessionTokenScope: "tree"` adds every subagent session, counted once. This applies to the session tokens in `/quota`, popup toasts, the sidebar, and the compact line. It does not change `/tokens_session` or `/tokens_session_all`.

### Countdown and label styles

- Reset countdowns are exact and spaced by default, such as `6d 1h 17m`, `2h 14m`, or `37m`. Partial minutes round up.
- `resetTimeSpaced: false` writes `2d5h14m` instead of `2d 5h 14m`. Minute-only values, `reset`, and rounding stay the same. It applies to `/quota`, popup toasts, terminal `show`, the sidebar, the compact line, and the prompt bar.
- `resetTimeDecimals` (`0` to `4`) shows the largest unit as a decimal, such as `5.7d` or `1.4h`, in popup toasts, the sidebar, terminal `show`, and the prompt bar. It wins over `resetTimeSpaced` where it applies.
- `percentLabelStyle: "bare"` shows `81%` instead of `81% left` (or `19%` instead of `19% used`). Full reports and the sidebar then show `Quota [Remaining]` or `Quota [Used]` as the heading, and the sidebar gives the freed space to its bars. The compact line and prompt bar are always bare.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or tunes a maintained local estimate. Use the guided command:

```bash
npx @slkiser/opencode-quota@latest provider add
```

- It asks what kind of provider you have, previews the full merged global config, and asks before writing. It never asks for a response body, credential, or secret.
- For `json-v1`, it walks you through the optional rows path and each mapping one field at a time, and checks the result with the same validator used at startup.
- It writes to the global `quota-toast.jsonc` or `.json` if one exists, otherwise to the global `opencode.jsonc` or `.json`. Project definitions are not allowed.

Rules:

- `quotaProviders` is global-only and keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` affects only `onlyCurrentModel`. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Formats: `quota-v1`, `json-v1`, and `openrouter-key-v1`. `json-v1` needs an `adapter` with 1–16 mappings; paths are literal own-property segment arrays, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Counters live under `~/.local/state/opencode/opencode-quota/quota-providers/`.
- Automatic models.dev matching runs first. Add `pricingModelMap` only when it cannot find one clear model. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, trusted global `provider.<providerId>.options.apiKey`, then API-key logins saved in OpenCode 2 (`opencode.db`).
- Definitions run automatically with `enabledProviders: "auto"`. A manual list must include `quota-providers` and every built-in provider you still want.
- To tune maintained estimates, use the reserved `alibaba-coding-plan` ID and its window shape. Do not add a duplicate normal provider block.
- Not accepted: project secrets, scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode `provider` block: that block tells OpenCode how to use the model, and `quotaProviders` tells OpenCode Quota how to measure it.
- `/quota_status` shows the exact state path and safe credential source, never URLs, keys, headers, response bodies, counter contents, or raw errors.

<details>
<summary><strong>Complete example (no separate quota settings file)</strong></summary>

Without a `quota-toast` file, the guided command writes `experimental.quotaToast.quotaProviders` in the global OpenCode config. Set up the normal OpenCode `provider` block yourself:

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
            { "id": "daily", "label": "Daily", "type": "utc-day", "requestLimit": 1000, "usdBudget": 25 },
          ],
        },
      ],
    },
  },
  "provider": {
    "private-gateway": {
      "models": { "model-a": {} },
    },
  },
}
```

</details>

## Full configuration reference

Most settings go in the `opencode-quota/quota-toast.jsonc` or `.json` file described above. The guided editor keeps `quotaProviders` in that file when it exists; otherwise it uses the global OpenCode JSONC/JSON `experimental.quotaToast` section; do not duplicate it in a second file. Existing `experimental.quotaToast` settings still work. To also mirror settings into `experimental.quotaToast` for another tool, run `npx @slkiser/opencode-quota init --sync-legacy-config`.

Provider credentials (API keys, cookies, tokens) are never set here. See [API keys](providers.md#api-keys) and each provider's [setup notes](providers.md#provider-setup-notes).

<details>
<summary><strong>All settings</strong></summary>

### Core settings

| Option                        | Default        | Meaning |
| ----------------------------- | -------------- | ------- |
| `enabled`                     | `true`         | Master switch. When `false`, `/quota`, `/quota_status`, `/pricing_refresh`, and `/tokens_*` do nothing. |
| `enabledProviders`            | `"auto"`       | Auto-detect providers, or list them. Use `quota-providers` for custom definitions. |
| `quotaProviders`              | `[]`           | Custom provider definitions (global-only). See [Custom providers](#custom-providers). |
| `minIntervalMs`               | `300000`       | Minimum time between provider updates. |
| `requestTimeoutMs`            | `5000`         | Provider request timeout in milliseconds. |
| `formatStyle`                 | `singleWindow` | `singleWindow` shows one reset period per provider; `allWindows` shows all. Used by toasts, the sidebar, and the compact line unless they override it. Old `classic`/`grouped` names still work. |
| `percentDisplayMode`          | `remaining`    | `remaining` shows what is left; `used` shows what is used. |
| `quotaProjection`             | unset          | `"runway"` adds a **Runs out** estimate. See [above](#estimate-when-fixed-quota-runs-out). |
| `percentLabelStyle`           | unset          | `bare` drops `left`/`used` from labels. `full` is also accepted. |
| `accountingDetail`            | `summary`      | `summary` or `detailed`. See [above](#show-accounting-detail). |
| `resetTimeDecimals`           | unset          | `0`–`4`: show the largest countdown unit as a decimal. |
| `resetTimeSpaced`             | `true`         | `false` writes countdowns without spaces (`2d5h14m`). |
| `onlyCurrentModel`            | `false`        | Show only the current model's provider, when it can be found. |
| `waitForQuotaReset`           | `true`         | On by default. When a request hits a provider limit, the plugin asks that model's provider for fresh quota; if a window shows 0% left, OpenCode retries 1 minute after the earliest such window resets (at most 5 hours per wait) instead of retrying quickly or giving up. Interrupt the session to stop waiting (Esc twice in the TUI). Set `"waitForQuotaReset": false` to keep OpenCode's normal retry timing. |
| `showSessionTokens`           | `true`         | Show `Session input/output tokens` when available. Cached input appears in parentheses next to input. |
| `sessionTokenScope`           | `"current"`    | `current` or `tree` (adds subagent sessions). See [above](#include-subagent-session-tokens). |
| `resetNotifications.enabled`  | `false`        | Popup when a watched window resets. Needs popup toasts. |
| `resetNotifications.windows`  | `["weekly"]`   | `fiveHour`, `hourly`, `daily`, `weekly`, `monthly`, or `yearly`. |
| `pricingSnapshot.source`      | `"auto"`       | Token pricing for `/tokens_*`: `auto`, `bundled`, or `runtime`. |
| `pricingSnapshot.autoRefresh` | `7`            | Refresh local pricing after this many days. |

### TUI toast settings

Toasts appear only in the TUI, never in Web or Desktop.

| Option            | Default | Meaning |
| ----------------- | ------- | ------- |
| `enableToast`     | `true`  | Show popup toasts. Turning it off does not affect `/quota` or other displays. |
| `toastDurationMs` | `9000`  | How long a toast stays, in milliseconds. |
| `showOnIdle`      | `true`  | Show a toast after each finished reply. |
| `showOnQuestion`  | `true`  | Show a toast after the assistant's `question` tool finishes. |
| `showOnCompact`   | `true`  | Show a toast after session compaction. |
| `showOnBothFail`  | `true`  | Show a toast when every provider failed. |
| `layout.maxWidth` | `50`    | Toast width target. |
| `layout.narrowAt` | `42`    | Width where the toast switches to its narrow layout. |
| `layout.tinyAt`   | `32`    | Width where the toast switches to its tiny layout. |
| `debug`           | `false` | Add debug details to toasts. |

### TUI settings

| Option                                      | Default              | Meaning |
| ------------------------------------------- | -------------------- | ------- |
| `tuiCommandDisplay`                         | `"dialog"`           | Where TUI slash reports appear: `dialog` (popup, no chat message) or `inline` (in the chat). Web and Desktop always use the chat. If a session is open in the TUI and in Web, `dialog` also removes a Web `/quota` report from the chat while the TUI shows that session. |
| `tuiSidebarPanel.enabled`                   | `true`               | Show the sidebar `Quota` panel. Click its header to collapse or expand; OpenCode remembers the choice. |
| `tuiSidebarPanel.formatStyle`               | (root `formatStyle`) | Sidebar-only `formatStyle`. |
| `tuiSidebarPanel.opencodeGoPreferredWindow` | unset                | `rolling`, `weekly`, or `monthly`: OpenCode Go's row while the sidebar is collapsed. Unset or unavailable uses the lowest remaining window. |
| `tuiCompactStatus.enabled`                  | `false`              | Show the compact status line. |
| `tuiCompactStatus.homeBottom`               | `true`               | Show it at the bottom of Home. |
| `tuiCompactStatus.sessionPrompt`            | `true`               | Show it below the session prompt. |
| `tuiCompactStatus.maxWidth`                 | `96`                 | Maximum line width. |
| `tuiCompactStatus.formatStyle`              | (root `formatStyle`) | Compact-line-only `formatStyle`. |
| `tuiPromptBar.enabled`                      | `false`              | Show one main quota row as a bar below the prompt, replacing the compact line there. Labels look like `OpenAI 5h`; the bar is a fixed 12 cells, and long labels end in an ellipsis. |

### Maintainer notices

| Option                                  | Default   | Meaning |
| --------------------------------------- | --------- | ------- |
| `maintainerAnnouncements.enabled`       | `true`    | Show bundled maintainer notices. |
| `maintainerAnnouncements.home`          | `true`    | Show the count of active notices at the bottom of Home. |
| `maintainerAnnouncements.homeFrequency` | `"daily"` | `"daily"`: show that Home line on the first Home screen of each day, for 10 minutes. `"always"`: show it on every Home screen. `/quota_announcements` always lists the notices. |

### Provider settings

| Option                       | Default                            | Meaning |
| ---------------------------- | ---------------------------------- | ------- |
| `anthropicBinaryPath`        | `"claude"`                         | Claude CLI command or path. With `"claude"`, OpenCode's `PATH` is tried first, then the usual install folders (not on Windows). |
| `opencodeGoWindows`          | `["rolling", "weekly", "monthly"]` | Which OpenCode Go windows appear: Five-hour, Weekly, and Monthly. |
| `opencodeMonthlyLimit`       | unset                              | Override the OpenCode Zen monthly budget in USD. |
| `cursorPlan`                 | `"none"`                           | Cursor included API budget: `none`, `pro`, `pro-plus`, or `ultra`. |
| `cursorIncludedApiUsd`       | unset                              | Override Cursor's monthly included API budget in USD. |
| `cursorBillingCycleStartDay` | unset                              | Billing day `1`–`28`. Unset uses the local calendar month. |

The old `opencodeZenDisplay` setting is gone. If it is still in your config, it is ignored and `/quota_status` reports it; `update` can migrate it. See [What can change automatically](updating.md#what-can-change-automatically).

### Export and telemetry settings

| Option              | Default | Meaning |
| ------------------- | ------- | ------- |
| `export.enabled`    | `false` | Write a JSON file each time the TUI Home quota footer refreshes. |
| `export.path`       | `""`    | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`. Supports `~/`. A relative path is relative to your home folder, where OpenCode's service runs. |
| `telemetry.enabled` | `false` | Publish quota and cache-age gauges through OpenCode's global OpenTelemetry `MeterProvider`. No extra provider calls. |

See [External integration](external-integration.md) for details.

</details>
