/**
 * The one-time move from v5 settings. A frozen copy of how v5 read its GLOBAL settings (which
 * files, the authoritative-sidecar rule, each key's check), and where each v5 key goes in settings.jsonc.
 * The same files in the older folders v4 also read are converted when OpenCode's global folder
 * has none. This file only reads; `convertV5` in file.ts writes the result.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseError, parse } from "jsonc-parser";
import { isRecord } from "../lib/json-guards.js";
import {
  type CheckedSetting,
  checkSetting,
  PROVIDER_IDS,
  SETTINGS_SCHEMA,
  type Settings,
  settingsFrom,
} from "./schema.js";

/** A v5 key and its destination in settings.jsonc. */
export type ConvertedKey = { key: string; to: string; where: "server"; note?: string };
export type SkippedKey = { key: string; reason: string };

type DisplaySurface = "sidebar" | "collapsed" | "statusLine" | "toast";

export type V5Conversion = {
  /** The v5 files the values came from, in the order v5 applied them. */
  sources: string[];
  /** An old file does not parse: `convertV5` waits (maybe mid-edit); a save converts the rest. */
  malformed: boolean;
  /** True when this call wrote settings.jsonc. */
  written: boolean;
  /** Why settings.jsonc was not written, when a write was tried. */
  notWrittenReason?: string;
  /** The converted server values by dotted key, in file order. */
  values: Record<string, unknown>;
  settings: Settings;
  /** The server keys the conversion set; every other key has its default. */
  fromFile: string[];
  converted: ConvertedKey[];
  dropped: SkippedKey[];
  invalid: SkippedKey[];
  notes: string[];
};

const SIDECAR_NAMES = ["quota-toast.jsonc", "quota-toast.json"] as const;
/** v5 applied opencode.json first, so opencode.jsonc won per key. */
const HOST_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

const NO_FORMAT_STYLE =
  "no v6 equivalent: the sidebar shows every row and the collapsed sidebar one per provider";

/** v5 keys v6 does not keep, and why. */
const DROPPED: ReadonlyMap<string, string> = new Map(
  Object.entries({
    enabled: "v6 has no switch of its own; turn the plugin off in OpenCode's plugin list",
    tuiCommandDisplay: "the TUI shows /quota, /quota_usage and /quota_status in its quota window",
    formatStyle: NO_FORMAT_STYLE,
    toastStyle: 'toasts use the grouped layout; `toast.layout: "detailed"` is the 5.x look',
    "tuiSidebarPanel.formatStyle": NO_FORMAT_STYLE,
    "tuiCompactStatus.formatStyle": NO_FORMAT_STYLE,
    debug: "/quota_status shows the diagnostics",
    "maintainerAnnouncements.enabled": "notices have no settings in v6",
    "maintainerAnnouncements.home": "notices have no settings in v6",
    "maintainerAnnouncements.homeFrequency": "notices have no settings in v6",
    "layout.maxWidth": "OpenCode sizes toasts",
    "layout.narrowAt": "OpenCode sizes toasts",
    "layout.tinyAt": "OpenCode sizes toasts",
    "tuiCompactStatus.maxWidth": "the status line uses the room the footer leaves free",
    alibabaCodingPlanTier:
      "removed in v4; the alibaba-coding-plan id now belongs to the built-in CLI provider, so a leftover tuning tunes nothing",
    customSources: 'removed in v4; use "providers.custom"',
  }),
);
/** 4.x leftovers v5 already ignored without a word. */
const SILENT = new Set(["tuiCompactStatus.suppressWhenNativeProviderQuota"]);

const isBoolean = (value: unknown) => typeof value === "boolean";
const oneOf =
  (...values: unknown[]) =>
  (value: unknown) =>
    values.includes(value);
const isListOf = (check: (value: unknown) => boolean) => (value: unknown) =>
  Array.isArray(value) && value.length > 0 && value.every(check);

/**
 * Every v5 key v6 reads (5.x src/lib/config.ts): the settings.jsonc key it moved to unchanged,
 * checked by that key's rule, or v5's own check when the value changes on the way.
 */
const V5_KEYS: ReadonlyMap<string, string | ((value: unknown) => boolean)> = new Map(
  Object.entries({
    enabledProviders: (value) => value === "auto" || Array.isArray(value),
    quotaProviders: "providers.custom",
    anthropicBinaryPath: "providers.anthropic.binaryPath",
    cursorPlan: "providers.cursor.plan",
    cursorIncludedApiUsd: "providers.cursor.includedApiUsd",
    cursorBillingCycleStartDay: "providers.cursor.billingCycleStartDay",
    opencodeMonthlyLimit: "providers.opencode.monthlyLimitUsd",
    minIntervalMs: "providers.checking.minIntervalMs",
    requestTimeoutMs: "providers.checking.requestTimeoutMs",
    waitForQuotaReset: "providers.checking.waitForQuotaReset",
    accountingDetail: "words.detail",
    onlyCurrentModel: "words.onlyCurrentModel",
    sessionTokenScope: "words.sessionTokens",
    "pricingSnapshot.source": "providers.pricing.source",
    "pricingSnapshot.autoRefresh": "providers.pricing.autoRefreshDays",
    "export.enabled": "system.exportFile",
    "export.path": "system.exportPath",
    "telemetry.enabled": "system.telemetry",
    percentDisplayMode: oneOf("remaining", "used"),
    percentLabelStyle: oneOf("full", "bare"),
    quotaProjection: oneOf("runway"),
    resetTimeDecimals: (value) => checkSetting("words.resetDecimals", value).issues.length === 0,
    resetTimeSpaced: isBoolean,
    // Removed in v5 but still translated (the rule lived in `update`, which v6 removed).
    opencodeZenDisplay: () => true,
    "resetNotifications.enabled": isBoolean,
    "resetNotifications.windows": isListOf(
      oneOf("fiveHour", "hourly", "daily", "weekly", "monthly", "yearly"),
    ),
    enableToast: isBoolean,
    showOnIdle: isBoolean,
    showOnQuestion: isBoolean,
    showOnCompact: isBoolean,
    showOnBothFail: isBoolean,
    toastDurationMs: (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
    showSessionTokens: isBoolean,
    opencodeGoWindows: isListOf(oneOf("rolling", "weekly", "monthly")),
    "tuiSidebarPanel.enabled": isBoolean,
    "tuiSidebarPanel.opencodeGoPreferredWindow": oneOf("rolling", "weekly", "monthly"),
    "tuiCompactStatus.enabled": isBoolean,
    "tuiCompactStatus.homeBottom": isBoolean,
    "tuiCompactStatus.sessionPrompt": isBoolean,
    "tuiPromptBar.enabled": isBoolean,
  }),
);

/** v5's nested groups, e.g. "tuiSidebarPanel". */
const V5_GROUPS: ReadonlySet<string> = new Set(
  [...V5_KEYS.keys(), ...DROPPED.keys(), ...SILENT].flatMap((key) =>
    key.includes(".") ? [key.split(".")[0]] : [],
  ),
);

/** v5 display keys that moved as they are (or through `map`) to the tab sections. */
const DISPLAY_MOVES: ReadonlyArray<[string, string[], ((value: unknown) => unknown)?]> = [
  ["enableToast", ["toast.show"]],
  ["showOnIdle", ["toast.afterReply"], (value) => (value ? "always" : "off")],
  ["showOnQuestion", ["toast.afterQuestion"]],
  ["showOnCompact", ["toast.afterCompaction"]],
  ["showOnBothFail", ["toast.whenAllFail"]],
  ["toastDurationMs", ["toast.seconds"], (ms) => Math.max(1, Math.round(Number(ms) / 1000))],
  ["showSessionTokens", ["sidebar.sessionTokens", "toast.sessionTokens"]],
  ["tuiSidebarPanel.enabled", ["sidebar.show"]],
];

/** v5's OpenCode Go window names → v6 row ids and collapsed-sidebar windows. */
const GO_WINDOWS = [
  { v5: "rolling", row: "opencode-go.five_hour", window: "five_hour" },
  { v5: "weekly", row: "opencode-go.weekly", window: "week" },
  { v5: "monthly", row: "opencode-go.monthly", window: "month" },
] as const;

const SURFACES: readonly DisplaySurface[] = ["sidebar", "collapsed", "statusLine", "toast"];

type JsonFile = { state: "missing" } | { state: "invalid" } | { state: "parsed"; value: unknown };

/** v5 read `.json` and `.jsonc` alike: comments and trailing commas allowed. */
async function readJsonFile(path: string): Promise<JsonFile> {
  if (!existsSync(path)) return { state: "missing" };
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return { state: "invalid" };
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  return errors.length > 0 ? { state: "invalid" } : { state: "parsed", value };
}

function quotaToastBlock(value: unknown): Record<string, unknown> | undefined {
  const block = isRecord(value) && isRecord(value.experimental) && value.experimental.quotaToast;
  return isRecord(block) ? block : undefined;
}

type V5Source = { path: string; raw: Record<string, unknown> };
type V5Files = { sources: V5Source[]; notes: string[]; malformed: boolean; sidecarSeen: boolean };

/**
 * v5's global files: the first sidecar that parses is authoritative (the other sidecar and
 * `experimental.quotaToast` are ignored); without one, `experimental.quotaToast` from
 * opencode.json, then opencode.jsonc.
 */
async function readV5GlobalFiles(configDir: string): Promise<V5Files> {
  const sidecars = SIDECAR_NAMES.map((name) => join(configDir, "opencode-quota", name));
  const hostFiles = HOST_FILE_NAMES.map((name) => join(configDir, name));
  const notes: string[] = [];
  let malformed = false;
  let sidecarSeen = false;

  for (const path of sidecars) {
    const file = await readJsonFile(path);
    if (file.state === "missing") continue;
    sidecarSeen = true;
    if (file.state === "invalid" || !isRecord(file.value)) {
      malformed = true;
      notes.push(`${path} does not parse as a JSON object, so it was not converted`);
      continue;
    }
    if (path === sidecars[0] && existsSync(sidecars[1])) {
      notes.push(`${sidecars[1]} was not converted: v5 used ${path} when both exist`);
    }
    for (const hostPath of hostFiles) {
      const host = await readJsonFile(hostPath);
      if (host.state === "parsed" && quotaToastBlock(host.value)) {
        notes.push(
          `experimental.quotaToast in ${hostPath} was not converted: v5 ignored it while ${path} exists`,
        );
      }
    }
    return { sources: [{ path, raw: file.value }], notes, malformed, sidecarSeen };
  }

  const sources: V5Source[] = [];
  for (const path of hostFiles) {
    const file = await readJsonFile(path);
    if (file.state === "missing") continue;
    if (file.state === "invalid") {
      malformed = true;
      notes.push(`${path} does not parse, so its experimental.quotaToast was not converted`);
      continue;
    }
    const block = quotaToastBlock(file.value);
    if (block) sources.push({ path: `${path} (experimental.quotaToast)`, raw: block });
  }
  return { sources, notes, malformed, sidecarSeen };
}

/**
 * The folders that can hold old global settings, in the order v4 read them: OpenCode's global
 * folder, then macOS's ~/.config and ~/Library/Application Support, Windows's %APPDATA% and
 * %LOCALAPPDATA%, or ~/.config elsewhere. OPENCODE_CONFIG_DIR replaces them all, as in OpenCode 2.
 */
export function oldSettingsFolders(
  configDir: string,
  params: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string[] {
  const env = params.env ?? process.env;
  if (env.OPENCODE_CONFIG_DIR?.trim()) return [configDir];
  const home = params.homeDir ?? homedir();
  const platform = params.platform ?? process.platform;
  const older =
    platform === "win32"
      ? [
          join(env.APPDATA?.trim() || join(home, "AppData", "Roaming"), "opencode"),
          join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "opencode"),
        ]
      : platform === "darwin"
        ? [
            join(home, ".config", "opencode"),
            join(home, "Library", "Application Support", "opencode"),
          ]
        : [join(home, ".config", "opencode")];
  return [...new Set([configDir, ...older])];
}

/** True when a folder has quota settings: a quotaToast block, or a sidecar (even a broken one). */
function hasQuotaSettings(files: V5Files): boolean {
  return files.sources.length > 0 || files.sidecarSeen;
}

/** A v5 object as dotted keys; v5's nested groups are opened one level deep. */
function flattenV5(raw: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(raw).flatMap(([key, value]): Array<[string, unknown]> =>
    V5_GROUPS.has(key) && isRecord(value)
      ? Object.entries(value).map(([name, child]): [string, unknown] => [`${key}.${name}`, child])
      : [[key, value]],
  );
}

/**
 * The valid v5 values in the order v5 applied them. Each file is checked before it layers, so a
 * bad later value never replaces a good one.
 */
function readV5Values(sources: readonly V5Source[]): {
  values: Map<string, unknown>;
  dropped: SkippedKey[];
  invalid: SkippedKey[];
} {
  const values = new Map<string, unknown>();
  const dropped: SkippedKey[] = [];
  const invalid: SkippedKey[] = [];
  for (const source of sources) {
    for (const [key, value] of flattenV5(source.raw)) {
      const check = V5_KEYS.get(key);
      const droppedReason = DROPPED.get(key);
      if (SILENT.has(key)) continue;
      if (droppedReason) {
        dropped.push({ key, reason: droppedReason });
      } else if (V5_GROUPS.has(key)) {
        invalid.push({ key, reason: "expected an object" });
      } else if (!check) {
        dropped.push({ key, reason: "not a v5 setting" });
      } else if (typeof check === "function") {
        if (check(value)) {
          if (key === "enabledProviders" && value !== "auto") {
            const checked = checkSetting("providers.off", value);
            for (const issue of checked.issues) invalid.push({ key, reason: issue.message });
            if (checked.value !== undefined) values.set(key, checked.value);
            else if (!values.has(key)) values.set(key, []);
          } else values.set(key, value);
        } else invalid.push({ key, reason: `${JSON.stringify(value)} was not valid in v5 either` });
      } else {
        // v5 took no null; v6 reads null as "unset", which would erase an earlier file's value.
        const v5Rejects = { issues: [{ key: check, message: "null was not valid in v5 either" }] };
        const checked: CheckedSetting = value === null ? v5Rejects : checkSetting(check, value);
        for (const issue of checked.issues) {
          invalid.push({ key: issue.key.replace(check, key), reason: issue.message });
        }
        // A valid value is written as the user wrote it (a normalized custom provider fails a
        // second check); a partly valid one as checked.
        if (checked.issues.length === 0) values.set(key, value);
        else if (checked.value !== undefined) values.set(key, checked.value);
        // v5: a list of only unknown ids showed nothing, unless an earlier file set a list.
        else if (key === "enabledProviders" && !values.has(key)) values.set(key, []);
      }
    }
  }
  return { values, dropped, invalid };
}

/** Where every valid v5 value goes. */
function mapV5Values(values: ReadonlyMap<string, unknown>): {
  server: Record<string, unknown>;
  converted: ConvertedKey[];
  dropped: SkippedKey[];
} {
  const server: Record<string, unknown> = {};
  const converted: ConvertedKey[] = [];
  const dropped: SkippedKey[] = [];

  const has = (key: string) => values.has(key);
  const chosen = <T>(key: string, fallback: T): T =>
    values.has(key) ? (values.get(key) as T) : fallback;
  const toServer = (key: string, to: string, value: unknown, note?: string) => {
    server[to] = value;
    converted.push({ key, to, where: "server", ...(note ? { note } : {}) });
  };

  for (const [key, to] of V5_KEYS) {
    if (typeof to === "string" && has(key)) toServer(key, to, values.get(key));
  }

  if (has("enabledProviders")) {
    const enabled = values.get("enabledProviders");
    const off =
      enabled === "auto" ? [] : PROVIDER_IDS.filter((id) => !(enabled as string[]).includes(id));
    toServer("enabledProviders", "providers.off", off);
  }

  const percentKeys = ["percentDisplayMode", "percentLabelStyle"].filter(has);
  if (percentKeys.length > 0) {
    const used = chosen<string>("percentDisplayMode", "remaining") === "used";
    const bare = chosen<string>("percentLabelStyle", "full") === "bare";
    const note = used && bare ? 'v6 has no bare "used" percent; it shows "42% used"' : undefined;
    for (const key of percentKeys) {
      toServer(key, "words.percent", used ? "used" : bare ? "bare" : "left", note);
    }
  }

  const resetKeys = ["resetTimeDecimals", "resetTimeSpaced"].filter(has);
  if (resetKeys.length > 0) {
    const decimals = values.get("resetTimeDecimals");
    const spaced = chosen("resetTimeSpaced", true);
    const reset = decimals !== undefined ? "decimal" : spaced ? "exact" : "compact";
    for (const key of resetKeys) toServer(key, "words.reset", reset);
    if (decimals !== undefined) server["words.resetDecimals"] = decimals;
  }

  // The TUI switches retain the v5 pace choice; text reports always show pace.
  if (has("quotaProjection")) {
    for (const name of SURFACES) toServer("quotaProjection", `${name}.runsOut`, true);
  }

  if (has("opencodeZenDisplay")) {
    const zen = values.get("opencodeZenDisplay");
    if (has("accountingDetail")) {
      dropped.push({ key: "opencodeZenDisplay", reason: "accountingDetail is set and wins" });
    } else if (zen === "default" || zen === "detailed") {
      toServer("opencodeZenDisplay", "words.detail", zen === "default" ? "summary" : "detailed");
    } else {
      dropped.push({ key: "opencodeZenDisplay", reason: 'expected "default" or "detailed"' });
    }
  }

  for (const [key, targets, map] of DISPLAY_MOVES) {
    if (!has(key)) continue;
    for (const to of targets) toServer(key, to, map ? map(values.get(key)) : values.get(key));
  }

  const resetNoticeKeys = ["resetNotifications.enabled", "resetNotifications.windows"].filter(has);
  if (resetNoticeKeys.length > 0) {
    const enabled = chosen("resetNotifications.enabled", false);
    const windows = chosen<string[]>("resetNotifications.windows", ["weekly"]);
    const onlyWeekly = windows.length === 1 && windows[0] === "weekly";
    server["toast.resetNotice"] = !enabled ? "off" : onlyWeekly ? "weekly" : "all";
    const note =
      enabled && !onlyWeekly
        ? `v6 notifies for weekly limits or for every limit; ${windows.join(", ")} became every limit`
        : undefined;
    for (const key of resetNoticeKeys)
      toServer(key, "toast.resetNotice", server["toast.resetNotice"], note);
  }

  if (has("tuiSidebarPanel.opencodeGoPreferredWindow")) {
    const v5Window = values.get("tuiSidebarPanel.opencodeGoPreferredWindow");
    const go = GO_WINDOWS.find((entry) => entry.v5 === v5Window);
    if (go) server["collapsed.window"] = { "opencode-go": go.window };
    toServer(
      "tuiSidebarPanel.opencodeGoPreferredWindow",
      "collapsed.window",
      server["collapsed.window"],
      "v5 ignored this setting; the collapsed sidebar uses it now",
    );
  }

  const statusKeys = [
    "tuiCompactStatus.enabled",
    "tuiCompactStatus.homeBottom",
    "tuiCompactStatus.sessionPrompt",
    "tuiPromptBar.enabled",
  ].filter(has);
  if (statusKeys.length > 0) {
    // What v5 showed, with v5's defaults for the keys the user did not set. Each v6 key is
    // written only when the user set a v5 key it comes from; the others keep the v6 default.
    // sessionPrompt and homeBottom changed nothing while the compact line was off, v5's
    // default, so they count only with tuiCompactStatus.enabled.
    const compact = chosen("tuiCompactStatus.enabled", false);
    const promptBar = chosen("tuiPromptBar.enabled", false);
    const sessionPrompt = chosen("tuiCompactStatus.sessionPrompt", true);
    const show = promptBar || (compact && sessionPrompt);
    const home = compact && chosen("tuiCompactStatus.homeBottom", true);
    const compactOnly = ["tuiCompactStatus.sessionPrompt", "tuiCompactStatus.homeBottom"];
    const counted = has("tuiCompactStatus.enabled")
      ? statusKeys
      : statusKeys.filter((key) => !compactOnly.includes(key));
    for (const key of statusKeys.filter((other) => !counted.includes(other))) {
      dropped.push({
        key,
        reason: "v5 used it only while tuiCompactStatus.enabled was on, which you did not set",
      });
    }
    const showFrom = counted.filter((key) => key !== "tuiCompactStatus.homeBottom");
    const homeFrom = counted.filter(
      (key) => key === "tuiCompactStatus.enabled" || key === "tuiCompactStatus.homeBottom",
    );
    const toStatusLine = (to: string, value: unknown, from: readonly string[]) => {
      for (const key of from) toServer(key, to, value);
    };
    toStatusLine("statusLine.show", show, showFrom);
    // v5 showed its status line next to the sidebar panel.
    if (show) toStatusLine("statusLine.withSidebar", true, showFrom);
    toStatusLine("statusLine.home", home, homeFrom);
    if (promptBar) toStatusLine("statusLine.detail", "one", ["tuiPromptBar.enabled"]);
  }

  if (has("opencodeGoWindows")) {
    const kept = chosen<string[]>("opencodeGoWindows", []);
    const hidden = GO_WINDOWS.filter((go) => !kept.includes(go.v5)).map((go) => go.row);
    for (const name of SURFACES)
      toServer(
        "opencodeGoWindows",
        `${name}.hidden`,
        hidden,
        "the other OpenCode Go windows are hidden now, not removed: export and the quota window's Limits tab still list them",
      );
  }
  return { server, converted, dropped };
}

function firstPerKey(list: readonly SkippedKey[]): SkippedKey[] {
  const seen = new Set<string>();
  return list.filter((item) => !seen.has(item.key) && seen.add(item.key));
}

/**
 * The old global settings converted in memory (nothing is written), or undefined when none: those
 * of the first of `folders` that has quota settings. Old settings in a later folder are named in a
 * note. An OpenCode config that does not parse is named too; with no quota settings anywhere, its
 * folder is the one converted, so nothing is written until it is fixed.
 */
export async function planV5Conversion(
  configDir: string,
  folders: readonly string[] = oldSettingsFolders(configDir),
): Promise<V5Conversion | undefined> {
  let files: V5Files | undefined;
  let from = "";
  /** The first folder whose OpenCode config does not parse and has no other quota settings. */
  let unparsed: V5Files | undefined;
  const skipped: string[] = [];
  for (const folder of folders) {
    const found = await readV5GlobalFiles(folder);
    if (!hasQuotaSettings(found)) {
      if (found.malformed) unparsed ??= found;
      continue;
    }
    if (files) skipped.push(folder);
    else [files, from] = [found, folder];
  }
  if (!files) files = unparsed;
  else if (unparsed) files.notes.push(...unparsed.notes);
  if (!files) return undefined;
  for (const folder of skipped) {
    files.notes.push(`the old settings in ${folder} were not converted: ${from} has some too`);
  }

  const read = readV5Values(files.sources);
  const mapped = mapV5Values(read.values);
  const values = Object.fromEntries(
    Object.keys(SETTINGS_SCHEMA)
      .filter((key) => Object.hasOwn(mapped.server, key))
      .map((key) => [key, mapped.server[key]]),
  );
  const checked = settingsFrom(Object.entries(values).map(([key, value]) => ({ key, value })));
  return {
    sources: files.sources.map((source) => source.path),
    malformed: files.malformed,
    written: false,
    values,
    settings: checked.settings,
    fromFile: checked.fromFile,
    converted: mapped.converted,
    dropped: firstPerKey([...read.dropped, ...mapped.dropped]),
    invalid: firstPerKey(read.invalid),
    notes: files.notes,
  };
}

/** True for a key v5 had: one v6 converts, drops, ignores, or a v5 group ("tuiSidebarPanel"). */
export function isV5SettingKey(key: string): boolean {
  return V5_KEYS.has(key) || DROPPED.has(key) || SILENT.has(key) || V5_GROUPS.has(key);
}

/**
 * v5 settings files that exist but v6 does not read: the global sidecars (also in the older
 * folders) once settings.jsonc exists, and every project-scope file (v6 has no project settings).
 * A project in the global folder or an older one has no project files of its own.
 */
export async function findUnreadV5Files(
  configDir: string,
  options: { includeGlobal: boolean; projectDir?: string },
): Promise<string[]> {
  const globalFolders = oldSettingsFolders(configDir);
  const globalSidecars = globalFolders.flatMap((folder) =>
    SIDECAR_NAMES.map((name) => join(folder, "opencode-quota", name)),
  );
  const unread = options.includeGlobal ? globalSidecars.filter((path) => existsSync(path)) : [];
  const projectDir = options.projectDir;
  if (!projectDir) return unread;

  const projectSidecars = SIDECAR_NAMES.map((name) => join(projectDir, "opencode-quota", name));
  for (const path of projectSidecars) {
    if (!globalSidecars.includes(path) && existsSync(path)) unread.push(path);
  }
  for (const name of HOST_FILE_NAMES) {
    const path = join(projectDir, name);
    if (globalFolders.some((folder) => path === join(folder, name))) continue;
    const file = await readJsonFile(path);
    if (file.state === "parsed" && quotaToastBlock(file.value)) {
      unread.push(`${path} (experimental.quotaToast)`);
    }
  }
  return unread;
}
