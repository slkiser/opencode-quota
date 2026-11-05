[← Back to README](../../README.md)

# Configuration

Most people need no settings. To change one, open `/quota_settings` in the TUI: every setting is a line there, with its values. In OpenCode Desktop (`2.2.0+`, experimental), the Quota page in OpenCode's settings edits the same file.

## Where settings live

One global file, `settings.jsonc`:

- `~/.config/opencode/opencode-quota/settings.jsonc` on every OS (`$XDG_CONFIG_HOME/opencode/...` when `XDG_CONFIG_HOME` is set)
- `$OPENCODE_CONFIG_DIR/opencode-quota/settings.jsonc` when `OPENCODE_CONFIG_DIR` is set (it replaces the global folder, like OpenCode 2)

There are no project settings. Comments and trailing commas are allowed. Every key is optional; a missing or invalid value uses its default. `/quota_status` shows the file it reads and any problems in it.

The file holds only the settings you change, so the rest follow their defaults, also when a newer version changes one. Without the file nothing is written; the first Save, Plugin tab switch or agent change creates it. Settings from 4.x or 5.x convert on the first start: see [Updating](updating.md#moving-from-5x).

The TUI quota window's tabs are Usage, Limits, Plugin, then the Settings tabs **Layout** (**All places**, then a page each for Sidebar, Collapsed, Status line and Toast), **Colors** and **Providers**. `/quota_usage`, `/quota`, `/quota_status` and `/quota_settings` open it on Usage, Limits, Plugin and Layout. While you edit, the sidebar, status line, toasts and quota window show your unsaved changes. **Save** writes them and keeps the file's comments, **Discard** drops them, and **Reset page** (**Reset tab** on Colors and Providers) puts that page back to its defaults on Save, except row names. The **Plugin** tab (`/quota_status`) has the **Old command names**, **Quota file (JSON)** and **OpenTelemetry metrics** switches, which save as soon as you change them. A file edit or a Save reaches every open TUI within a few seconds.

Three settings are file only: `providers.custom` ([custom providers](providers.md#custom-providers)), `providers.anthropic.binaryPath` and `system.exportPath`. Credentials never go in this file: see [API keys](providers.md#api-keys).

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

## TUI surfaces

- **Sidebar:** the `Quota` panel in a session's sidebar. Click its title to collapse it to one line per provider (**Collapsed**).
- **Status line:** under the message box when no sidebar panel with quota is on screen. **Next to the sidebar** on its page shows it there too.
- **Toasts:** after compaction, when every provider fails, and after a reply once a shown limit is getting low.

OpenCode Desktop (`2.2.0+`, experimental) shows the same settings in its own places: `sidebar` in a pinned Quota side tab, `collapsed` in a titlebar pill (and in the Quota side tab when folded), `statusLine` in a strip at the bottom of the window and a pill above the message box (the strip also shows while the Quota tab does; `statusLine.withSidePanel: false` hides it then; `statusLine.composerPill: false` hides only the pill), and `toast` in its toasts, with the Quota side tab's rows and bars (`toast.layout` doesn't apply there; a reset notice is a sentence). Web has none of these; there `/quota`, `/quota_usage` and `/quota_status` post a report in the chat.

## All settings

<details>
<summary>Settings by section</summary>

### Sidebar, Collapsed, Status line and Toast

Each section has `show: true`, `runsOut` (`true` for `sidebar` and `toast`, `false` for `collapsed` and `statusLine`), `hidden: []`, `providerOrder: []`, and `rowOrder: {}`. `hidden` lists provider or row ids. `providerOrder` lists provider ids; `rowOrder` maps a provider id to a list of row ids. Unlisted ids follow their normal order.

| Setting | Default | Values |
| --- | --- | --- |
| `sidebar.sessionTokens`, `toast.sessionTokens` | `true` | Show the session tokens line. |
| `sidebar.names`, `toast.names` | `{}` | Row ids mapped to names. The collapsed sidebar, status line and Limits tab use the sidebar's. |
| `collapsed.window`, `statusLine.window` | `{}` | Provider ids, and `"*"` for all providers, mapped to `lowest`, `rpm`, `hour`, `five_hour`, `session`, `day`, `week`, `month`, `year`, `mcp`, or `code_review`. A provider's own entry wins over `"*"`. Missing means lowest left. |
| `statusLine.withSidebar` | `false` | The terminal's: also show the status line while a sidebar panel shows quota. |
| `statusLine.withSidePanel` | `true` | Desktop's: also show the bottom strip while the Quota tab shows in the side panel. `false` hides it then. |
| `statusLine.composerPill` | `true` | Desktop's: show the pill above the message box. `false` hides only the pill; the bottom strip stays. |
| `statusLine.detail` | `"auto"` | `auto`, `one`, `full`, `bar`, `reset`, `numbers`. |
| `statusLine.width` | `0` | Whole number 0–1000. 0 uses all free room. |
| `statusLine.autoScrollSeconds` | `0` | Whole number 0–600. 0 switches scrolling off. |
| `statusLine.home` | `false` | Show the status line at the bottom of Home. |
| `toast.afterReply` | `"low"` | `off`, `always`, or `low` (only while a shown limit is below `colors.warningBelow`). |
| `toast.afterQuestion` | `false` | Show quota after a question. |
| `toast.afterCompaction` | `true` | Show quota after compaction. |
| `toast.whenAllFail` | `true` | Show quota when every provider fails. |
| `toast.resetNotice` | `"off"` | `off`, `weekly`, or `all`. |
| `toast.layout` | `"grouped"` | `grouped` (a line per row under its provider) or `detailed` (two lines per row, the 5.x look). |
| `toast.seconds` | `9` | Whole number 1–120. |

### Colors

Roles are `good`, `warning`, `low`, `empty`, `title`, `provider`, `account`, `label`, `percent`, `reset`, `value`, `error`, `statusName`, `separator`, and `arrows`. Each `colors.<role>` follows the theme when unset. Set a role to `text`, `muted`, `accent`, `green`, `yellow`, `red`, `blue`, `bar`, or a `#rrggbb` color. `bar` follows the row's level color: by the share left against `colors.warningBelow` and `colors.lowBelow`, or by pace with `colors.levelBy: "pace"`.

| Setting | Default | Values |
| --- | --- | --- |
| `colors.levelBy` | `"left"` | `left` or `pace`. With `pace`, the level colors follow how fast a limit is used against even use until its reset: `good` at or under even use (an untouched limit included), `warning` up to 5 points faster than even use, `low` faster than that. Before a tenth of the window has passed, a fast pace says too little, so the row follows the share left, and a nearly used-up limit is still `low`. A row without a reset time or a known window length follows the share left. Whether a toast shows after a reply (`toast.afterReply: "low"`) still goes by the share left. **Bar colors follow** on the Colors tab. |
| `colors.warningBelow` | `50` | Whole number 0–100, percent left below which quota is getting low. |
| `colors.lowBelow` | `20` | Whole number 0–100, percent left below which quota is almost out. |

### Layout

| Setting | Default | Values |
| --- | --- | --- |
| `layout.bar` | `"line"` | `blocks`, `shades`, `line`, `squares`, `dots`, `none`. `none` hides meters on other quota surfaces; Limits intentionally keeps a thin line. |
| `layout.barWidth` | `"fill"` | `fill` uses the room the other values leave (up to 20 cells on the expanded sidebar, toasts and Limits; 10 on the collapsed sidebar and Home's one-provider line; 5 on the session status line); or a whole number 1–30, clamped to the available room. |
| `layout.evenUse` | `true` | `┃` marks how much quota should remain now if consumed evenly from the window start through reset; with `words.percent: "left"`, the colored fill shows actual quota remaining. The mark follows text color, not quota health, and may be absent when percent or usable timing is unavailable (including month/year windows without a known start). **Even-use mark** on Layout's All places page. |
| `layout.indent` | `1` | Whole number 0–4. |
| `layout.labelWidth` | `8` | Whole number 3–20: the most columns a row name takes. |
| `layout.providerGap` | `1` | Whole number 0–2. |
| `layout.separator` | `" · "` | Up to 5 characters. |

#### TUI bar examples

`layout.bar` changes the glyphs, and `layout.barWidth` changes the number of cells. **Bar shape** on Layout → All places previews each choice; the examples below use 20 cells, `words.percent: "left"`, `colors.levelBy: "left"`, and the default thresholds (`warningBelow: 50`, `lowBelow: 20`). The filled part follows the row's level and the rest uses `empty`:

| Percent left | 20-cell row sample | Default theme roles | Example custom roles |
| --- | --- | --- | --- |
| 60% | `5h ━━━━━━━━━━━━────────  60% left` | `good` (theme green) + `empty` (theme muted) | `good: blue` + `empty: muted` |
| 40% | `5h ━━━━━━━━────────────  40% left` | `warning` (theme yellow) + `empty` (theme muted) | `warning: accent` + `empty: muted` |
| 10% | `5h ━━──────────────────  10% left` | `low` (theme red) + `empty` (theme muted) | `low: red` + `empty: muted` |

The role names describe the active OpenCode theme colors; they are not fixed RGB values. The example overrides use only existing color choices:

```jsonc
"colors": { "good": "blue", "warning": "accent", "low": "red", "empty": "muted" }
```

At 60% left, the other supported shapes keep the same 12-of-20 fill; `squares` and `dots` remain available:

```text
line (default)  ━━━━━━━━━━━━────────
blocks          ████████████░░░░░░░░
shades          ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░
squares         ■■■■■■■■■■■■□□□□□□□□
dots            ●●●●●●●●●●●●○○○○○○○○
none            (no meter; the percent remains)
```

With **Even-use mark** on, halfway through a 5-hour window the even-use target is 50% remaining. If actual quota remaining is 60%, a 20-cell meter fills 12 cells and shows `━━━━━━━━━━┃━────────`: `┃` replaces the boundary cell at the target, so it is not an extra cell. Fill to the right of the mark means more quota remains than target; fill to the left means less. The mark follows text color, not quota health. It may be absent when percent or timing is unavailable, including some month/year windows without a known start. With `words.percent: "used"`, the bar and mark turn around to follow the displayed percentage. When bars are set to `none`, other quota surfaces omit the meter, while Limits intentionally substitutes a thin line. Usage charts remain analytics and do not use these quota-meter settings.

### Words

Every place follows these, so in the TUI they are on **Layout → All places**. JSON output never changes with them.

| Setting | Default | Values |
| --- | --- | --- |
| `words.percent` | `"left"` | `left`, `remaining`, `bare`, `used`. Bars and the even-use mark follow it, so `used` fills the bar by the share used. The expanded sidebar panel says the word in its title ("▼ Quota used") and its rows stay bare ("42%"); every other place writes "42% used". Colors and warning levels stay on the share left. |
| `words.reset` | `"smart"` | `smart`, `exact`, `compact`, `short`, `decimal`, or `percent`: the share of the window's time left (used, with `words.percent` `used`), then the time in its largest unit (`0%/91% 28d`); only the time when the window's start is unknown. |
| `words.resetDecimals` | `1` | Whole number 0–4. |
| `words.rowNames` | `"short"` | `short` (`5h`, `7d`) or `full` (`Weekly`), on the sidebar, collapsed panel, status line and toasts. |
| `words.detail` | `"summary"` | `detailed` includes supplementary rows. |
| `words.onlyCurrentModel` | `false` | Show only providers serving the current model. |
| `words.sessionTokens` | `"current"` | `current` counts this chat; `tree` adds its subagent sessions. |

### Providers

| Setting | Default | Values |
| --- | --- | --- |
| `providers.off` | `[]` | Provider ids switched off. `custom` means every custom definition. |
| `providers.custom` | `[]` | [Custom provider](providers.md#custom-providers) definitions, file only. |
| `providers.anthropic.binaryPath` | `"claude"` | CLI command or absolute or `~/` path without `..`, file only. |
| `providers.cursor.plan` | `"none"` | `none`, `pro` ($20 of API use a month), `pro-plus` ($70), `ultra` ($400). |
| `providers.cursor.includedApiUsd` | `null` | Positive monthly USD amount, used instead of the plan's. |
| `providers.cursor.billingCycleStartDay` | `null` | The day of the month your Cursor bill renews, 1–28. Unset uses the calendar month. |
| `providers.opencode.monthlyLimitUsd` | `null` | Positive monthly USD amount, used instead of the Console's budget or credit limit. |
| `providers.checking.minIntervalMs` | `300000` | Positive milliseconds between provider checks. |
| `providers.checking.requestTimeoutMs` | unset | Positive milliseconds, for every provider. Unset, each uses its own: `5000`, except OpenCode Zen and Xiaomi MiMo `10000`, the Alibaba Coding Plan and Token Plan `10000` for the local CLI they run, and Google AGY and Gemini CLI `8000` to sign in and `6000` for the quota. xAI's plan-label lookup waits at most `2000`. |
| `providers.checking.waitForQuotaReset` | `true` | On a model limit error, wait until 1 minute after the earliest used-up window resets, at most 5 hours. `false` keeps normal retry timing. |
| `providers.pricing.source` | `"auto"` | `auto`, `bundled`, `runtime`. |
| `providers.pricing.autoRefreshDays` | `7` | Whole number of days, at least 1. |

### System

| Setting | Default | Values |
| --- | --- | --- |
| `system.exportFile` | `false` | Write quota JSON when the snapshot changes. See [External integration](external-integration.md). |
| `system.exportPath` | `""` | Empty uses `$XDG_CACHE_HOME/opencode/quota-export.json`; otherwise an absolute or `~/` path without `..`. File only. |
| `system.telemetry` | `false` | Publish quota and cache-age metrics through OpenCode's global OpenTelemetry MeterProvider. |
| `system.oldCommands` | `true` | List the 4.x and 5.x `/tokens_*` commands, each `/quota_usage` on its range. |

</details>
