/** Settings rules, defaults and display values shared by the server, TUI and Desktop. */
import type { QuotaWindow } from "../core/types.js";
import { isQuotaWindow } from "../core/windows.js";
import { isRecord } from "../lib/json-guards.js";
import { setPath, THEME_COLOR_NAMES } from "./shared.js";

type NumberBounds = { min?: number; above?: number; max?: number };
export type SettingRule = (
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly string[] }
  /**
   * `above` is an exclusive lower bound, `min` and `max` inclusive ones. `word` is a word the
   * setting takes instead of a number ("fill").
   */
  | ({ kind: "number"; integer: boolean; nullable?: boolean; word?: string } & NumberBounds)
  /** An absolute or `~/` path without `..`; also "" or a command name when allowed. */
  | { kind: "path"; allowEmpty?: boolean; allowCommand?: boolean }
  | {
      kind: "providers" | "customProviders" | "strings" | "names" | "rowOrder" | "window" | "color";
    }
  | { kind: "separator"; maxLength: number }
) & {
  default: unknown;
  /** Only the file sets it (by hand or by an agent): `saveSettings` needs `allowFileOnly`. */
  fileOnly?: boolean;
};

const bool = (value: boolean) => ({ kind: "boolean", default: value }) as const;
const choice = <const V extends readonly string[]>(values: V, value: V[number]) =>
  ({ kind: "choice", values, default: value }) as const;
const above0 = (value: number) =>
  ({ kind: "number", integer: false, above: 0, default: value }) as const;
const whole = (min: number, max?: number) => ({ kind: "number", integer: true, min, max }) as const;
const USD = { kind: "number", integer: false, above: 0, nullable: true, default: null } as const;

/** Every setting by its dotted key with its default, in the order a new file lists them. */
export const SETTINGS_SCHEMA = {
  version: { ...whole(6, 6), default: 6 },
  "sidebar.show": bool(true),
  "sidebar.sessionTokens": bool(true),
  "sidebar.runsOut": bool(true),
  "sidebar.hidden": { kind: "strings", default: [] },
  "sidebar.providerOrder": { kind: "strings", default: [] },
  "sidebar.rowOrder": { kind: "rowOrder", default: {} },
  "sidebar.names": { kind: "names", default: {} },
  "collapsed.show": bool(true),
  "collapsed.runsOut": bool(false),
  "collapsed.hidden": { kind: "strings", default: [] },
  "collapsed.providerOrder": { kind: "strings", default: [] },
  "collapsed.rowOrder": { kind: "rowOrder", default: {} },
  /** A window by provider id; `ALL_PROVIDERS` ("*") for every provider without its own. */
  "collapsed.window": { kind: "window", default: {} },
  "statusLine.show": bool(true),
  /** The TUI's: also while a sidebar panel shows quota; else only when none is on screen. */
  "statusLine.withSidebar": bool(false),
  /** Desktop's: also while the Quota tab shows in the side panel; else only when it does not. */
  "statusLine.withSidePanel": bool(true),
  /** Desktop's: the pill above the message box; else only the bottom strip shows. */
  "statusLine.composerPill": bool(true),
  "statusLine.runsOut": bool(false),
  "statusLine.hidden": { kind: "strings", default: [] },
  "statusLine.providerOrder": { kind: "strings", default: [] },
  "statusLine.rowOrder": { kind: "rowOrder", default: {} },
  "statusLine.window": { kind: "window", default: {} },
  "statusLine.detail": choice(["auto", "one", "full", "bar", "reset", "numbers"], "auto"),
  "statusLine.width": { ...whole(0, 1000), default: 0 },
  "statusLine.autoScrollSeconds": { ...whole(0, 600), default: 0 },
  "statusLine.home": bool(false),
  "toast.show": bool(true),
  "toast.runsOut": bool(true),
  "toast.hidden": { kind: "strings", default: [] },
  "toast.providerOrder": { kind: "strings", default: [] },
  "toast.rowOrder": { kind: "rowOrder", default: {} },
  "toast.names": { kind: "names", default: {} },
  "toast.afterReply": choice(["off", "always", "low"], "low"),
  "toast.afterQuestion": bool(false),
  "toast.afterCompaction": bool(true),
  "toast.whenAllFail": bool(true),
  "toast.resetNotice": choice(["off", "weekly", "all"], "off"),
  /** "grouped": a line per row under its provider; "detailed": v5's two lines per row. */
  "toast.layout": choice(["grouped", "detailed"], "grouped"),
  "toast.seconds": { ...whole(1, 120), default: 9 },
  "toast.sessionTokens": bool(true),
  "colors.good": { kind: "color", default: undefined },
  "colors.warning": { kind: "color", default: undefined },
  "colors.low": { kind: "color", default: undefined },
  "colors.empty": { kind: "color", default: undefined },
  "colors.title": { kind: "color", default: undefined },
  "colors.provider": { kind: "color", default: undefined },
  "colors.account": { kind: "color", default: undefined },
  "colors.label": { kind: "color", default: undefined },
  "colors.percent": { kind: "color", default: undefined },
  "colors.reset": { kind: "color", default: undefined },
  "colors.value": { kind: "color", default: undefined },
  "colors.error": { kind: "color", default: undefined },
  "colors.statusName": { kind: "color", default: undefined },
  "colors.separator": { kind: "color", default: undefined },
  "colors.arrows": { kind: "color", default: undefined },
  /**
   * What the bar colors follow: "left", the share left against the two levels below; "pace", how
   * fast the limit is used against even use until its reset (the share left without a reset).
   */
  "colors.levelBy": choice(["left", "pace"], "left"),
  "colors.warningBelow": { ...whole(0, 100), default: 50 },
  "colors.lowBelow": { ...whole(0, 100), default: 20 },
  "layout.bar": choice(["blocks", "shades", "line", "squares", "dots", "none"], "blocks"),
  /** "fill": the room the other columns leave, up to each place's most. */
  "layout.barWidth": { ...whole(1, 30), word: "fill", default: "fill" },
  /** The ┃ mark where even use would be, in every place's bars, the Limits tab's too. */
  "layout.evenUse": bool(true),
  "layout.indent": { ...whole(0, 4), default: 1 },
  /** The most columns a row name takes; the name column fits the names next to a bar. */
  "layout.labelWidth": { ...whole(3, 20), default: 8 },
  /** Empty lines between providers in the sidebar. */
  "layout.providerGap": { ...whole(0, 2), default: 1 },
  /** Between providers on the status line. */
  "layout.separator": { kind: "separator", maxLength: 5, default: " · " },
  /**
   * The share every client shows: "58% left", "58% remaining", "58%", or "42% used". `used` also
   * fills the bars and their even-use mark with the share used. The expanded sidebar panel says
   * the word in its title ("▼ Quota used") and leaves it off its rows; other places keep it.
   */
  "words.percent": choice(["left", "remaining", "bare", "used"], "left"),
  /**
   * "4.5d" (smart), "2h 14m", "2h14m", "2h", "2.2h" (with `resetDecimals`), or "percent": the
   * share of the window's time left (used, with `percent` "used"), then the time in its largest
   * unit ("58%/91% 4d"); that time alone when the window's start is unknown.
   */
  "words.reset": choice(["smart", "exact", "compact", "short", "decimal", "percent"], "smart"),
  /** Decimals of the "decimal" reset style. */
  "words.resetDecimals": { ...whole(0, 4), default: 1 },
  /**
   * How the sidebar, the collapsed panel, the status line and toasts name a row: "short" by its
   * window ("5h", "7d") unless another row of its provider has the same one, "full" by its label.
   * A row you renamed shows your name in both.
   */
  "words.rowNames": choice(["short", "full"], "short"),
  /** "detailed" also shows supplementary rows. */
  "words.detail": choice(["summary", "detailed"], "summary"),
  /** Show only the providers serving the session's current model. */
  "words.onlyCurrentModel": bool(false),
  /** Session tokens of this session, or with its subagents. */
  "words.sessionTokens": choice(["current", "tree"], "current"),
  "providers.off": { kind: "providers", default: [] },
  "providers.custom": { kind: "customProviders", default: [], fileOnly: true },
  /** The Claude CLI quota runs for Claude limits. */
  "providers.anthropic.binaryPath": {
    kind: "path",
    allowCommand: true,
    default: "claude",
    fileOnly: true,
  },
  "providers.cursor.plan": choice(["none", "pro", "pro-plus", "ultra"], "none"),
  "providers.cursor.includedApiUsd": USD,
  "providers.cursor.billingCycleStartDay": { ...whole(1, 28), nullable: true, default: null },
  "providers.opencode.monthlyLimitUsd": USD,
  "providers.checking.minIntervalMs": above0(300_000),
  "providers.checking.requestTimeoutMs": above0(5_000),
  "providers.checking.waitForQuotaReset": bool(true),
  "providers.pricing.source": choice(["auto", "bundled", "runtime"], "auto"),
  "providers.pricing.autoRefreshDays": { ...whole(1), default: 7 },
  "providers.pricing.refreshConnectedProviders": bool(false),
  "system.exportFile": bool(false),
  /** "" = `$XDG_CACHE_HOME/opencode/quota-export.json`. */
  "system.exportPath": { kind: "path", allowEmpty: true, default: "", fileOnly: true },
  "system.telemetry": bool(false),
  /** The 4.x and 5.x /tokens_* commands, each `/quota_usage` on its range. */
  "system.oldCommands": bool(true),
} as const satisfies Record<string, SettingRule>;

type KindValue<CustomProvider> = {
  boolean: boolean;
  number: number;
  path: string;
  providers: string[];
  strings: string[];
  names: Record<string, string>;
  rowOrder: Record<string, string[]>;
  window: Record<string, "lowest" | QuotaWindow>;
  color: (typeof THEME_COLOR_NAMES)[number] | `#${string}` | undefined;
  separator: string;
  customProviders: CustomProvider[];
};
type ValueOf<R, CustomProvider> = R extends { values: readonly (infer V)[] }
  ? V
  : R extends { word: infer W extends string }
    ? number | W
    : R extends { nullable: true }
      ? number | null
      : R extends { kind: infer K extends keyof KindValue<CustomProvider> }
        ? KindValue<CustomProvider>[K]
        : never;
type Head<K> = K extends `${infer Group}.${string}` ? Group : K;
type Under<T, Group extends string> = {
  [K in keyof T as K extends `${Group}.${infer Rest}` ? Rest : never]: T[K];
};
/** `{ "a.b": X }` as `{ a: { b: X } }`. */
type Nest<T> = {
  [K in keyof T as Head<K>]: K extends `${infer Group}.${string}` ? Nest<Under<T, Group>> : T[K];
};
type Schema = typeof SETTINGS_SCHEMA;
export type Settings<CustomProvider = never> = Nest<{
  -readonly [K in keyof Schema]: ValueOf<Schema[K], CustomProvider>;
}>;

export const SURFACE_GROUPS = [
  "sidebar",
  "collapsed",
  "statusLine",
  "toast",
  "colors",
  "layout",
  "words",
] as const;

export type SurfaceSettings = Pick<Settings, (typeof SURFACE_GROUPS)[number]>;

/** The theme color each role follows unless its setting picks another. */
export const ROLE_THEME = {
  good: "green",
  warning: "yellow",
  low: "red",
  empty: "muted",
  title: "text",
  provider: "text",
  account: "muted",
  label: "text",
  percent: "bar",
  reset: "muted",
  value: "muted",
  error: "red",
  statusName: "muted",
  separator: "muted",
  arrows: "accent",
} as const;

export type ColorRole = keyof typeof ROLE_THEME;

function checkNumber(rule: Extract<SettingRule, { kind: "number" }>, value: unknown): boolean {
  if (value === null) return rule.nullable === true;
  if (rule.word !== undefined && value === rule.word) return true;
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    (rule.min === undefined || value >= rule.min) &&
    (rule.above === undefined || value > rule.above) &&
    (rule.max === undefined || value <= rule.max)
  );
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Checks the plain value kinds; paths and provider definitions are checked by the server. */
export function checkValue(rule: SettingRule, value: unknown): { value?: unknown; valid: boolean } {
  const invalid = { valid: false };
  switch (rule.kind) {
    case "boolean":
      return typeof value === "boolean" ? { value, valid: true } : invalid;
    case "choice":
      return typeof value === "string" && rule.values.includes(value)
        ? { value, valid: true }
        : invalid;
    case "number":
      return checkNumber(rule, value) ? { value, valid: true } : invalid;
    case "strings":
      return isStringList(value) ? { value, valid: true } : invalid;
    case "separator":
      return typeof value === "string" && value.length <= rule.maxLength
        ? { value, valid: true }
        : invalid;
    case "color":
      return value === undefined ||
        (THEME_COLOR_NAMES as readonly string[]).includes(String(value)) ||
        (typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value))
        ? { value, valid: true }
        : invalid;
    case "names":
    case "rowOrder":
    case "window": {
      if (!isRecord(value)) return invalid;
      const entries = Object.entries(value);
      const valid = (item: unknown) =>
        rule.kind === "names"
          ? typeof item === "string"
          : rule.kind === "rowOrder"
            ? isStringList(item)
            : item === "lowest" || isQuotaWindow(item);
      const kept = entries.filter(([, item]) => valid(item));
      return {
        value: Object.fromEntries(kept),
        valid: kept.length === entries.length,
      };
    }
    default:
      return invalid;
  }
}

/** Reads saved dotted values over the rules' defaults, optionally for only the display groups. */
function readValues(values: Readonly<Record<string, unknown>>, surfacesOnly = false): object {
  const settings = {};
  const groups: readonly string[] = SURFACE_GROUPS;
  for (const [key, rule] of Object.entries(SETTINGS_SCHEMA)) {
    if (surfacesOnly && !groups.includes(key.split(".")[0])) continue;
    const saved = Object.hasOwn(values, key) ? values[key] : undefined;
    const value = saved === undefined ? undefined : checkValue(rule, saved).value;
    setPath(settings, key, value === undefined ? structuredClone(rule.default) : value);
  }
  return settings;
}

export function defaultSettings<CustomProvider = never>(): Settings<CustomProvider> {
  return readValues({}) as Settings<CustomProvider>;
}

/** The display groups in saved values, with defaults for missing or invalid values. */
export function settingsFromValues(values: Readonly<Record<string, unknown>>): SurfaceSettings {
  return readValues(values, true) as SurfaceSettings;
}
