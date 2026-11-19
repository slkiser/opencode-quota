/**
 * Server settings checks over the shared rules in `display.ts`: provider definitions and ids,
 * paths, JSONC assignments and the settings the RPC exposes to clients.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Node } from "jsonc-parser";
import { getNodeValue } from "jsonc-parser";
import { ALL_PROVIDERS } from "../core/windows.js";
import { isRecord } from "../lib/json-guards.js";
import { normalizeQuotaProviderId, QUOTA_PROVIDER_CATALOG } from "../lib/provider-metadata.js";
import {
  describeQuotaProviderRequest,
  isRetiredEstimateTuning,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  type QuotaProviderDefinition,
  validateQuotaProviders,
} from "../lib/quota-providers.js";
import {
  checkValue,
  defaultSettings as sharedDefaultSettings,
  SETTINGS_SCHEMA,
  type SettingRule,
  type Settings as SharedSettings,
} from "./display.js";
import {
  CHANGED_SINCE_REVIEW,
  RECORD_KINDS,
  setPath,
  THEME_COLOR_NAMES,
  UNSET_IS_NOT_DEFAULT,
} from "./shared.js";

export {
  CHANGED_SINCE_REVIEW,
  SETTINGS_SCHEMA,
  type SettingRule,
  setPath,
  THEME_COLOR_NAMES,
  UNSET_IS_NOT_DEFAULT,
};

const RULES: Readonly<Record<string, SettingRule>> = SETTINGS_SCHEMA;

export type Settings = SharedSettings<QuotaProviderDefinition>;
export const defaultSettings = sharedDefaultSettings<QuotaProviderDefinition>;

type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> | null }
    : T;
/** A JSON merge patch of the settings: objects merge, null resets a key or a whole group. */
export type SettingsPatch = Patch<Settings>;

/** Every key that holds other settings, e.g. "providers" and "providers.cursor". */
const GROUPS: ReadonlySet<string> = new Set(
  Object.keys(RULES).flatMap((key) => {
    const parts = key.split(".");
    return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("."));
  }),
);

export function isSettingsGroup(key: string): boolean {
  return GROUPS.has(key);
}

/** Whether `key` is a file-only setting or a group that holds one. */
export function isFileOnly(key: string): boolean {
  return Object.entries(RULES).some(
    ([name, rule]) => rule.fileOnly === true && (name === key || name.startsWith(`${key}.`)),
  );
}

/** The names directly inside `group` ("" = the top level), in file order. */
export function keysUnder(group: string): string[] {
  const prefix = group ? `${group}.` : "";
  const names = Object.keys(RULES)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length).split(".")[0]);
  return [...new Set(names)];
}

/**
 * A provider's id as `providers.off` stores it: the same id, except "custom" for the custom
 * providers, which the registry and their rows call "quota-providers".
 */
export function offProviderId(providerId: string): string {
  return providerId === QUOTA_PROVIDERS_AGGREGATE_ID ? "custom" : providerId;
}

/** Provider ids `providers.off` accepts; `custom` switches all custom providers off. */
export const PROVIDER_IDS: readonly string[] =
  Object.keys(QUOTA_PROVIDER_CATALOG).map(offProviderId);

/**
 * Built-in provider ids of 4.x and 5.x that this version does not have. `providers.off` and the
 * v5 conversion drop them without an issue, so settings from then still load clean.
 */
const FORMER_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "chutes",
  "kilo",
  "nanogpt",
  "nano-gpt",
  "synthetic",
]);

/** A provider id or one of its aliases ("claude", "quota-providers") as `providers.off` stores it. */
function canonicalProviderId(id: string): string | undefined {
  const canonical = offProviderId(normalizeQuotaProviderId(id));
  return PROVIDER_IDS.includes(canonical) ? canonical : undefined;
}

/** What a rule accepts, in words, for issue messages and the agent tools. */
export function describeRule(rule: SettingRule): string {
  switch (rule.kind) {
    case "boolean":
      return "true or false";
    case "choice":
      return `one of: ${rule.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "number": {
      const kind = rule.integer ? "a whole number" : "a number";
      const bounds =
        rule.min !== undefined && rule.max !== undefined
          ? rule.min === rule.max
            ? ` equal to ${rule.min}`
            : ` from ${rule.min} to ${rule.max}`
          : rule.above !== undefined
            ? ` above ${rule.above}`
            : rule.min !== undefined
              ? ` of at least ${rule.min}`
              : "";
      const word = rule.word === undefined ? "" : `${JSON.stringify(rule.word)} or `;
      return `${word}${rule.nullable ? "null or " : ""}${kind}${bounds}`;
    }
    case "path": {
      const or = rule.allowEmpty ? '"" or ' : rule.allowCommand ? "a command name or " : "";
      return `${or}an absolute or ~/ path without ".."`;
    }
    case "providers":
      return `a list of: ${PROVIDER_IDS.join(", ")}`;
    case "customProviders":
      return "a list of custom provider definitions";
    case "strings":
      return "a list of strings";
    case "names":
      return "an object of row ids and names";
    case "rowOrder":
      return "an object of provider ids and lists of row ids";
    case "window":
      return `an object of provider ids (or "${ALL_PROVIDERS}" for every provider) and quota windows or lowest`;
    case "color":
      return "a theme color, bar, or #rrggbb";
    case "separator":
      return `a string of at most ${rule.maxLength} characters`;
  }
}

export type SettingsIssue = { key: string; message: string };

/** A checked value: `value` to use when present, and what was wrong with it. */
export type CheckedSetting = { value?: unknown; issues: SettingsIssue[] };

/** An absolute or `~/` path with no `..` part, so it never depends on a working folder. */
function isSafePath(path: string): boolean {
  return (isAbsolute(path) || /^~[\\/]/u.test(path)) && !path.split(/[\\/]/u).includes("..");
}

function checkProviders(key: string, value: unknown): CheckedSetting {
  if (!Array.isArray(value)) {
    return { issues: [{ key, message: `expected ${describeRule(RULES[key])}` }] };
  }
  const known: string[] = [];
  const unknown: string[] = [];
  value.forEach((item, index) => {
    const id = typeof item === "string" ? canonicalProviderId(item) : undefined;
    const former =
      typeof item === "string" && FORMER_PROVIDER_IDS.has(normalizeQuotaProviderId(item));
    // Anything but a string is named by its position, so no name inside it is repeated.
    if (id) known.push(id);
    else if (!former) unknown.push(typeof item === "string" ? item : `item ${index + 1}`);
  });
  if (unknown.length === 0) return { value: [...new Set(known)], issues: [] };
  const message = `unknown provider id(s): ${unknown.join(", ")}; valid: ${PROVIDER_IDS.join(", ")}`;
  const issues = [{ key, message }];
  // Keep valid ids; a list of only unknown ids uses the empty default.
  return known.length > 0 ? { value: [...new Set(known)], issues } : { issues };
}

function checkCustomProviders(key: string, value: unknown): CheckedSetting {
  const result = validateQuotaProviders(value);
  if (result.value) return { value: result.value, issues: [] };
  return {
    issues: result.issues.map((issue) => ({
      key: issue.key.replace(/^quotaProviders/u, key),
      message: issue.message,
    })),
  };
}

export function isRecordSetting(key: string): boolean {
  const kind = Object.hasOwn(RULES, key) ? RULES[key].kind : undefined;
  return kind !== undefined && RECORD_KINDS.includes(kind);
}

/** Checks one value against its rule; `key` must be in SETTINGS_SCHEMA. */
export function checkSetting(key: string, value: unknown): CheckedSetting {
  const rule = Object.hasOwn(RULES, key) ? RULES[key] : undefined;
  if (!rule) return { issues: [{ key, message: "unknown setting" }] };
  const invalid = { issues: [{ key, message: `expected ${describeRule(rule)}` }] };
  switch (rule.kind) {
    case "path": {
      if (typeof value !== "string") return invalid;
      const path = value.trim();
      const isCommand = rule.allowCommand === true && /^\w[\w.-]*$/u.test(path);
      const valid = path === "" ? rule.allowEmpty === true : isCommand || isSafePath(path);
      return valid ? { value: path, issues: [] } : invalid;
    }
    case "providers":
      return checkProviders(key, value);
    case "customProviders":
      return checkCustomProviders(key, value);
    default: {
      const checked = checkValue(rule, value);
      return Object.hasOwn(checked, "value")
        ? { value: checked.value, issues: checked.valid ? [] : invalid.issues }
        : invalid;
    }
  }
}

/** The issue key for the top level of a file or patch, which has no settings key of its own. */
const TOP_LEVEL_KEY = "$top";

/** A name at `position` (from 1) in `group` ("" for the top level) that is not a setting. */
function unknownKeyIssue(group: string, position: number): SettingsIssue {
  const where = group ? ` in ${group}` : "";
  return {
    key: group || TOP_LEVEL_KEY,
    message: `unknown setting (key ${position}); valid${where}: ${keysUnder(group).join(", ")}`,
  };
}

/** One `key: value` a file or a patch sets, in the order it sets them. */
type Assignment = { key: string; value: unknown };

/** How to walk a value: plain JSON values, or jsonc-parser nodes (which keep duplicate keys). */
type Walker<T> = {
  entries(value: T): Array<[string, T]> | undefined;
  leaf(value: T): unknown;
};

export const PLAIN_WALKER: Walker<unknown> = {
  entries: (value) => (isRecord(value) ? Object.entries(value) : undefined),
  leaf: (value) => value,
};

export const NODE_WALKER: Walker<Node> = {
  entries: (node) => {
    if (node.type !== "object") return undefined;
    const pairs: Array<[string, Node]> = [];
    for (const property of node.children ?? []) {
      const [name, value] = property.children ?? [];
      // A half-written property; the parse error already says where it is.
      if (name?.type === "string" && value) pairs.push([String(name.value), value]);
    }
    return pairs;
  },
  leaf: getNodeValue,
};

/** A file sets a key twice: reading uses the last valid value, saving refuses. */
export const DUPLICATE_KEY = "duplicate key; the last valid value is used";
/** A name with a dot ("words.percent") is not read (settings nest), and saving refuses it. */
export const DOTTED_KEY = "a key with a dot is not read";

/**
 * The settings an object sets, as dotted keys in order. Unknown, duplicate and dotted keys
 * become issues; a group set to something other than an object becomes an assignment of the group
 * key, so the caller decides (an issue when reading, a reset when a patch says null). An issue
 * names a settings key, or the position of a name that is not one: a name that is not a setting
 * is never repeated, so a secret typed as a key name stays out of every message.
 */
export function flattenSettings<T>(
  walker: Walker<T>,
  value: T,
  prefix = "",
): { assignments: Assignment[]; issues: SettingsIssue[] } {
  const assignments: Assignment[] = [];
  const issues: SettingsIssue[] = [];
  const names = new Set<string>();
  for (const [index, [name, child]] of (walker.entries(value) ?? []).entries()) {
    const key = prefix ? `${prefix}.${name}` : name;
    const isSetting = Object.hasOwn(RULES, key) || GROUPS.has(key);
    if (isSetting && names.has(name)) issues.push({ key, message: DUPLICATE_KEY });
    names.add(name);
    if (name.includes(".")) {
      issues.push({
        key: prefix || TOP_LEVEL_KEY,
        message: `${DOTTED_KEY} (key ${index + 1}); nest it instead`,
      });
    } else if (Object.hasOwn(RULES, key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else if (GROUPS.has(key) && walker.entries(child)) {
      const nested = flattenSettings(walker, child, key);
      assignments.push(...nested.assignments);
      issues.push(...nested.issues);
    } else if (GROUPS.has(key)) {
      assignments.push({ key, value: walker.leaf(child) });
    } else {
      issues.push(unknownKeyIssue(prefix, index + 1));
    }
  }
  return { assignments, issues };
}

function getSetting(settings: Settings, key: string): unknown {
  let value: unknown = settings;
  for (const part of key.split(".")) value = isRecord(value) ? value[part] : undefined;
  return value;
}

/**
 * The defaults with every valid assignment applied in order. An invalid value is reported and
 * changes nothing, so a bad value later in the file never replaces a good one before it.
 */
export function settingsFrom(assignments: readonly Assignment[]): {
  settings: Settings;
  issues: SettingsIssue[];
  fromFile: string[];
} {
  const settings = defaultSettings();
  const issues: SettingsIssue[] = [];
  const fromFile = new Set<string>();
  for (const { key, value } of assignments) {
    if (GROUPS.has(key)) {
      issues.push({ key, message: "expected an object" });
      continue;
    }
    const checked = checkSetting(key, value);
    issues.push(...checked.issues);
    if (checked.value === undefined) continue;
    setPath(settings, key, checked.value);
    fromFile.add(key);
  }
  // The warning level stays at or above the low level, as the display settings require.
  settings.colors.warningBelow = Math.max(settings.colors.warningBelow, settings.colors.lowBelow);
  return { settings, issues, fromFile: [...fromFile] };
}

/**
 * Every setting whose value differs between `before` and `after`. With the keys each file sets,
 * a setting in `UNSET_IS_NOT_DEFAULT` the file does not set is null, so setting it to its
 * default or removing it is a change too.
 */
export function diffSettings(
  before: Settings,
  after: Settings,
  fromFile?: { before: readonly string[]; after: readonly string[] },
): Array<{ key: string; before: unknown; after: unknown }> {
  const valueOf = (settings: Settings, keys: readonly string[] | undefined, key: string) =>
    keys !== undefined && UNSET_IS_NOT_DEFAULT.has(key) && !keys.includes(key)
      ? null
      : getSetting(settings, key);
  return Object.keys(RULES)
    .map((key) => ({
      key,
      before: valueOf(before, fromFile?.before, key),
      after: valueOf(after, fromFile?.after, key),
    }))
    .filter((change) => JSON.stringify(change.before) !== JSON.stringify(change.after));
}

/** A custom provider as the quota window's Providers tab shows it, with its on/off switch. */
export type CustomProviderSwitch = {
  id: string;
  label: string;
  enabled: boolean;
  /** Where it sends its key, and which key; null for a local estimate, which sends nothing. */
  request: ReturnType<typeof describeQuotaProviderRequest>;
  /** `customProviderFingerprint`: switching it on sends it back, so it is this definition. */
  fingerprint: string;
};

/**
 * A hash of what the user checks before switching a custom provider on (`request`) and of the
 * fields that decide where its request goes and which key it reads.
 */
export function customProviderFingerprint(definition: QuotaProviderDefinition): string {
  const { mode, providerId } = definition;
  const sent =
    definition.mode === "remote-api" ? [definition.url, definition.apiKeyEnv ?? null] : [];
  const seen = [describeQuotaProviderRequest(definition), mode, providerId, ...sent];
  return createHash("sha256").update(JSON.stringify(seen)).digest("hex");
}

/** The file settings a client shows and edits in the quota window. */
export type ClientSettings = {
  /** Every setting but `version` and the file-only ones, by dotted key ("words.percent"). */
  values: Record<string, unknown>;
  /**
   * The keys of `values` that settings.jsonc sets, with an invalid value too (shown as its
   * default); the others follow their defaults.
   */
  fromFile: string[];
  /** The ids `providers.off` takes, with their names. */
  providers: Array<{ id: string; label: string }>;
  /** The custom providers in settings.jsonc, without the retired estimate's leftover tuning. */
  custom: CustomProviderSwitch[];
};

/** `fromFile` and `issues` as `loadSettings` returns them. */
export function clientSettings({
  settings,
  fromFile: fileKeys,
  issues,
}: {
  settings: Settings;
  fromFile: readonly string[];
  issues: readonly SettingsIssue[];
}): ClientSettings {
  const values = Object.fromEntries(
    Object.keys(RULES)
      .filter(
        (key) => key !== "version" && !isFileOnly(key) && getSetting(settings, key) !== undefined,
      )
      .map((key) => [key, getSetting(settings, key)]),
  );
  const providers = PROVIDER_IDS.map((id) => ({
    id,
    label:
      id === "custom"
        ? "Custom providers"
        : QUOTA_PROVIDER_CATALOG[id as keyof typeof QUOTA_PROVIDER_CATALOG].label,
  }));
  const custom = settings.providers.custom
    .filter((definition) => !isRetiredEstimateTuning(definition))
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      enabled: definition.enabled !== false,
      request: describeQuotaProviderRequest(definition),
      fingerprint: customProviderFingerprint(definition),
    }));
  // An invalid value's issue names its key, so Reset can remove it with its problem.
  const setKeys = new Set([...fileKeys, ...issues.map((issue) => issue.key)]);
  const fromFile = [...setKeys].filter((key) => Object.hasOwn(values, key));
  return { values, fromFile, providers, custom };
}
