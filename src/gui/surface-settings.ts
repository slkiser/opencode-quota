/**
 * The settings the GUI's always-on surfaces read, from the snapshot the server sends: the same
 * `sidebar`, `collapsed`, `statusLine`, `toast`, `colors`, `layout` and `words` groups the TUI's
 * surfaces read, with their defaults where the snapshot has none. Pure.
 *
 * The defaults are copied here so the window bundle does not take in `settings/schema.ts`, which
 * imports the provider definitions and the prices; a test keeps them equal to the schema's. The
 * same holds for each color role's theme color, which the TUI keeps in `tui/display.ts`.
 */
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import type { ColorRole } from "../view/text.js";

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

export const SURFACE_DEFAULTS: SurfaceSettings = {
  sidebar: {
    show: true,
    sessionTokens: true,
    runsOut: true,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    names: {},
  },
  collapsed: {
    show: true,
    runsOut: false,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    window: {},
  },
  statusLine: {
    show: true,
    withSidebar: false,
    runsOut: false,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    window: {},
    detail: "auto",
    width: 0,
    autoScrollSeconds: 0,
    home: false,
  },
  toast: {
    show: true,
    runsOut: true,
    hidden: [],
    providerOrder: [],
    rowOrder: {},
    names: {},
    afterReply: "low",
    afterQuestion: false,
    afterCompaction: true,
    whenAllFail: true,
    resetNotice: "off",
    layout: "grouped",
    seconds: 9,
    sessionTokens: true,
  },
  colors: {
    good: undefined,
    warning: undefined,
    low: undefined,
    empty: undefined,
    title: undefined,
    provider: undefined,
    account: undefined,
    label: undefined,
    percent: undefined,
    reset: undefined,
    value: undefined,
    error: undefined,
    statusName: undefined,
    separator: undefined,
    arrows: undefined,
    levelBy: "left",
    warningBelow: 50,
    lowBelow: 20,
  },
  layout: {
    bar: "blocks",
    barWidth: "fill",
    evenUse: true,
    indent: 1,
    labelWidth: 8,
    providerGap: 1,
    separator: " · ",
  },
  words: {
    percent: "left",
    reset: "smart",
    resetDecimals: 1,
    rowNames: "short",
    detail: "summary",
    onlyCurrentModel: false,
    sessionTokens: "current",
  },
};

/** The theme color each role follows unless the settings pick another ("bar": its row's level). */
export const ROLE_THEME: Record<
  ColorRole,
  "text" | "muted" | "accent" | "green" | "yellow" | "red" | "bar"
> = {
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
};

/**
 * The surface settings of `snapshot`: its values over the defaults, and `preview` (the Settings
 * page's unsaved changes, by dotted key) over those. Typed as the whole `Settings`, which the
 * shared surface helpers (`view/text.ts`, `tui/toasts.ts`) take; they read only the groups above.
 */
export function surfaceSettings(
  snapshot: QuotaSnapshot | undefined,
  preview?: Readonly<Record<string, unknown>>,
): Settings {
  return settingsFromValues({ ...snapshot?.settings?.values, ...preview });
}

/** The surface settings with `values` (by dotted key) over the defaults; other keys are skipped. */
export function settingsFromValues(values: Readonly<Record<string, unknown>>): Settings {
  const settings = structuredClone(SURFACE_DEFAULTS) as unknown as Record<
    string,
    Record<string, unknown>
  >;
  for (const [key, value] of Object.entries(values)) {
    const dot = key.indexOf(".");
    const name = key.slice(0, dot);
    const group = dot > 0 && Object.hasOwn(settings, name) ? settings[name] : undefined;
    if (group && value !== undefined) group[key.slice(dot + 1)] = value;
  }
  return settings as unknown as Settings;
}
