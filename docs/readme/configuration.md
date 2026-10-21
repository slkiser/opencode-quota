[← Back to README](../../README.md)

# Configuration

Most people need no settings. When you do, the table below covers the usual changes, and every setting but `version` is listed at the bottom.

## Where settings live

One global file, `settings.jsonc`:

- `~/.config/opencode/opencode-quota/settings.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- `$OPENCODE_CONFIG_DIR/opencode-quota/settings.jsonc` when `OPENCODE_CONFIG_DIR` is set (it replaces the global folder, like OpenCode 2)

There are no project settings. Comments and trailing commas are allowed. Every key is optional. A missing or invalid value uses its default. `/quota_status` shows the file it reads and any problems in it.

Every quota setting lives here, in the sections `sidebar`, `collapsed`, `statusLine`, `toast`, `colors`, `layout`, `words`, `providers`, and `system`. In the TUI, `/quota_settings` edits them through the server. Its **Layout** tab has **All places** (`layout` and `words`) and a page per place (Sidebar, Collapsed, Status line, Toast); **Colors** and **Providers** edit their own sections, and the window's Plugin tab the `system` switches. Save, or ctrl+s, writes them to this file and keeps its comments. While you edit, the sidebar, status line, toasts and quota window show saved values with your unsaved changes on top. Discard drops those changes. File edits and a Save from any TUI reach all open TUIs within a few seconds.

Only the sidebar panel's open or collapsed state lives in OpenCode's plugin storage. Custom definitions, the Claude CLI path and the export path are file-only settings. The Plugin tab (`/quota_status`) has the old command names, quota file and OpenTelemetry switches; they save as soon as you change them.

OpenCode Quota writes only the settings you change. A setting the file does not set uses its default, also when a newer version changes that default. **Reset page** (ctrl+r; **Reset tab** on Colors and Providers) removes that page's settings, except row names, from the file on Save, so they use their defaults again. On Providers it also puts each custom provider's switch back to its saved state.

Without the file, OpenCode Quota uses its defaults and writes nothing. The first Save, Plugin tab switch or agent change creates it with `version` and the settings changed. After 4.x or 5.x, the first start converts the global settings you set there into it. See [Updating](updating.md#moving-from-5x).

## Common changes

| You want | Setting |
| --- | --- |
| Check every provider quota finds | `providers.off: []` |
| Skip a provider | `providers.off: ["openai"]` |
| Show quota used instead of left | `words.percent: "used"` |
| Show `81%` instead of `81% left` | `words.percent: "bare"` |
| Show `3d 23h 58m` instead of `4.0d` | `words.reset: "exact"` |
| Show `2h14m` instead of `2h 14m` | `words.reset: "compact"` |
| Show reset countdowns as decimals | `words.reset: "decimal"` |
| Show `Weekly` instead of `7d` | `words.rowNames: "full"` |
| Show extra accounting rows | `words.detail: "detailed"` |
| Show only the current model's provider | `words.onlyCurrentModel: true` |
| Include subagent session tokens | `words.sessionTokens: "tree"` |
| Allow more time for provider requests | `providers.checking.requestTimeoutMs: 12000` |
| Keep OpenCode's normal retry after a limit | `providers.checking.waitForQuotaReset: false` |
| Write quota JSON for another tool | `system.exportFile: true` |

Nest the keys in the file:

```jsonc
{
  "sidebar": { "sessionTokens": false },
  "collapsed": { "window": { "anthropic": "five_hour" } },
  "statusLine": { "window": { "anthropic": "week" } },
  "toast": { "afterReply": "off" },
  "colors": { "good": "green" },
  "layout": { "barWidth": 10 },
  "words": { "percent": "used", "reset": "compact" },
  "providers": { "off": ["openai"], "checking": { "requestTimeoutMs": 12000 } },
  "system": { "exportFile": true },
}
```

The `words` settings apply to the sidebar, status line, toasts, `/quota`, and terminal `show`; `words.rowNames` applies only to the sidebar, status line and toasts. Web and Desktop `/quota` text and terminal `show` always include "runs out in" when the limit's pace runs out before its reset. Each TUI surface has its own `runsOut` switch: on for the sidebar and toasts, off for the one-line collapsed sidebar and status line. The Limits tab always shows pace.

## TUI surfaces

The sidebar, collapsed sidebar, toasts and the status line's big bar (`statusLine.detail: "one"`) show a row's window (`5h`, `7d`, `30d`) instead of its name, unless the row has no window or shares it with another row of the provider. `words.rowNames: "full"` shows every row's name (`Weekly`). A row you renamed shows your name either way.

- Sidebar shows a bar per row and session tokens. Under the session tokens, `⚠ low cache: 35% (claude-sonnet-5)` names the session's model with the lowest cache hit when it read 200K input tokens or more and got less than half of them from the cache. Its title carries the percent's word from `words.percent` ("Quota left"), so its rows show only the number. Click the title to collapse it. `sidebar.names` holds row names by row id. The collapsed sidebar, status line and quota window's Limits tab use those names too.
- Collapsed shows one line per provider: the window `collapsed.window` picks for it, else the one it picks for all providers (**For all providers** on the Collapsed page), else the row with the least left. A provider without the picked window shows the row with the least left.
- Status line shows under the message box when no sidebar panel with quota is on screen: the window is too narrow for the sidebar, the sidebar is closed, or `sidebar.show` is off. `statusLine.withSidebar: true` shows it next to the sidebar too. While its Layout page is open, it shows whenever `statusLine.show` is on. It uses the room OpenCode's footer leaves free. `statusLine.window` picks its own windows the same way. The `‹ ›` window pickers on each page change only that page's setting. Scroll with the mouse wheel or click `‹` and `+N ›` when providers do not fit.
- Toasts appear after compaction, when every provider fails, and after a reply once a limit is getting low (below `colors.warningBelow`, 50% left by default), for 9 seconds by default. `toast.layout` (Layout on the Toast page) picks their look. `grouped`, the default, has a line per provider with its error, then a line per row: its window or name, then its bar (up to 20 cells; none when not even 3 fit), percent and reset time. `detailed`, the 5.x look, has an empty line between providers, the error under the provider's name, and two lines per row with a percent: its window or name and reset time, then a bar as wide as the toast and the percent. Rows have no bar with `layout.bar: "none"`. `toast.names` holds their row names; a row you renamed shows your name in both layouts. Renaming a row on Sidebar or Toast changes that page's names only. Quota toasts use the sidebar's colors (`colors`). Toasts appear only in the TUI.

`/quota`, `/quota_usage`, `/quota_status` and `/quota_settings` open the quota window on Limits, Usage, Plugin and the first Settings tab. The 4.x and 5.x `/tokens_*` commands are other names for `/quota_usage` ranges until `system.oldCommands` is off; see [Updating](updating.md#moving-from-5x).

On Providers, every provider is ticked unless its id is in `providers.off`. A ticked provider that quota can't use yet, for example without a login, shows "not set up". Space or a click ticks or unticks a provider. A provider found later is checked automatically unless it is unticked. Ticked Cursor and OpenCode Zen show their own lines under them: Cursor's plan (Pro includes $20 of API use a month, Pro Plus $70, Ultra $400), an included API budget to use instead of the plan's, and the day its bill renews; Zen's monthly budget, to use instead of the Console's.

## Custom providers

A custom provider connects OpenCode Quota to a provider that is not built in, or tunes a maintained local estimate. Ask your agent to add a custom provider: [Custom providers](providers.md#custom-providers) has a copy-paste prompt.

To edit it yourself, add the definition to `providers.custom` in `settings.jsonc`. `/quota_status` (or the `quota_status` tool) checks it with the same validator the plugin uses.

Rules:

- `providers.custom` keeps file order.
- `id` is the stable identity. Add `providerId` only when it differs.
- `modelIds` only limits `words.onlyCurrentModel` and which requests a local estimate counts. Use exact, case-sensitive model IDs without the outer provider prefix, or omit it to cover every model for that provider.
- Remote APIs use a fixed authenticated `GET`. Formats: `quota-v1`, `json-v1`, and `openrouter-key-v1`. `json-v1` needs an `adapter` with 1–16 mappings; paths are literal own-property segment arrays, not JSONPath. See [response rules](providers.md#custom-providers).
- Local estimates support 1–16 UTC-day or rolling request windows. Each check counts the completed requests in OpenCode's own messages; nothing else is stored.
- Automatic matching (models.dev, and Cursor's own prices for Auto, Composer and Grok) runs first. Add `pricingModelMap` only when it finds no price. `pricingModelMap` cannot override a successful automatic match.
- If any request cannot be priced, request counts stay visible and the budget percentage is reported unavailable.
- Credentials resolve from `apiKeyEnv`, `provider.<providerId>.options.apiKey` in the [OpenCode config files](troubleshooting.md#opencode-config-files), then API-key logins saved in OpenCode 2 (`opencode.db`).
- `"enabled": false` switches a definition off: it is never fetched, its key is never sent, and `/quota_status` shows it as off. Without `enabled` (or with `true`) it is on. Providers an agent adds start switched off; switch one on by setting `"enabled": true` in `opencode-quota/settings.jsonc`, or in `/quota_settings` → **Providers**, which shows each custom provider's web address and the key it sends (and warns about plain `http`) next to its switch.
- Definitions run when `custom` is absent from `providers.off`. Adding `custom` there skips every custom definition. Each definition also has its own `enabled` switch.
- To tune maintained estimates, use the reserved `alibaba-coding-plan` ID and its window shape. Do not add a duplicate normal provider block.
- Not accepted: scripts, methods, custom headers, templates, executable mappings, regular expressions, JSONPath, and automatic endpoint discovery.
- A custom model provider still needs its normal OpenCode `provider` block in `opencode.json`: that block tells OpenCode how to use the model, and `providers.custom` tells OpenCode Quota how to measure it.
- `/quota_status` shows each definition as `custom 1`, `custom 2`, … with its mode, model count, check outcome and credential source, never its id, URLs, keys, headers, response bodies, or raw errors.

<details>
<summary><strong>Complete example</strong></summary>

`settings.jsonc`:

```jsonc
{
  "providers": {
    "off": [],
    "custom": [
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
}
```

The global `opencode.json` keeps the normal OpenCode `provider` block:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "private-gateway": {
      "models": { "model-a": {} },
    },
  },
}
```

</details>

## All settings

Credentials belong in OpenCode or environment variables, never in this file. See [API keys](providers.md#api-keys).

<details>
<summary>Settings by section</summary>

### Sidebar, Collapsed, Status line and Toast

Each section has `show: true`, `runsOut` (`true` for `sidebar` and `toast`, `false` for `collapsed` and `statusLine`), `hidden: []`, `providerOrder: []`, and `rowOrder: {}`. `hidden` lists provider or row ids. `providerOrder` lists provider ids; `rowOrder` maps a provider id to a list of row ids. Unlisted ids follow their normal order.

| Setting | Default | Values |
| --- | --- | --- |
| `sidebar.sessionTokens`, `toast.sessionTokens` | `true` | Show the session tokens line. |
| `sidebar.names`, `toast.names` | `{}` | Row ids mapped to names. |
| `collapsed.window`, `statusLine.window` | `{}` | Provider ids, and `"*"` for all providers, mapped to `lowest`, `rpm`, `hour`, `five_hour`, `session`, `day`, `week`, `month`, `year`, `mcp`, or `code_review`. A provider's own entry wins over `"*"`. Missing means lowest left. |
| `statusLine.withSidebar` | `false` | Also show the status line while a sidebar panel shows quota. |
| `statusLine.detail` | `"auto"` | `auto`, `one`, `full`, `bar`, `reset`, `numbers`. |
| `statusLine.width` | `0` | Whole number 0–1000. 0 uses all free room. |
| `statusLine.autoScrollSeconds` | `0` | Whole number 0–600. 0 switches scrolling off. |
| `statusLine.home` | `false` | Show the status line at the bottom of Home. |
| `toast.afterReply` | `"low"` | `off`, `always`, or `low` (only while a shown limit is getting low). |
| `toast.afterQuestion` | `false` | Show quota after a question. |
| `toast.afterCompaction` | `true` | Show quota after compaction. |
| `toast.whenAllFail` | `true` | Show quota when every provider fails. |
| `toast.resetNotice` | `"off"` | `off`, `weekly`, or `all`. |
| `toast.layout` | `"grouped"` | `grouped` (a line per row under its provider) or `detailed` (two lines per row, the 5.x look). |
| `toast.seconds` | `9` | Whole number 1–120. |

### Colors

Roles are `good`, `warning`, `low`, `empty`, `title`, `provider`, `account`, `label`, `percent`, `reset`, `value`, `error`, `statusName`, `separator`, and `arrows`. Each `colors.<role>` follows the theme when unset. Set a role to `text`, `muted`, `accent`, `green`, `yellow`, `red`, `blue`, `bar`, or a `#rrggbb` color. `bar` follows the row's level color. The Colors tab's **Color preset** sets every role at once: `theme colors` unsets them all; `grey` sets `good`, `warning`, `provider`, `label` and `arrows` to `muted` and unsets the rest, so the panel title keeps the theme's text color, the rest is grey, and only almost-out limits and errors are red.

| Setting | Default | Values |
| --- | --- | --- |
| `colors.warningBelow` | `50` | Whole number 0–100, percent left below which quota is getting low. |
| `colors.lowBelow` | `20` | Whole number 0–100, percent left below which quota is almost out. |

### Layout

| Setting | Default | Values |
| --- | --- | --- |
| `layout.bar` | `"blocks"` | `blocks`, `shades`, `line`, `squares`, `dots`, `none`. Every place and the Limits tab use it; with `none`, Limits keeps a thin line for its pace mark. |
| `layout.barWidth` | `"fill"` | `fill` takes the room the other columns leave, at most 20 cells on the sidebar and 10 on the collapsed panel; or a whole number 1–30. |
| `layout.evenUse` | `true` | `true` puts the Limits tab's `┃` mark in the bars of the sidebar, collapsed panel, status line and toasts, where even use would be: the percent left if the limit were used evenly until it resets; `false` leaves it out. Only rows with a reset time and a known window length; no mark in bars under 3 cells. **Even-use mark** on All places. |
| `layout.indent` | `1` | Whole number 0–4. |
| `layout.labelWidth` | `8` | Whole number 3–20: the most columns a row name takes. The name column fits the longest name next to a bar. |
| `layout.providerGap` | `1` | Whole number 0–2. |
| `layout.separator` | `" · "` | Up to 5 characters. |

### Words

| Setting | Default | Values |
| --- | --- | --- |
| `words.percent` | `"left"` | `left`, `remaining`, `bare`, `used`. |
| `words.reset` | `"smart"` | `smart` gives `4.5d` from a day, `23h` from 12 hours, `2h 14m` below, each rounded to the nearest; `exact` gives `2h 14m`, `compact` gives `2h14m`, `short` gives `2h`, `decimal` gives `2.2h`. The Limits tab always shows exact times. |
| `words.resetDecimals` | `1` | Whole number 0–4. |
| `words.rowNames` | `"short"` | `short` shows a row's window (`5h`, `7d`, `30d`) unless it has none or shares it with another row of the provider; `full` shows its name (`Weekly`). |
| `words.detail` | `"summary"` | `detailed` includes supplementary rows. |
| `words.onlyCurrentModel` | `false` | Show providers serving the current model. |
| `words.sessionTokens` | `"current"` | `current` counts this chat; `tree` adds its subagent sessions, each counted once, as the Usage tab's `session` range does. The line counts like the Usage tab: "in" is new input plus cache writes, "out" is output plus reasoning, compactions that recorded tokens count, and a fork's copies of its parent's messages do not. |

In the TUI, they are on **Layout → All places**, since every place follows them.

### Providers

| Setting | Default | Values |
| --- | --- | --- |
| `providers.off` | `[]` | Provider ids switched off. `custom` means every custom definition. |
| `providers.custom` | `[]` | Custom provider definitions, file only. |
| `providers.anthropic.binaryPath` | `"claude"` | CLI command or absolute or `~/` path without `..`, file only. |
| `providers.cursor.plan` | `"none"` | `none`, `pro` ($20 of API use a month), `pro-plus` ($70), `ultra` ($400). With one, Cursor can show a %. |
| `providers.cursor.includedApiUsd` | `null` | Positive monthly USD amount, used instead of the plan's. |
| `providers.cursor.billingCycleStartDay` | `null` | The day of the month your Cursor bill renews, 1–28. Unset uses the calendar month. |
| `providers.opencode.monthlyLimitUsd` | `null` | Positive monthly USD amount, used instead of the Console's budget or credit limit. |
| `providers.checking.minIntervalMs` | `300000` | Positive milliseconds between provider checks. |
| `providers.checking.requestTimeoutMs` | unset | Positive request timeout in milliseconds, for every provider. Unset, each provider uses its own: `5000`, except OpenCode Zen and Xiaomi MiMo `10000`, the Alibaba Token Plan `10000` for the local CLI it runs, and Google AGY and Gemini CLI `8000` to sign in and `6000` for the quota. So a set `8000` shortens Zen, MiMo and the Alibaba plan. xAI's plan-label lookup waits at most `2000`, also when this is higher. |
| `providers.checking.waitForQuotaReset` | `true` | On a model limit error, wait until 1 minute after the earliest exhausted window resets, at most 5 hours. `false` keeps normal retry timing. |
| `providers.pricing.source` | `"auto"` | `auto`, `bundled`, `runtime`. |
| `providers.pricing.autoRefreshDays` | `7` | Whole number of days, at least 1. |

### System

Maintainer notices are written into the plugin with an end date. Active notices show on the Plugin tab (`/quota_status`) and at the end of `/quota` text on Web and Desktop. Their count shows on the first Home screen of each local day for 10 minutes, only when a notice is active.

| Setting | Default | Values |
| --- | --- | --- |
| `system.exportFile` | `false` | Write quota JSON when the snapshot changes. |
| `system.exportPath` | `""` | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`; otherwise an absolute or `~/` path without `..`. File only. |
| `system.telemetry` | `false` | Publish quota and cache-age metrics through OpenCode's global OpenTelemetry MeterProvider. |
| `system.oldCommands` | `true` | List the 4.x and 5.x `/tokens_*` commands, each `/quota_usage` on its range. |

See [External integration](external-integration.md) for JSON and telemetry details.

</details>
