/** File-backed settings for the TUI and its Settings lines. */
import type { Words } from "../core/types.js";
import {
  type CursorQuotaPlan,
  getCursorPlanDisplayName,
  getEffectiveCursorIncludedApiUsd,
} from "../lib/cursor-pricing.js";
import { isRecord } from "../lib/json-guards.js";
import {
  checkSetting,
  defaultSettings,
  diffSettings,
  keysUnder,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings,
  setPath,
  THEME_COLOR_NAMES,
} from "../settings/schema.js";
import {
  type BarShape,
  barParts,
  DEFAULT_WORDS,
  formatDuration,
  percentText,
} from "../view/format.js";
import {
  type FieldValue,
  PRESET_CHOICES,
  type PresetName,
  presetChoice,
  presetValues,
} from "../view/presets.js";
import type { Surface } from "../view/select.js";
import { renameRow, setIn, stepIn } from "../view/settings-edit.js";
import type { ColorRole } from "../view/text.js";

/** Named colors follow OpenCode's theme; hex colors stay fixed; bar follows the row's level. */
export type ColorChoice = NonNullable<Settings["colors"]["good"]>;
export type ColorName = Exclude<ColorChoice, "bar" | `#${string}`>;
export const COLOR_NAMES = THEME_COLOR_NAMES.filter((name): name is ColorName => name !== "bar");
type StatusDetail = Settings["statusLine"]["detail"];

export { type FieldValue, type PresetName, presetChoice, presetValues, renameRow, setIn, stepIn };

/** The settings the TUI shows: the saved ones, with the Settings tabs' draft on top. */
export type DisplaySettings = Settings;

/** Every colored thing: its Colors line (and group) and the theme color it gets by default. */
const COLOR_LINES: ReadonlyArray<{
  role: ColorRole;
  title: string;
  theme: ColorName | "bar";
  group?: string;
}> = [
  { role: "good", title: "Plenty left", theme: "green", group: "Bars" },
  { role: "warning", title: "Getting low", theme: "yellow" },
  { role: "low", title: "Almost out", theme: "red" },
  { role: "empty", title: "Used part of a bar", theme: "muted" },
  { role: "title", title: "Panel title", theme: "text", group: "Names" },
  { role: "provider", title: "Provider names", theme: "text" },
  { role: "account", title: "Accounts (Pro, …)", theme: "muted" },
  { role: "label", title: "Row labels", theme: "text" },
  { role: "percent", title: "Percent numbers", theme: "bar", group: "Numbers and times" },
  { role: "reset", title: "Reset times", theme: "muted" },
  { role: "value", title: "Balances, other text", theme: "muted" },
  { role: "error", title: "Errors", theme: "red" },
  { role: "statusName", title: "Provider names", theme: "muted", group: "Status line" },
  { role: "separator", title: "Separators", theme: "muted" },
  { role: "arrows", title: "‹ +N › arrows", theme: "accent" },
];

/** The theme color each role gets unless you change it. */
export const THEME_COLORS = Object.fromEntries(
  COLOR_LINES.map(({ role, theme }) => [role, theme]),
) as Record<ColorRole, ColorName | "bar">;
const SURFACES: readonly Surface[] = ["sidebar", "collapsed", "statusLine", "toast"];

/** The value at a field's path, for example "layout.barWidth". */
export function valueAt(settings: unknown, path: string): FieldValue {
  let value = settings;
  for (const key of path.split(".")) value = isRecord(value) ? value[key] : undefined;
  return value as FieldValue;
}

export function defaultDisplaySettings(): DisplaySettings {
  return defaultSettings();
}

// ---------------------------------------------------------------------------------------------
// The Settings pages: one line per setting, every page from this table.

/**
 * The quota window's Settings pages. The tab bar shows Layout (the pages layout as "All places",
 * which also holds the `words` lines, then sidebar, collapsed, statusLine and toast), Colors and
 * Providers.
 */
export type SettingsTab =
  | "sidebar"
  | "collapsed"
  | "statusLine"
  | "toast"
  | "colors"
  | "layout"
  | "providers";

export function isSurfaceTab(tab: SettingsTab): tab is Surface {
  return SURFACES.includes(tab as Surface);
}

/**
 * One setting line: ‹ › step through `values`; a color line also takes a typed "#rrggbb", a
 * line with a `placeholder` a typed number. Its `path` ("layout.barWidth") is also its id; its
 * default and the values it accepts are the setting's in SETTINGS_SCHEMA.
 */
export type Field = {
  path: keyof typeof SETTINGS_SCHEMA;
  tab: SettingsTab;
  title: string;
  values: readonly FieldValue[];
  show: (value: FieldValue) => string;
  /** The values ‹ › step through when some of `values` don't fit the other settings. */
  choices?: (settings: DisplaySettings) => readonly FieldValue[];
  /** A heading above the line, which starts a group. */
  group?: string;
  /** Short muted text after the value. */
  note?: string;
  /** The preset on top of the tab sets this line. */
  preset?: PresetName;
  color?: true;
  /** A number you type ("a dollar amount"); nothing typed is null. */
  placeholder?: string;
  /** On the Providers tab: nested under this provider's tick, while it is ticked. */
  provider?: string;
};

type Show = (value: FieldValue) => string;
type FieldOptions = Partial<Omit<Field, "path" | "title" | "show">>;

/**
 * A setting line on the page of its first key ("toast" in "toast.seconds") unless it names one.
 * A choice steps through its values and a switch through off and on; a number, a color or a
 * separator names the `values` it steps through, or none when you type it.
 */
function field(path: Field["path"], title: string, show: Show, options: FieldOptions = {}): Field {
  const rule: SettingRule = SETTINGS_SCHEMA[path];
  const values =
    rule.kind === "choice" ? rule.values : rule.kind === "boolean" ? [false, true] : [];
  const tab = path.split(".")[0] as SettingsTab;
  return { path, tab, title, values, show, ...options };
}

const onOff = (off: string, on: string) => (value: FieldValue) => (value ? on : off);

/** One switch per place: the Limits tab always shows the pace. */
function runsOutField(surface: Surface, where: string, options: FieldOptions = {}): Field {
  const note = "when a limit, used at your pace so far, runs out before its reset";
  return field(`${surface}.runsOut`, "Runs out in …", onOff("off", where), { note, ...options });
}

function colorTitle(choice: FieldValue): string {
  return choice === "bar" ? "bar color" : String(choice);
}

/** A color line; undefined follows the theme. The bar colors themselves can't follow the bar. */
function colorField({ role, title, theme, group }: (typeof COLOR_LINES)[number]): Field {
  const isLevel = role === "good" || role === "warning" || role === "low";
  const values = [undefined, ...COLOR_NAMES, ...(isLevel ? [] : ["bar"])];
  const show = (value: FieldValue) =>
    value === undefined ? `${colorTitle(theme)} (theme)` : colorTitle(value);
  return field(`colors.${role}`, title, show, { group, values, color: true });
}

const COLOR_FIELDS = COLOR_LINES.map(colorField);
const THRESHOLDS = [10, 15, 20, 25, 30, 40, 50, 60];
const STATUS_DETAILS: Record<StatusDetail, string> = {
  auto: "as much as fits",
  one: "one provider, big bar",
  full: "bar, % and reset",
  bar: "bar and %",
  reset: "% and reset",
  numbers: "% only",
};
const TOAST = { preset: "toast" } as const;
const LAYOUT = { preset: "layout" } as const;
/** The `words` lines, which every place follows: on All places. */
const ALL_PLACES = { tab: "layout" } as const;
const unit = (word: string) => (value: FieldValue) => `${value} ${word}`;
const percentLeft = unit("% left");
const RESET_NOTICES: Record<string, string> = { weekly: "weekly limits", all: "every limit" };
const MINUTE_MS = 60_000;
/** A reset 2h 14m away and one 5d 3h 20m away, as each reset style writes them. */
const RESET_EXAMPLES_MS = [134 * MINUTE_MS, 7_400 * MINUTE_MS];
const named = (names: Record<string, string>) => (value: FieldValue) =>
  names[String(value)] ?? String(value);
const usd = (unset: string) => (value: FieldValue) =>
  typeof value === "number" ? `$${value} a month` : unset;
const CURSOR = { provider: "cursor" } as const;
/** A Cursor plan with the API use it includes, e.g. "Pro: $20 a month". */
const cursorPlan = (value: FieldValue) => {
  const plan = value as CursorQuotaPlan;
  const includedUsd = getEffectiveCursorIncludedApiUsd({ plan });
  return includedUsd === undefined
    ? "not set"
    : `${getCursorPlanDisplayName(plan)}: $${includedUsd} a month`;
};
const SHOW = {
  onOff: onOff("off", "on"),
  tokensLine: onOff("hidden", "shown"),
  detail: (value) => STATUS_DETAILS[value as StatusDetail],
  width: (value) => (value ? `up to ${value} columns` : "all the free room"),
  scroll: (value) => (value ? `every ${value} s` : "off"),
  afterReply: (value) => (value === "low" ? "only when getting low" : String(value)),
  resetNotice: (value) => RESET_NOTICES[String(value)] ?? "off",
  bar: (value) =>
    value === "none" ? "no bars" : `${barParts(value as BarShape, 60, 5).join("")} ${value}`,
  barWidth: (value) => (value === "fill" ? "fill the room" : `${value} columns`),
  indent: (value) => (value === 1 ? "1 space" : `${value} spaces`),
  gap: (value) => (value === 1 ? "1 empty line" : value ? `${value} empty lines` : "nothing"),
  separator: (value) => (String(value).trim() ? `"${String(value).trim()}"` : "spaces"),
  percent: (value) =>
    percentText({ ...DEFAULT_WORDS, percent: value as Words["percent"] }, 58, true),
  reset: (value) =>
    RESET_EXAMPLES_MS.map((ms) => formatDuration(ms, value as Words["reset"], 1)).join(" · "),
  decimals: (value) =>
    `${value} (${formatDuration(RESET_EXAMPLES_MS[0] as number, "decimal", Number(value))})`,
  minutes: (value) => `every ${Number(value) / MINUTE_MS} min`,
  timeout: (value) => (value === null ? "each provider's own" : `after ${Number(value) / 1_000} s`),
  days: (value) => (value === 1 ? "every day" : `every ${value} days`),
  day: (value) => (typeof value === "number" ? `day ${value}` : "calendar month"),
  rows: named({ summary: "main rows only", detailed: "all rows" }),
  rowNames: named({ short: "5h, 7d, 30d", full: "Weekly, Daily, …" }),
  toastLayout: named({ grouped: "Grouped", detailed: "Detailed" }),
  models: named({ false: "all", true: "current model's only" }),
  tokens: named({ current: "this session", tree: "with subagents" }),
  limitHit: named({ false: "retry like normal", true: "wait for the reset" }),
  levelBy: named({ left: "the share left", pace: "your pace" }),
} satisfies Record<string, Show>;
// "Getting low" stays at or above "almost out", so ‹ › skip the values that would break that.
const warningChoices = (settings: DisplaySettings) =>
  THRESHOLDS.filter((value) => value >= settings.colors.lowBelow);
const lowChoices = (settings: DisplaySettings) =>
  THRESHOLDS.filter((value) => value <= settings.colors.warningBelow);

/** Every plain setting, in the order its tab shows it. */
export const FIELDS: readonly Field[] = [
  field("sidebar.sessionTokens", "Session tokens line", SHOW.tokensLine, {
    group: "What it shows",
  }),
  runsOutField("sidebar", "under the row"),
  runsOutField("collapsed", "under the provider", { group: "What it shows" }),
  field("statusLine.withSidebar", "Next to the sidebar", onOff("hide the line", "show it too"), {
    group: "When it shows",
  }),
  field("statusLine.home", "At the bottom of Home", SHOW.onOff, {
    note: "even when the line under the message box is off",
  }),
  field("statusLine.detail", "Show", SHOW.detail, { group: "What it shows" }),
  runsOutField("statusLine", "after the provider"),
  field("statusLine.width", "Width", SHOW.width, {
    group: "Width and scrolling",
    values: [0, 40, 60, 80],
  }),
  field("statusLine.autoScrollSeconds", "Scroll by itself", SHOW.scroll, { values: [0, 5, 10] }),
  field("toast.afterReply", "After each reply", SHOW.afterReply, {
    group: "When it shows",
    ...TOAST,
  }),
  field("toast.afterQuestion", "After a question to you", SHOW.onOff, TOAST),
  field("toast.afterCompaction", "After compaction", SHOW.onOff, TOAST),
  field("toast.whenAllFail", "When every provider fails", SHOW.onOff, TOAST),
  field("toast.resetNotice", "When a limit resets", SHOW.resetNotice, TOAST),
  field("toast.layout", "Layout", SHOW.toastLayout, { group: "Look" }),
  field("toast.seconds", "Stays on screen", unit("s"), { values: [5, 9, 15, 30] }),
  field("toast.sessionTokens", "Session tokens line", SHOW.tokensLine),
  runsOutField("toast", "after the row"),
  ...COLOR_FIELDS.slice(0, 4),
  field("colors.levelBy", "Bar colors follow", SHOW.levelBy, {
    note: "pace: at or under even use, a little faster, or faster than it refills; the share left without a reset or in a window's first tenth",
  }),
  field("colors.warningBelow", "'Getting low' below", percentLeft, {
    values: THRESHOLDS,
    choices: warningChoices,
  }),
  field("colors.lowBelow", "'Almost out' below", percentLeft, {
    values: THRESHOLDS,
    choices: lowChoices,
  }),
  ...COLOR_FIELDS.slice(4),
  field("layout.bar", "Bar shape", SHOW.bar, { group: "Bars" }),
  field("layout.barWidth", "Bar width", SHOW.barWidth, {
    values: ["fill", 4, 6, 8, 10, 12],
    ...LAYOUT,
  }),
  field("layout.evenUse", "Even-use mark", SHOW.onOff, {
    note: "┃ in each bar where even use would be, like on the Limits tab",
  }),
  field("layout.indent", "Row indent", SHOW.indent, {
    group: "Spacing",
    values: [0, 1, 2, 3],
    ...LAYOUT,
  }),
  field("layout.labelWidth", "Label width", unit("letters"), {
    note: "the most a row name takes",
    values: [6, 8, 10, 12],
    ...LAYOUT,
  }),
  field("layout.providerGap", "Between providers", SHOW.gap, { values: [0, 1], ...LAYOUT }),
  field("layout.separator", "Separator", SHOW.separator, {
    group: "Status line",
    values: [" · ", " | ", " / ", "  "],
  }),
  field("words.percent", "Percent", SHOW.percent, {
    ...ALL_PLACES,
    group: "Words",
    preset: "words",
  }),
  field("words.reset", "Reset times", SHOW.reset, {
    ...ALL_PLACES,
    note: "the Limits tab always shows exact times",
    preset: "words",
  }),
  field("words.resetDecimals", "Decimals", SHOW.decimals, {
    ...ALL_PLACES,
    note: "for the decimal reset times",
    values: [0, 1, 2],
  }),
  field("words.rowNames", "Row names", SHOW.rowNames, {
    ...ALL_PLACES,
    note: "a row you renamed keeps your name; the Limits tab shows full names",
    preset: "words",
  }),
  field("words.detail", "Extra rows", SHOW.rows, { ...ALL_PLACES, group: "What shows" }),
  field("words.onlyCurrentModel", "Providers shown", SHOW.models, ALL_PLACES),
  field("words.sessionTokens", "Session tokens count", SHOW.tokens, ALL_PLACES),
  field("providers.cursor.plan", "Plan", cursorPlan, {
    ...CURSOR,
    note: "API use the plan includes; shown as a %",
  }),
  field("providers.cursor.includedApiUsd", "Included API budget", usd("from the plan"), {
    ...CURSOR,
    note: "a dollar amount to use instead of the plan's",
    placeholder: "a dollar amount",
  }),
  field("providers.cursor.billingCycleStartDay", "Billing day", SHOW.day, {
    ...CURSOR,
    note: "the day of the month your Cursor bill renews",
    placeholder: "a day 1-28",
  }),
  field("providers.opencode.monthlyLimitUsd", "Monthly budget", usd("from the Console"), {
    provider: "opencode",
    note: "a dollar amount to use instead",
    placeholder: "a dollar amount",
  }),
  field("providers.checking.minIntervalMs", "Check for new numbers", SHOW.minutes, {
    group: "Checking",
    values: [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
  }),
  // Unset (null), each provider waits its own time; set, every provider waits that long.
  field("providers.checking.requestTimeoutMs", "Slow provider: give up", SHOW.timeout, {
    values: [null, 5_000, 8_000, 12_000, 20_000, 30_000],
  }),
  field("providers.checking.waitForQuotaReset", "A model hits its limit", SHOW.limitHit),
  field(
    "providers.pricing.source",
    "Prices from",
    named({ auto: "newest list", bundled: "built-in list only", runtime: "downloaded list only" }),
    { group: "Token prices" },
  ),
  field("providers.pricing.autoRefreshDays", "Download new prices", SHOW.days, {
    values: [1, 7, 30],
  }),
];

/** A line that sets the lines marked with its name in one step. */
export type Preset = {
  tab: SettingsTab;
  title: string;
  /** What it sets, after "sets": the lines by their titles or their group's heading. */
  drives: string;
  /**
   * The line it sits above, taking that line's heading; without one it is the page's first,
   * under "Preset".
   */
  before?: string;
  /** The values of each choice, by path. */
  choices: Record<string, Record<string, FieldValue>>;
};

export const PRESETS: Record<PresetName, Preset> = {
  layout: {
    tab: "layout",
    title: "Layout preset",
    drives: "Bar width and the 3 Spacing lines",
    choices: PRESET_CHOICES.layout,
  },
  toast: {
    tab: "toast",
    title: "When toasts show",
    drives: "the 5 lines under When it shows",
    choices: PRESET_CHOICES.toast,
  },
  colors: {
    tab: "colors",
    title: "Color preset",
    drives: "every color line",
    choices: PRESET_CHOICES.colors,
  },
  words: {
    tab: "layout",
    title: "Wording",
    drives: "Percent, Reset times and Row names",
    before: "words.percent",
    choices: PRESET_CHOICES.words,
  },
};

/** A typed number the server takes for the field ("$" allowed); null for nothing typed. */
export function typedNumber(field: Field, text: string): FieldValue {
  const trimmed = text.trim().replace(/^\$/u, "");
  if (!trimmed) return null;
  const value = Number(trimmed);
  return checkSetting(field.path, value).issues.length === 0 ? value : undefined;
}

/** A typed "#89b4fa" (the # is optional); nothing typed puts the theme's color back. */
export function typedColor(settings: DisplaySettings, field: Field, text: string): DisplaySettings {
  const hex = text.trim().replace(/^#/u, "").toLowerCase();
  if (hex && !/^[0-9a-f]{6}$/u.test(hex)) return settings;
  return setIn(settings, field.path.split("."), hex ? `#${hex}` : undefined);
}

/** Desktop's own settings in the TUI's surface groups: no TUI tab shows or resets them. */
const DESKTOP_KEYS: ReadonlySet<string> = new Set(["statusLine.withSidePanel"]);

/**
 * The settings a tab's reset puts back to their defaults: its lines. A surface tab resets every
 * setting of its surface, its order, hidden rows, switch and preferred windows too; row names
 * and Desktop's own settings stay.
 */
export function resetKeys(tab: SettingsTab): string[] {
  return isSurfaceTab(tab)
    ? keysUnder(tab)
        .filter((key) => key !== "names")
        .map((key) => `${tab}.${key}`)
        .filter((key) => !DESKTOP_KEYS.has(key))
    : FIELDS.filter((field) => field.tab === tab).map((field) => field.path);
}

/** Settings received through the RPC, with this window's draft on top. */
export type DisplayStore = ReturnType<typeof createFileDisplay>;

export function createFileDisplay(server: import("./server-settings.js").ServerSettings) {
  const shown = () => {
    const settings = defaultSettings();
    for (const key of Object.keys(SETTINGS_SCHEMA)) {
      if (key !== "version") {
        const value = server.value(key);
        if (value !== undefined) setPath(settings, key, value);
      }
    }
    return settings;
  };
  return {
    server,
    shown,
    edit(change: (settings: DisplaySettings) => DisplaySettings): void {
      for (const diff of diffSettings(shown(), change(shown()))) server.set(diff.key, diff.after);
    },
  };
}
