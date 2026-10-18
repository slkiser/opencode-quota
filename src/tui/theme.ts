/**
 * Quota's colors from the user's OpenCode theme. Every color role follows a named theme color
 * unless the display settings pick another one or a fixed "#rrggbb". The theme is read on every
 * call, so a surface that colors inside its JSX follows a theme or light/dark switch at once.
 */
import { RGBA } from "@opentui/core";
import { type Level, levelOf } from "../view/format.js";
import type { ColorRole, Segment } from "../view/text.js";
import { type ColorChoice, type ColorName, type DisplaySettings, THEME_COLORS } from "./display.js";

/** The theme tokens quota reads (OpenCode's `ResolvedTheme`). */
export type Theme = {
  text: {
    base: RGBA;
    muted: RGBA;
    /** The label of the line the Settings tabs have selected, on a surface. */
    action: { primary: { selected: RGBA } };
    feedback: Record<"success" | "warning" | "error" | "info", { base: RGBA }>;
  };
  /** Behind the line the Settings tabs have selected, on a surface. */
  background: { raised: { high: RGBA } };
  hue: { accent: Record<number, RGBA> };
};

export function namedColor(theme: Theme, name: ColorName): RGBA {
  switch (name) {
    case "text":
      return theme.text.base;
    case "muted":
      return theme.text.muted;
    case "accent":
      return theme.hue.accent[500] ?? theme.text.base;
    case "green":
      return theme.text.feedback.success.base;
    case "yellow":
      return theme.text.feedback.warning.base;
    case "red":
      return theme.text.feedback.error.base;
    case "blue":
      return theme.text.feedback.info.base;
  }
}

/** A fixed choice ("bar" is not one: the level roles can't follow themselves). */
function fixedColor(theme: Theme, choice: ColorChoice, fallback: ColorName): RGBA {
  if (choice === "bar") return namedColor(theme, fallback);
  return choice.startsWith("#") ? RGBA.fromHex(choice) : namedColor(theme, choice as ColorName);
}

function choiceFor(display: DisplaySettings, role: ColorRole): ColorChoice {
  return display.colors[role] ?? THEME_COLORS[role];
}

/**
 * The bar color for a percent left: plenty left, getting low, or almost out. With the bar colors
 * following pace, a row's level by pace wins; a row without one falls back to its percent.
 */
export function levelColor(
  theme: Theme,
  display: DisplaySettings,
  percent: number,
  paceLevel?: Level,
): RGBA {
  const role =
    display.levelBy === "pace" && paceLevel ? paceLevel : levelOf(percent, display.thresholds);
  return fixedColor(theme, choiceFor(display, role), THEME_COLORS[role] as ColorName);
}

/** A role's color. A role set to "bar" takes the level color of the row's percent. */
export function roleColor(
  theme: Theme,
  display: DisplaySettings,
  role: ColorRole,
  percent = 100,
  paceLevel?: Level,
): RGBA {
  const choice = choiceFor(display, role);
  return choice === "bar"
    ? levelColor(theme, display, percent, paceLevel)
    : fixedColor(theme, choice, "text");
}

/** The color of one line segment. */
export function segmentColor(theme: Theme, display: DisplaySettings, segment: Segment): RGBA {
  return segment.role === "bar"
    ? levelColor(theme, display, segment.percent ?? 100, segment.paceLevel)
    : roleColor(theme, display, segment.role, segment.percent, segment.paceLevel);
}
