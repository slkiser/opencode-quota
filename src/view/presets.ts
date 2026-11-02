/**
 * The settings presets: one choice sets several settings in one step. The TUI's Settings tabs
 * and the GUI's Settings page show the same choices. Pure.
 */
import type { Settings } from "../settings/schema.js";
import { stepIn } from "./settings-edit.js";
import type { ColorRole } from "./text.js";

/** What a setting line holds; undefined only for a color that follows the theme, null for unset. */
export type FieldValue = string | number | boolean | null | undefined;

export type PresetName = "layout" | "toast" | "words" | "colors";

type ColorChoice = NonNullable<Settings["colors"]["good"]>;

/** Every color role, in the order the Colors lines list them. */
export const COLOR_ROLES: readonly ColorRole[] = [
  "good",
  "warning",
  "low",
  "empty",
  "title",
  "provider",
  "account",
  "label",
  "percent",
  "reset",
  "value",
  "error",
  "statusName",
  "separator",
  "arrows",
];

function layoutChoice(
  barWidth: number | "fill",
  indent: number,
  labelWidth: number,
  providerGap: number,
) {
  return {
    "layout.barWidth": barWidth,
    "layout.indent": indent,
    "layout.labelWidth": labelWidth,
    "layout.providerGap": providerGap,
  };
}

function toastChoice(
  afterReply: string,
  afterQuestion: boolean,
  afterCompaction: boolean,
  resetNotice: string,
) {
  return {
    "toast.afterReply": afterReply,
    "toast.afterQuestion": afterQuestion,
    "toast.afterCompaction": afterCompaction,
    "toast.whenAllFail": true,
    "toast.resetNotice": resetNotice,
  };
}

/** Every color line: `changes`' colors, the theme's for the rest. */
function colorChoice(changes: Partial<Record<ColorRole, ColorChoice>>) {
  return Object.fromEntries(COLOR_ROLES.map((role) => [`colors.${role}`, changes[role]]));
}

/** Each preset's choices by name, with the values each sets by path. */
export const PRESET_CHOICES: Record<PresetName, Record<string, Record<string, FieldValue>>> = {
  layout: {
    compact: layoutChoice(6, 1, 6, 0),
    comfortable: layoutChoice("fill", 1, 8, 1),
    roomy: layoutChoice("fill", 2, 8, 2),
  },
  toast: {
    "only failures": toastChoice("off", false, false, "off"),
    quiet: toastChoice("off", false, true, "off"),
    normal: toastChoice("low", false, true, "off"),
    "every reply": toastChoice("always", true, true, "all"),
  },
  colors: {
    "theme colors": colorChoice({}),
    // The panel title in the text color, Almost out and errors in their red, the rest grey.
    grey: colorChoice({
      good: "muted",
      warning: "muted",
      provider: "muted",
      label: "muted",
      arrows: "muted",
    }),
  },
  words: {
    normal: { "words.percent": "left", "words.reset": "smart", "words.rowNames": "short" },
    short: { "words.percent": "bare", "words.reset": "compact", "words.rowNames": "short" },
    "spelled out": {
      "words.percent": "remaining",
      "words.reset": "exact",
      "words.rowNames": "full",
    },
  },
};

/** The preset choice whose values all match the lines' values; undefined is "your own". */
export function presetChoice(
  name: PresetName,
  value: (path: string) => unknown,
): string | undefined {
  return Object.entries(PRESET_CHOICES[name]).find(([, values]) =>
    Object.entries(values).every(([path, wanted]) => value(path) === wanted),
  )?.[0];
}

/** ‹ or ›: the values of the previous or next choice after `current`; from "your own", the first. */
export function presetValues(
  name: PresetName,
  current: string | undefined,
  delta: number,
): Readonly<Record<string, FieldValue>> {
  const names = Object.keys(PRESET_CHOICES[name]);
  const next = current === undefined ? names[0] : stepIn(names, current, delta);
  return PRESET_CHOICES[name][next as string] ?? {};
}
