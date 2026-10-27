/**
 * The Settings page apart from how it is drawn: which settings each section lists (the UI map),
 * the control each setting gets from its rule in the server's schema (`settingsSchema` over the
 * quota RPC), the presets, and the settings a section's Reset puts back. The rules decide every
 * key, kind, range and default; this map only groups and labels them. Pure.
 */
import type { SettingRule, Settings } from "../settings/schema.js";
import { THEME_COLOR_NAMES } from "../settings/shared.js";
import { PROVIDERS_KEY } from "../tui/settings-draft.js";
import { PRESET_CHOICES, type PresetName } from "../view/presets.js";
import type { Surface } from "../view/select.js";

export type SectionId =
  | "places"
  | "sidebar"
  | "collapsed"
  | "statusLine"
  | "toast"
  | "colors"
  | "layout"
  | "words"
  | "providers"
  | "checking"
  | "plugin"
  | "file"
  | "opencode";

export type Section = {
  id: SectionId;
  /** The settings it lists as rows, top to bottom. */
  keys: readonly string[];
  /** The preset on top of the section. */
  preset?: PresetName;
  /** The surface whose providers and rows the section's tree shows, hides, orders and names. */
  editor?: Surface;
  /** Its switches save at once, apart from the draft. */
  instant?: true;
};

/** The provider settings the Providers section nests under each provider's switch. */
export const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> = {
  cursor: [
    "providers.cursor.plan",
    "providers.cursor.includedApiUsd",
    "providers.cursor.billingCycleStartDay",
  ],
  opencode: ["providers.opencode.monthlyLimitUsd"],
};

const colorKeys = (roles: readonly string[]) => roles.map((role) => `colors.${role}`);

/** Every section, in page order. */
export const SECTIONS: readonly Section[] = [
  { id: "places", keys: ["sidebar.show", "collapsed.show", "statusLine.show", "toast.show"] },
  { id: "sidebar", keys: ["sidebar.sessionTokens", "sidebar.runsOut"], editor: "sidebar" },
  { id: "collapsed", keys: ["collapsed.runsOut"], editor: "collapsed" },
  {
    id: "statusLine",
    keys: [
      "statusLine.withSidebar",
      "statusLine.home",
      "statusLine.detail",
      "statusLine.runsOut",
      "statusLine.width",
      "statusLine.autoScrollSeconds",
    ],
    editor: "statusLine",
  },
  {
    id: "toast",
    preset: "toast",
    keys: [
      "toast.afterReply",
      "toast.afterQuestion",
      "toast.afterCompaction",
      "toast.whenAllFail",
      "toast.resetNotice",
      "toast.layout",
      "toast.seconds",
      "toast.sessionTokens",
      "toast.runsOut",
    ],
    editor: "toast",
  },
  {
    id: "colors",
    preset: "colors",
    keys: [
      ...colorKeys(["good", "warning", "low", "empty"]),
      "colors.levelBy",
      "colors.warningBelow",
      "colors.lowBelow",
      ...colorKeys(["title", "provider", "account", "label", "percent", "reset", "value"]),
      ...colorKeys(["error", "statusName", "separator", "arrows"]),
    ],
  },
  {
    id: "layout",
    preset: "layout",
    keys: [
      "layout.bar",
      "layout.barWidth",
      "layout.evenUse",
      "layout.indent",
      "layout.labelWidth",
      "layout.providerGap",
      "layout.separator",
    ],
  },
  {
    id: "words",
    preset: "words",
    keys: [
      "words.percent",
      "words.reset",
      "words.resetDecimals",
      "words.rowNames",
      "words.detail",
      "words.onlyCurrentModel",
      "words.sessionTokens",
    ],
  },
  { id: "providers", keys: [PROVIDERS_KEY, ...Object.values(PROVIDER_KEYS).flat()] },
  {
    id: "checking",
    keys: [
      "providers.checking.minIntervalMs",
      "providers.checking.requestTimeoutMs",
      "providers.checking.waitForQuotaReset",
      "providers.pricing.source",
      "providers.pricing.autoRefreshDays",
    ],
  },
  {
    id: "plugin",
    keys: ["system.oldCommands", "system.exportFile", "system.telemetry"],
    instant: true,
  },
  { id: "file", keys: [] },
  { id: "opencode", keys: [] },
];

/** Settings only the terminal draws: the GUI's bars and columns size themselves. */
export const TUI_ONLY: ReadonlySet<string> = new Set([
  "statusLine.width",
  "layout.bar",
  "layout.barWidth",
  "layout.indent",
  "layout.labelWidth",
]);

/** A heading above a row, by the row's key: the groups of the Colors section. */
export const SUBHEADINGS: Readonly<Record<string, string>> = {
  "colors.good": "settings.sub.bars",
  "colors.title": "settings.sub.names",
  "colors.percent": "settings.sub.numbers",
  "colors.statusName": "settings.sub.strip",
};

/** The colors of the bar levels themselves, which can't follow the bar color. */
const LEVEL_COLORS: ReadonlySet<string> = new Set(["colors.good", "colors.warning", "colors.low"]);

const MINUTE_MS = 60_000;

/**
 * Numbers picked from a few values instead of typed: milliseconds read badly. A value the file
 * sets outside the list is offered too.
 */
const SUGGESTED: Readonly<Record<string, readonly (number | null)[]>> = {
  "providers.checking.minIntervalMs": [1, 2, 5, 10, 15, 30].map((count) => count * MINUTE_MS),
  "providers.checking.requestTimeoutMs": [null, 5_000, 8_000, 12_000, 20_000, 30_000],
};

/** A choice's words: an i18n key, with its values. */
export type Words = { key: string; params?: Record<string, string | number> };
export type Option = { value: unknown; words: Words };

export type Control =
  | { kind: "switch" }
  | { kind: "select"; options: Option[] }
  /** A typed number within the rule's bounds; `word` ("fill") is taken instead of one. */
  | {
      kind: "number";
      integer: boolean;
      min?: number;
      above?: number;
      max?: number;
      nullable: boolean;
      word?: string;
    }
  /** A theme color, the theme's own (undefined), or a typed "#rrggbb". */
  | { kind: "color"; options: Option[] }
  | { kind: "text"; maxLength: number }
  /** Shown by the section itself (the providers' switches, the trees) or only in the file. */
  | { kind: "none" };

/** The words of one value of `key`: `option.<key>.<value>`. */
function optionWords(key: string, value: unknown): Words {
  return { key: `option.${key}.${String(value)}` };
}

/** The words of a suggested number. */
function suggestedWords(key: string, value: number | null): Words {
  if (value === null) return { key: `option.${key}.unset` };
  if (key === "providers.checking.minIntervalMs") {
    return { key: "option.minutes", params: { count: value / MINUTE_MS } };
  }
  return { key: "option.seconds", params: { count: value / 1_000 } };
}

/** The control `key` gets from its rule, with `current` among a suggested list's choices. */
export function controlFor(key: string, rule: SettingRule, current?: unknown): Control {
  switch (rule.kind) {
    case "boolean":
      return { kind: "switch" };
    case "choice":
      return {
        kind: "select",
        options: rule.values.map((value) => ({ value, words: optionWords(key, value) })),
      };
    case "number": {
      const suggested = Object.hasOwn(SUGGESTED, key) ? SUGGESTED[key] : undefined;
      if (suggested) {
        const values =
          typeof current === "number" && !suggested.includes(current)
            ? [...suggested, current]
            : suggested;
        return {
          kind: "select",
          options: values.map((value) => ({ value, words: suggestedWords(key, value) })),
        };
      }
      return {
        kind: "number",
        integer: rule.integer,
        ...(rule.min !== undefined ? { min: rule.min } : {}),
        ...(rule.above !== undefined ? { above: rule.above } : {}),
        ...(rule.max !== undefined ? { max: rule.max } : {}),
        nullable: rule.nullable === true,
        ...(rule.word !== undefined ? { word: rule.word } : {}),
      };
    }
    case "color": {
      const names = THEME_COLOR_NAMES.filter((name) => name !== "bar" || !LEVEL_COLORS.has(key));
      return {
        kind: "color",
        options: [
          { value: undefined, words: { key: "option.color.theme" } },
          ...names.map((name) => ({ value: name, words: { key: `option.color.${name}` } })),
        ],
      };
    }
    case "separator":
      return { kind: "text", maxLength: rule.maxLength };
    default:
      return { kind: "none" };
  }
}

/** The value a typed number stands for: null for nothing typed when allowed, else undefined. */
export function typedNumber(
  control: Extract<Control, { kind: "number" }>,
  text: string,
): number | null | undefined {
  const trimmed = text.trim().replace(/^\$/u, "");
  if (!trimmed) return control.nullable ? null : undefined;
  const value = Number(trimmed);
  const valid =
    Number.isFinite(value) &&
    (!control.integer || Number.isInteger(value)) &&
    (control.min === undefined || value >= control.min) &&
    (control.above === undefined || value > control.above) &&
    (control.max === undefined || value <= control.max);
  return valid ? value : undefined;
}

/** A number control's range in words, from the rule: "1–120", "above 0", "at least 1". */
export function rangeWords(control: Extract<Control, { kind: "number" }>): Words | undefined {
  if (control.min !== undefined && control.max !== undefined) {
    return { key: "settings.range.between", params: { min: control.min, max: control.max } };
  }
  if (control.above !== undefined) {
    return { key: "settings.range.above", params: { min: control.above } };
  }
  if (control.min !== undefined)
    return { key: "settings.range.atLeast", params: { min: control.min } };
  return undefined;
}

export type SectionRow = { key: string; rule: SettingRule };

/**
 * A section's rows: its keys the rules have, so a key an older server lacks is left out. The
 * Providers section lists only its nested provider settings here.
 */
export function sectionRows(
  section: Section,
  rules: Readonly<Record<string, SettingRule>>,
): SectionRow[] {
  return section.keys
    .filter((key) => Object.hasOwn(rules, key) && key !== PROVIDERS_KEY)
    .map((key) => ({ key, rule: rules[key] as SettingRule }));
}

/** The settings each surface's tree edits, from the rules: hidden, order, names, window. */
export function editorKeys(
  surface: Surface,
  rules: Readonly<Record<string, SettingRule>>,
): string[] {
  const tree = new Set(["strings", "rowOrder", "names", "window"]);
  return Object.entries(rules)
    .filter(([key, rule]) => key.startsWith(`${surface}.`) && tree.has(rule.kind))
    .map(([key]) => key);
}

/**
 * The settings a section's Reset puts back to their defaults: its rows, and its tree's settings
 * but the row names, as the TUI's Reset does.
 */
export function resetKeys(
  section: Section,
  rules: Readonly<Record<string, SettingRule>>,
): string[] {
  const own = section.keys.filter((key) => Object.hasOwn(rules, key));
  const tree = section.editor
    ? editorKeys(section.editor, rules).filter((key) => !key.endsWith(".names"))
    : [];
  return [...own, ...tree];
}

/** The settings only settings.jsonc sets, from the rules: the file-only ones and `version`. */
export function fileOnlyKeys(rules: Readonly<Record<string, SettingRule>>): string[] {
  return Object.entries(rules)
    .filter(([key, rule]) => rule.fileOnly === true || key === "version")
    .map(([key]) => key);
}

/** A preset's choices, in order. */
export function presetNames(name: PresetName): string[] {
  return Object.keys(PRESET_CHOICES[name]);
}

/**
 * The surface settings `after` changes from `before`, among `keys`, as [key, new value]: what a
 * tree edit (show or hide, order, name, window) sets in the draft.
 */
export function changedSettings(
  before: Settings,
  after: Settings,
  keys: readonly string[],
): Array<[string, unknown]> {
  const at = (settings: Settings, key: string) => {
    let value: unknown = settings;
    for (const part of key.split(".")) {
      value =
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)[part]
          : undefined;
    }
    return value;
  };
  return keys
    .filter((key) => JSON.stringify(at(before, key)) !== JSON.stringify(at(after, key)))
    .map((key) => [key, at(after, key)]);
}
