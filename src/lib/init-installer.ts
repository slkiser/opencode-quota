import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import {
  applyConfigDocumentEdit,
  planConfigDocumentEdit,
  validateConfigDocumentEdit,
  type ConfigDocumentEdit,
} from "./opencode-config-editor.js";
import {
  dedupeNonEmptyStrings,
  extractPluginSpecsFromParsedConfig,
  getPluginSpecFromEntry,
  isQuotaPluginSpec,
  resolveEditableConfigPath,
  findGitWorktreeRoot,
  type ConfigFileFormat,
  type EditableConfigPath,
} from "./config-file-utils.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import {
  QUOTA_PROVIDER_SHAPES,
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
} from "./provider-metadata.js";
import {
  getQuotaFormatStyleLabel,
  isQuotaFormatStyle,
  resolveQuotaFormatStyle,
  type CanonicalQuotaFormatStyle,
} from "./quota-format-style.js";
import {
  getQuotaToastConfigPath,
  QUOTA_TOAST_CONFIG_RELATIVE_PATH,
  QUOTA_TOAST_CONFIG_RELATIVE_PATHS,
} from "./config.js";
import type { QuotaToastConfig, SessionTokenScope, TuiCommandDisplay } from "./types.js";

const QUOTA_PLUGIN_SPEC = "@slkiser/opencode-quota@latest";
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const TUI_SCHEMA_URL = "https://opencode.ai/tui.json";
const GITHUB_REPO_URL = "https://github.com/slkiser/opencode-quota";
const GITHUB_STAR_NOTE = `if this helps, stars are appreciated: ${GITHUB_REPO_URL}`;
const TUI_COMMAND_DISPLAY_COMMENT =
  "// OpenCode Quota: tuiCommandDisplay chooses whether native TUI command output appears in the session transcript or a local popup dialog.";

export type InitInstallerInterface = "tui" | "web" | "both";
export type InitInstallerScope = "project" | "global";
export type InitQuotaUiChoice = "toast" | "sidebar" | "compact_status" | "none";
export type InitQuotaUi = readonly InitQuotaUiChoice[];
export type InitProviderMode = "auto" | "manual";

export interface InitInstallerSelections {
  interfaces: InitInstallerInterface;
  scope: InitInstallerScope;
  quotaUi: InitQuotaUi;
  providerMode: InitProviderMode;
  manualProviders: string[];
  formatStyle: CanonicalQuotaFormatStyle;
  percentDisplayMode: QuotaToastConfig["percentDisplayMode"];
  showSessionTokens: boolean;
  sessionTokenScope?: SessionTokenScope;
  tuiCommandDisplay?: TuiCommandDisplay;
  maintainerAnnouncements?: boolean;
  configFormat?: ConfigFileFormat;
}

export interface InitInstallerQuickSetupNote {
  providerId: string;
  label: string;
  anchor: string;
}

export interface PlannedConfigEdit {
  kind: "opencode" | "tui" | "quota";
  path: string;
  existed: boolean;
  format: ConfigFileFormat;
  changed: boolean;
  addedPlugins: string[];
  addedKeys: string[];
  updatedKeys: string[];
  valueChanges: string[];
  skippedValues: string[];
  warnings: string[];
  nextData?: Record<string, unknown>;
  plannedData?: Record<string, unknown>;
  documentEdit?: ConfigDocumentEdit;
}

export interface InitInstallerPlan {
  selections: InitInstallerSelections;
  baseDir: string;
  edits: PlannedConfigEdit[];
  warnings: string[];
  quickSetupNotes: InitInstallerQuickSetupNote[];
  summaryLines: string[];
}

export interface ApplyInitInstallerPlanResult {
  writtenPaths: string[];
  unchangedPaths: string[];
}

export class InitInstallerError extends Error {
  constructor(
    message: string,
    readonly details?: {
      path?: string;
      writtenPaths?: string[];
    },
  ) {
    super(message);
    this.name = "InitInstallerError";
  }
}

type JsonObject = Record<string, unknown>;

type PromptOption = {
  label: string;
  value: string;
  hint?: string;
};

type NormalizedQuotaUiIntent = {
  choices: InitQuotaUiChoice[];
  enableToast: boolean;
  installTuiPlugin: boolean;
  enableSidebarPanel: boolean;
  enableCompactStatus: boolean;
};

type PromptAdapter = {
  intro: (message: string) => void;
  outro: (message: string) => void;
  select: (options: {
    message: string;
    options: PromptOption[];
    initialValue?: string;
  }) => Promise<unknown>;
  multiselect: (options: {
    message: string;
    required?: boolean;
    options: PromptOption[];
    initialValues?: string[];
  }) => Promise<unknown>;
  confirm: (options: { message: string; initialValue?: boolean }) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
  log: {
    info: (message: string) => void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
};

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const QUOTA_UI_CHOICE_ORDER: InitQuotaUiChoice[] = ["sidebar", "toast", "compact_status", "none"];

function normalizeQuotaUiIntent(selections: InitInstallerSelections): NormalizedQuotaUiIntent {
  const rawSelections = selections as unknown as Record<string, unknown>;
  if (hasOwnKey(rawSelections, "tuiCompactStatus")) {
    throw new InitInstallerError("Unsupported installer selection: tuiCompactStatus");
  }

  const quotaUi = rawSelections.quotaUi;
  if (!Array.isArray(quotaUi)) {
    throw new InitInstallerError("Quota UI selections must be an array.");
  }
  if (quotaUi.length === 0) {
    throw new InitInstallerError("Quota UI selections must not be empty.");
  }

  const seen = new Set<InitQuotaUiChoice>();
  for (const rawChoice of quotaUi) {
    if (
      typeof rawChoice !== "string" ||
      !QUOTA_UI_CHOICE_ORDER.includes(rawChoice as InitQuotaUiChoice)
    ) {
      throw new InitInstallerError(`Unknown Quota UI option: ${String(rawChoice)}`);
    }
    seen.add(rawChoice as InitQuotaUiChoice);
  }

  if (seen.has("none") && seen.size > 1) {
    throw new InitInstallerError(
      "Manual commands only cannot be combined with automatic quota displays.",
    );
  }

  const choices = QUOTA_UI_CHOICE_ORDER.filter((choice) => seen.has(choice));

  const enableSidebarPanel = choices.includes("sidebar");
  const enableCompactStatus = choices.includes("compact_status");

  return {
    choices,
    enableToast: choices.includes("toast"),
    installTuiPlugin: selections.interfaces !== "web",
    enableSidebarPanel,
    enableCompactStatus,
  };
}

function getUiLabel(choices: readonly InitQuotaUiChoice[]): string {
  const labels = choices.map((choice) => {
    if (choice === "toast") return "Toast";
    if (choice === "sidebar") return "Sidebar";
    if (choice === "compact_status") return "Compact status";
    return "Manual commands only";
  });
  return labels.join(" + ");
}

function getProviderModeLabel(mode: InitProviderMode): string {
  return mode === "manual" ? "Manual" : "Auto-detect";
}

function getPercentDisplayModeLabel(mode: QuotaToastConfig["percentDisplayMode"]): string {
  return mode === "used" ? "Used" : "Remaining";
}

function resolveRequestedProviders(selections: InitInstallerSelections): string[] | "auto" {
  if (selections.providerMode === "auto") {
    return "auto";
  }

  const normalized = dedupeNonEmptyStrings(
    selections.manualProviders
      .map((providerId) => normalizeQuotaProviderId(providerId))
      .filter((providerId) => QUOTA_PROVIDER_SHAPES.some((shape) => shape.id === providerId)),
  );

  if (normalized.length === 0) {
    throw new InitInstallerError("Manual provider mode requires at least one supported provider.");
  }

  return normalized;
}

function pickFormatStyleToWrite(params: {
  quotaToast: JsonObject;
  selectedFormatStyle: CanonicalQuotaFormatStyle;
}): CanonicalQuotaFormatStyle {
  if (isQuotaFormatStyle(params.quotaToast.toastStyle)) {
    return resolveQuotaFormatStyle(params.quotaToast.toastStyle);
  }

  return params.selectedFormatStyle;
}

function pushSkippedIfChanged(
  edit: PlannedConfigEdit,
  pathLabel: string,
  existingValue: unknown,
  desiredValue: unknown,
): void {
  if (!jsonEqual(existingValue, desiredValue)) {
    edit.skippedValues.push(`${pathLabel} preserved existing value`);
  }
}

function ensureSchema(root: JsonObject, schemaUrl: string, edit: PlannedConfigEdit): void {
  if (!hasOwnKey(root, "$schema")) {
    root.$schema = schemaUrl;
    edit.changed = true;
    edit.addedKeys.push("$schema");
    return;
  }

  pushSkippedIfChanged(edit, "$schema", root.$schema, schemaUrl);
}

function appendQuotaPluginIfMissing(params: {
  container: unknown[];
  pathLabel: string;
  kind: "opencode" | "tui";
  edit: PlannedConfigEdit;
}): void {
  const alreadyConfigured = params.container.some((entry) => {
    const spec = getPluginSpecFromEntry(entry);
    return typeof spec === "string" && isQuotaPluginSpec(spec, params.kind);
  });

  if (alreadyConfigured) {
    params.edit.skippedValues.push(`${params.pathLabel} already includes ${QUOTA_PLUGIN_SPEC}`);
    return;
  }

  params.container.push(QUOTA_PLUGIN_SPEC);
  params.edit.changed = true;
  params.edit.addedPlugins.push(`${params.pathLabel}: ${QUOTA_PLUGIN_SPEC}`);
}

function ensureTopLevelPluginArray(root: JsonObject, edit: PlannedConfigEdit): unknown[] {
  if (!hasOwnKey(root, "plugin")) {
    const next: unknown[] = [];
    root.plugin = next;
    edit.changed = true;
    return next;
  }

  if (!Array.isArray(root.plugin)) {
    throw new InitInstallerError(
      `Cannot update ${edit.kind} config because plugin is not an array.`,
      { path: edit.path },
    );
  }

  return root.plugin;
}

function ensureTuiPluginArray(
  root: JsonObject,
  edit: PlannedConfigEdit,
): {
  container: unknown[];
  pathLabel: string;
} {
  if (isPlainObject(root.tui) && hasOwnKey(root.tui, "plugin")) {
    const tuiRoot = root.tui as JsonObject;
    if (!Array.isArray(tuiRoot.plugin)) {
      throw new InitInstallerError(
        `Cannot update ${edit.kind} config because tui.plugin is not an array.`,
        { path: edit.path },
      );
    }

    return {
      container: tuiRoot.plugin,
      pathLabel: "tui.plugin",
    };
  }

  if (hasOwnKey(root, "plugin")) {
    if (!Array.isArray(root.plugin)) {
      throw new InitInstallerError(
        `Cannot update ${edit.kind} config because plugin is not an array.`,
        { path: edit.path },
      );
    }

    return {
      container: root.plugin,
      pathLabel: "plugin",
    };
  }

  const next: unknown[] = [];
  root.plugin = next;
  edit.changed = true;
  return {
    container: next,
    pathLabel: "plugin",
  };
}

function addSettingIfMissing(
  target: JsonObject,
  key: string,
  value: unknown,
  pathLabel: string,
  edit: PlannedConfigEdit,
): void {
  if (!hasOwnKey(target, key)) {
    target[key] = value;
    edit.changed = true;
    edit.addedKeys.push(pathLabel);
    return;
  }

  pushSkippedIfChanged(edit, pathLabel, target[key], value);
}

function setInstallerOwnedSetting(
  target: JsonObject,
  key: string,
  value: unknown,
  pathLabel: string,
  edit: PlannedConfigEdit,
): void {
  if (!hasOwnKey(target, key)) {
    target[key] = value;
    edit.changed = true;
    edit.addedKeys.push(pathLabel);
    return;
  }

  if (!jsonEqual(target[key], value)) {
    const previousValue = target[key];
    target[key] = value;
    edit.changed = true;
    edit.updatedKeys.push(pathLabel);
    edit.valueChanges.push(
      `${pathLabel}: ${JSON.stringify(previousValue)} -> ${JSON.stringify(value)}`,
    );
  }
}

function planTuiSidebarPanelConfig(params: {
  quotaToast: JsonObject;
  quotaUiIntent: NormalizedQuotaUiIntent;
  edit: PlannedConfigEdit;
}): void {
  const pathLabel = "quotaToast.tuiSidebarPanel";
  let tuiSidebarPanel: JsonObject;
  if (!hasOwnKey(params.quotaToast, "tuiSidebarPanel")) {
    tuiSidebarPanel = {};
    params.quotaToast.tuiSidebarPanel = tuiSidebarPanel;
  } else if (isPlainObject(params.quotaToast.tuiSidebarPanel)) {
    tuiSidebarPanel = params.quotaToast.tuiSidebarPanel;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    tuiSidebarPanel,
    "enabled",
    params.quotaUiIntent.enableSidebarPanel,
    `${pathLabel}.enabled`,
    params.edit,
  );
}

function planMaintainerAnnouncementsConfig(params: {
  quotaToast: JsonObject;
  selections: InitInstallerSelections;
  edit: PlannedConfigEdit;
}): void {
  if (params.selections.maintainerAnnouncements === undefined) {
    return;
  }

  const enabled = params.selections.maintainerAnnouncements;

  const pathLabel = "quotaToast.maintainerAnnouncements";
  let maintainerAnnouncements: JsonObject;
  if (!hasOwnKey(params.quotaToast, "maintainerAnnouncements")) {
    maintainerAnnouncements = {};
    params.quotaToast.maintainerAnnouncements = maintainerAnnouncements;
  } else if (isPlainObject(params.quotaToast.maintainerAnnouncements)) {
    maintainerAnnouncements = params.quotaToast.maintainerAnnouncements;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    maintainerAnnouncements,
    "enabled",
    enabled,
    `${pathLabel}.enabled`,
    params.edit,
  );

  if (enabled) {
    setInstallerOwnedSetting(
      maintainerAnnouncements,
      "home",
      true,
      `${pathLabel}.home`,
      params.edit,
    );
  }
}

function planTuiCompactStatusConfig(params: {
  quotaToast: JsonObject;
  quotaUiIntent: NormalizedQuotaUiIntent;
  edit: PlannedConfigEdit;
}): void {
  const hasExistingCompactStatus = hasOwnKey(params.quotaToast, "tuiCompactStatus");
  if (!params.quotaUiIntent.enableCompactStatus && !hasExistingCompactStatus) {
    return;
  }

  const pathLabel = "quotaToast.tuiCompactStatus";
  let tuiCompactStatus: JsonObject;
  if (!hasExistingCompactStatus) {
    tuiCompactStatus = {};
    params.quotaToast.tuiCompactStatus = tuiCompactStatus;
  } else if (isPlainObject(params.quotaToast.tuiCompactStatus)) {
    tuiCompactStatus = params.quotaToast.tuiCompactStatus;
  } else {
    params.edit.warnings.push(`${pathLabel} is not an object; preserved existing value.`);
    return;
  }

  setInstallerOwnedSetting(
    tuiCompactStatus,
    "enabled",
    params.quotaUiIntent.enableCompactStatus,
    `${pathLabel}.enabled`,
    params.edit,
  );

  if (!params.quotaUiIntent.enableCompactStatus) {
    return;
  }

  setInstallerOwnedSetting(
    tuiCompactStatus,
    "homeBottom",
    true,
    `${pathLabel}.homeBottom`,
    params.edit,
  );
  setInstallerOwnedSetting(
    tuiCompactStatus,
    "sessionPrompt",
    true,
    `${pathLabel}.sessionPrompt`,
    params.edit,
  );
  setInstallerOwnedSetting(
    tuiCompactStatus,
    "suppressWhenNativeProviderQuota",
    true,
    `${pathLabel}.suppressWhenNativeProviderQuota`,
    params.edit,
  );
}

async function readExistingConfig(params: {
  path: string;
  format: ConfigFileFormat;
}): Promise<JsonObject> {
  try {
    const content = await readFile(params.path, "utf-8");
    const parsed = parseJsonOrJsonc(content, params.format === "jsonc");
    if (!isPlainObject(parsed)) {
      throw new InitInstallerError("Existing config root must be a JSON object.", {
        path: params.path,
      });
    }

    return parsed as JsonObject;
  } catch (error) {
    if (error instanceof InitInstallerError) {
      throw error;
    }

    throw new InitInstallerError(`Failed to parse ${basename(params.path)}.`, {
      path: params.path,
    });
  }
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return cloneJsonValue(value);
}

async function readLegacyQuotaToastSeed(baseDir: string): Promise<JsonObject | null> {
  const target = resolveEditableConfigPath({ dir: baseDir, kind: "opencode" });
  if (!target.existed) {
    return null;
  }

  const root = await readExistingConfig({
    path: target.sourcePath,
    format: target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
  });
  const experimental = isPlainObject(root.experimental) ? root.experimental : null;
  const quotaToast =
    experimental && isPlainObject(experimental.quotaToast) ? experimental.quotaToast : null;
  return quotaToast ? cloneJsonObject(quotaToast) : null;
}

function buildQuickSetupNotes(selections: InitInstallerSelections): InitInstallerQuickSetupNote[] {
  if (selections.providerMode !== "manual") {
    return [];
  }

  const requestedProviders = resolveRequestedProviders(selections);
  if (requestedProviders === "auto") {
    return [];
  }

  return requestedProviders
    .map((providerId) => QUOTA_PROVIDER_SHAPES.find((shape) => shape.id === providerId))
    .filter((shape): shape is (typeof QUOTA_PROVIDER_SHAPES)[number] =>
      Boolean(shape?.quickSetupAnchor && shape.autoSetup === "needs_quick_setup"),
    )
    .map((shape) => ({
      providerId: shape.id,
      label: getQuotaProviderDisplayLabel(shape.id),
      anchor: shape.quickSetupAnchor!,
    }));
}

function syncLegacyQuotaToast(params: {
  root: JsonObject;
  quotaToast: JsonObject;
  edit: PlannedConfigEdit;
}): void {
  if (Object.keys(params.quotaToast).length === 0) {
    return;
  }

  let experimental: JsonObject;
  if (!hasOwnKey(params.root, "experimental")) {
    experimental = {};
    params.root.experimental = experimental;
  } else if (isPlainObject(params.root.experimental)) {
    experimental = params.root.experimental;
  } else {
    throw new InitInstallerError(
      "Cannot sync legacy config because experimental is not an object.",
      { path: params.edit.path },
    );
  }

  let legacyQuotaToast: JsonObject;
  if (!hasOwnKey(experimental, "quotaToast")) {
    legacyQuotaToast = {};
    experimental.quotaToast = legacyQuotaToast;
  } else if (isPlainObject(experimental.quotaToast)) {
    legacyQuotaToast = experimental.quotaToast;
  } else {
    throw new InitInstallerError(
      "Cannot sync legacy config because experimental.quotaToast is not an object.",
      { path: params.edit.path },
    );
  }

  let changed = false;
  for (const [key, value] of Object.entries(params.quotaToast)) {
    if (!jsonEqual(legacyQuotaToast[key], value)) {
      legacyQuotaToast[key] = cloneJsonValue(value);
      changed = true;
    }
  }

  if (changed) {
    params.edit.changed = true;
    params.edit.addedKeys.push(
      "experimental.quotaToast (synced from opencode-quota/quota-toast.json)",
    );
  }
}

async function planOpencodeEdit(params: {
  selections: InitInstallerSelections;
  baseDir: string;
  legacyQuotaToastToSync?: JsonObject;
}): Promise<PlannedConfigEdit> {
  const target = resolveEditableConfigPath({
    dir: params.baseDir,
    kind: "opencode",
    preferredFormat: params.selections.configFormat ?? "jsonc",
    convertJsonToJsonc: true,
  });
  const edit: PlannedConfigEdit = {
    kind: "opencode",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    updatedKeys: [],
    valueChanges: [],
    skippedValues: [],
    warnings: [],
  };

  const root = target.existed
    ? await readExistingConfig({
        path: target.sourcePath,
        format: target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
      })
    : {};

  if (!target.existed) {
    ensureSchema(root, OPENCODE_SCHEMA_URL, edit);
  }

  const plugin = ensureTopLevelPluginArray(root, edit);
  appendQuotaPluginIfMissing({
    container: plugin,
    pathLabel: "plugin",
    kind: "opencode",
    edit,
  });

  if (params.legacyQuotaToastToSync) {
    syncLegacyQuotaToast({
      root,
      quotaToast: params.legacyQuotaToastToSync,
      edit,
    });
  }

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: root,
    managedComments: [
      {
        path: ["plugin"],
        text: TUI_COMMAND_DISPLAY_COMMENT,
      },
      {
        path: ["plugin"],
        text: "// OpenCode Quota: loads the server plugin for slash commands and quota checks.",
      },
    ],
  });
  edit.changed = documentEdit.changed;
  edit.documentEdit = documentEdit;

  return edit;
}

function resolveQuotaConfigTarget(
  baseDir: string,
  preferredFormat: ConfigFileFormat,
): EditableConfigPath {
  const jsoncPath = getQuotaToastConfigPath(baseDir, "jsonc");
  if (existsSync(jsoncPath)) {
    return {
      path: jsoncPath,
      sourcePath: jsoncPath,
      format: "jsonc",
      existed: true,
    };
  }

  const jsonPath = getQuotaToastConfigPath(baseDir, "json");
  if (existsSync(jsonPath)) {
    if (preferredFormat === "jsonc") {
      return {
        path: jsoncPath,
        sourcePath: jsonPath,
        removeSourcePath: jsonPath,
        format: "jsonc",
        existed: true,
      };
    }
    return {
      path: jsonPath,
      sourcePath: jsonPath,
      format: "json",
      existed: true,
    };
  }

  const path = getQuotaToastConfigPath(baseDir, preferredFormat);
  return {
    path,
    sourcePath: path,
    format: preferredFormat,
    existed: false,
  };
}

async function planQuotaConfigEdit(params: {
  selections: InitInstallerSelections;
  quotaUiIntent: NormalizedQuotaUiIntent;
  baseDir: string;
}): Promise<PlannedConfigEdit> {
  const target = resolveQuotaConfigTarget(
    params.baseDir,
    params.selections.configFormat ?? "jsonc",
  );
  const edit: PlannedConfigEdit = {
    kind: "quota",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    updatedKeys: [],
    valueChanges: [],
    skippedValues: [],
    warnings: [],
  };
  if (
    target.path.endsWith(".jsonc") &&
    existsSync(getQuotaToastConfigPath(params.baseDir, "json"))
  ) {
    edit.warnings.push(
      "Both quota-toast.jsonc and quota-toast.json exist; using JSONC and preserving the JSON file.",
    );
  }

  const legacyQuotaToast = target.existed ? null : await readLegacyQuotaToastSeed(params.baseDir);
  const quotaToast = target.existed
    ? await readExistingConfig({
        path: target.sourcePath,
        format: target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
      })
    : legacyQuotaToast
      ? cloneJsonObject(legacyQuotaToast)
      : {};

  if (!target.existed) {
    edit.addedKeys.push(
      legacyQuotaToast
        ? `${target.path.endsWith(".jsonc") ? QUOTA_TOAST_CONFIG_RELATIVE_PATHS[0] : QUOTA_TOAST_CONFIG_RELATIVE_PATH} (seeded from experimental.quotaToast)`
        : target.path.endsWith(".jsonc")
          ? QUOTA_TOAST_CONFIG_RELATIVE_PATHS[0]
          : QUOTA_TOAST_CONFIG_RELATIVE_PATH,
    );
  }

  setInstallerOwnedSetting(
    quotaToast,
    "enableToast",
    params.quotaUiIntent.enableToast,
    "quotaToast.enableToast",
    edit,
  );
  if (params.selections.tuiCommandDisplay !== undefined) {
    setInstallerOwnedSetting(
      quotaToast,
      "tuiCommandDisplay",
      params.selections.tuiCommandDisplay,
      "quotaToast.tuiCommandDisplay",
      edit,
    );
  }
  setInstallerOwnedSetting(
    quotaToast,
    "showSessionTokens",
    params.selections.showSessionTokens,
    "quotaToast.showSessionTokens",
    edit,
  );
  setInstallerOwnedSetting(
    quotaToast,
    "sessionTokenScope",
    params.selections.sessionTokenScope ?? "current",
    "quotaToast.sessionTokenScope",
    edit,
  );
  const requestedProviders = resolveRequestedProviders(params.selections);
  const enabledProviders =
    requestedProviders !== "auto" &&
    Array.isArray(quotaToast.enabledProviders) &&
    quotaToast.enabledProviders.includes(QUOTA_PROVIDERS_AGGREGATE_ID)
      ? [...requestedProviders, QUOTA_PROVIDERS_AGGREGATE_ID]
      : requestedProviders;
  setInstallerOwnedSetting(
    quotaToast,
    "enabledProviders",
    enabledProviders,
    "quotaToast.enabledProviders",
    edit,
  );
  setInstallerOwnedSetting(
    quotaToast,
    "formatStyle",
    params.selections.formatStyle,
    "quotaToast.formatStyle",
    edit,
  );
  setInstallerOwnedSetting(
    quotaToast,
    "percentDisplayMode",
    params.selections.percentDisplayMode,
    "quotaToast.percentDisplayMode",
    edit,
  );
  planTuiSidebarPanelConfig({
    quotaToast,
    quotaUiIntent: params.quotaUiIntent,
    edit,
  });
  planTuiCompactStatusConfig({
    quotaToast,
    quotaUiIntent: params.quotaUiIntent,
    edit,
  });
  planMaintainerAnnouncementsConfig({
    quotaToast,
    selections: params.selections,
    edit,
  });

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: quotaToast,
    managedComments: [
      {
        path: ["enableToast"],
        text: "// Automatic quota surfaces. Slash commands remain available when these are disabled.",
      },
      {
        path: ["enabledProviders"],
        text: '// Provider selection: "auto" detects providers; an array tracks only listed providers.',
      },
      {
        path: ["formatStyle"],
        text: "// Quota presentation and reset-period choices.",
      },
      {
        path: ["showSessionTokens"],
        text: "// Include or hide session input and output token totals.",
      },
      {
        path: ["sessionTokenScope"],
        text: '// Session token totals: "current" session only, or "tree" including descendants.',
      },
      {
        path: ["tuiSidebarPanel"],
        text: "// TUI-only surfaces.",
      },
      {
        path: ["maintainerAnnouncements"],
        text: "// Optional bundled maintainer Home announcements.",
      },
    ],
  });
  edit.changed = documentEdit.changed;
  edit.documentEdit = documentEdit;
  edit.plannedData = quotaToast;

  return edit;
}

function getCanonicalQuotaPackageSpecForRemoval(entry: unknown): string | undefined {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : undefined;
  if (spec === "@slkiser/opencode-quota") return spec;
  if (
    spec !== undefined &&
    /^@slkiser\/opencode-quota@(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[A-Za-z][0-9A-Za-z._-]*)$/.test(
      spec,
    )
  ) {
    return spec;
  }
  return undefined;
}

function removeQuotaPluginsFromTui(root: JsonObject, edit: PlannedConfigEdit): void {
  const containers: Array<{ value: unknown; pathLabel: string }> = [
    { value: root.plugin, pathLabel: "plugin" },
  ];
  if (isPlainObject(root.tui)) {
    containers.push({ value: root.tui.plugin, pathLabel: "tui.plugin" });
  }

  for (const container of containers) {
    if (!Array.isArray(container.value)) continue;
    const retained = container.value.filter((entry) => {
      const spec = getCanonicalQuotaPackageSpecForRemoval(entry);
      if (spec !== undefined) {
        edit.updatedKeys.push(`${container.pathLabel}: remove ${spec}`);
        return false;
      }
      return true;
    });
    if (retained.length !== container.value.length) {
      container.value.splice(0, container.value.length, ...retained);
      edit.changed = true;
    }
  }
}

async function planTuiEdit(params: {
  selections: InitInstallerSelections;
  baseDir: string;
}): Promise<PlannedConfigEdit> {
  const target = resolveEditableConfigPath({
    dir: params.baseDir,
    kind: "tui",
    preferredFormat: params.selections.configFormat ?? "jsonc",
    convertJsonToJsonc: params.selections.interfaces !== "web",
  });
  const edit: PlannedConfigEdit = {
    kind: "tui",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    updatedKeys: [],
    valueChanges: [],
    skippedValues: [],
    warnings: [],
  };

  if (params.selections.interfaces === "web" && !target.existed) {
    return edit;
  }

  const root = target.existed
    ? await readExistingConfig({
        path: target.sourcePath,
        format: target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
      })
    : {};
  if (!target.existed) {
    ensureSchema(root, TUI_SCHEMA_URL, edit);
  }

  if (params.selections.interfaces === "web") {
    removeQuotaPluginsFromTui(root, edit);
  } else {
    const existingPluginSpecs = extractPluginSpecsFromParsedConfig(root);
    if (existingPluginSpecs.some((spec) => isQuotaPluginSpec(spec, "tui"))) {
      edit.skippedValues.push(`tui config already includes ${QUOTA_PLUGIN_SPEC}`);
    } else {
      const pluginTarget = ensureTuiPluginArray(root, edit);
      appendQuotaPluginIfMissing({
        container: pluginTarget.container,
        pathLabel: pluginTarget.pathLabel,
        kind: "tui",
        edit,
      });
    }
  }

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: root,
    managedComments:
      params.selections.interfaces === "web"
        ? []
        : [
            {
              path: ["plugin"],
              text: TUI_COMMAND_DISPLAY_COMMENT,
            },
            {
              path: ["plugin"],
              text: "// OpenCode Quota: loads the TUI sidebar, compact status, and local commands.",
            },
          ],
  });
  edit.changed = documentEdit.changed;
  edit.documentEdit = documentEdit;

  return edit;
}

function buildPlanSummary(plan: InitInstallerPlan): string[] {
  const quotaUiIntent = normalizeQuotaUiIntent(plan.selections);
  const opencodeFormat =
    plan.edits.find((edit) => edit.kind === "opencode")?.format ??
    plan.selections.configFormat ??
    "jsonc";
  const lines: string[] = [
    `Interface: ${plan.selections.interfaces === "tui" ? "TUI" : plan.selections.interfaces === "web" ? "Web" : "Both"}`,
    `Scope: ${plan.selections.scope} (${plan.baseDir})`,
    `Config format: ${opencodeFormat.toUpperCase()}`,
  ];

  if (plan.selections.interfaces !== "web") {
    lines.push(`TUI surfaces: ${getUiLabel(quotaUiIntent.choices)}`);
    lines.push(
      `Command display: ${plan.selections.tuiCommandDisplay === "inline" ? "Inline with messages" : "Popup dialog"}`,
    );
  }

  lines.push(
    `Provider mode: ${getProviderModeLabel(plan.selections.providerMode)}`,
    `Quota reset periods: ${getQuotaFormatStyleLabel(plan.selections.formatStyle)}`,
    `Quota percentage meaning: ${getPercentDisplayModeLabel(plan.selections.percentDisplayMode)}`,
    `Session input/output tokens: ${plan.selections.showSessionTokens ? "Show" : "Hide"}`,
    `Session token scope: ${plan.selections.sessionTokenScope === "tree" ? "Current session and descendants" : "Current session"}`,
  );

  if (plan.selections.maintainerAnnouncements !== undefined) {
    lines.push(
      `Maintainer announcements: ${plan.selections.maintainerAnnouncements ? "Enabled" : "Disabled"}`,
    );
  }

  if (quotaUiIntent.enableCompactStatus) {
    lines.push("Compact status mode: Home bottom + session prompt");
  }

  const requestedProviders = resolveRequestedProviders(plan.selections);
  if (requestedProviders !== "auto") {
    lines.push(
      `Manual providers: ${requestedProviders.map((providerId) => getQuotaProviderDisplayLabel(providerId)).join(", ")}`,
    );
  }

  for (const edit of plan.edits) {
    const convertedFrom = edit.documentEdit?.removeSourcePath;
    const mode = convertedFrom
      ? "convert"
      : !edit.existed
        ? "create"
        : edit.changed
          ? "update"
          : "unchanged";
    lines.push(
      convertedFrom ? `${mode}: ${convertedFrom} -> ${edit.path}` : `${mode}: ${edit.path}`,
    );

    for (const plugin of edit.addedPlugins) {
      lines.push(`  + plugin ${plugin}`);
    }
    for (const key of edit.addedKeys) {
      lines.push(`  + ${key}`);
    }
    for (const key of edit.updatedKeys) {
      lines.push(`  ~ ${key}`);
    }
    for (const change of edit.valueChanges) {
      lines.push(`    ${change}`);
    }
    for (const skipped of edit.skippedValues) {
      lines.push(`  = ${skipped}`);
    }
    for (const warning of edit.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  if (plan.quickSetupNotes.length > 0) {
    lines.push("Quick setup reminders:");
    for (const note of plan.quickSetupNotes) {
      lines.push(`  - ${note.label}: README.md#${note.anchor}`);
    }
  }

  if (plan.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of plan.warnings) {
      lines.push(`  ! ${warning}`);
    }
  }

  return lines;
}

export function getInstallerProviderPromptOptions(): PromptOption[] {
  return QUOTA_PROVIDER_SHAPES.map((shape) => ({
    label:
      shape.autoSetup === "needs_quick_setup"
        ? `${getQuotaProviderDisplayLabel(shape.id)} (quick setup)`
        : getQuotaProviderDisplayLabel(shape.id),
    value: shape.id,
  }));
}

export function resolveInitInstallerBaseDir(params: {
  scope: InitInstallerScope;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  if (params.scope === "global") {
    const candidates = getOpencodeRuntimeDirCandidates({
      env: params.env,
      homeDir: params.homeDir,
    });
    return candidates.configDirs[0]!;
  }

  const cwd = params.cwd ?? process.cwd();
  return findGitWorktreeRoot(cwd) ?? cwd;
}

export async function planInitInstaller(params: {
  selections: InitInstallerSelections;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  syncLegacyConfig?: boolean;
}): Promise<InitInstallerPlan> {
  const requestedSelections: InitInstallerSelections = {
    ...params.selections,
    quotaUi: params.selections.interfaces === "web" ? ["none"] : params.selections.quotaUi,
  };
  const quotaUiIntent = normalizeQuotaUiIntent(requestedSelections);
  const selections: InitInstallerSelections = {
    ...requestedSelections,
    configFormat: params.selections.configFormat ?? "jsonc",
    quotaUi: quotaUiIntent.choices,
    tuiCommandDisplay:
      params.selections.interfaces === "web"
        ? undefined
        : (params.selections.tuiCommandDisplay ?? "inline"),
    maintainerAnnouncements: params.selections.maintainerAnnouncements,
    manualProviders:
      params.selections.providerMode === "manual"
        ? (resolveRequestedProviders(params.selections) as string[])
        : [],
  };
  const baseDir = resolveInitInstallerBaseDir({
    scope: selections.scope,
    cwd: params.cwd,
    env: params.env,
    homeDir: params.homeDir,
  });
  const quotaEdit = await planQuotaConfigEdit({ selections, quotaUiIntent, baseDir });
  const edits = [
    await planOpencodeEdit({
      selections,
      baseDir,
      legacyQuotaToastToSync: params.syncLegacyConfig ? quotaEdit.plannedData : undefined,
    }),
    quotaEdit,
  ];
  const tuiEdit = await planTuiEdit({ selections, baseDir });
  if (selections.interfaces !== "web" || tuiEdit.existed) {
    edits.push(tuiEdit);
  }

  const quickSetupNotes = buildQuickSetupNotes(selections);
  const warnings = edits.flatMap((edit) => edit.warnings);

  const plan: InitInstallerPlan = {
    selections,
    baseDir,
    edits,
    warnings,
    quickSetupNotes,
    summaryLines: [],
  };
  plan.summaryLines = buildPlanSummary(plan);
  return plan;
}

export async function applyInitInstallerPlan(
  plan: InitInstallerPlan,
): Promise<ApplyInitInstallerPlanResult> {
  const writtenPaths: string[] = [];
  const unchangedPaths: string[] = [];

  try {
    await Promise.all(
      plan.edits.flatMap((edit) =>
        edit.documentEdit ? [validateConfigDocumentEdit(edit.documentEdit)] : [],
      ),
    );
  } catch (error) {
    const path =
      error && typeof error === "object" && "path" in error
        ? String((error as { path?: unknown }).path ?? "")
        : "";
    throw new InitInstallerError(`Config changed since preview${path ? `: ${path}` : "."}`, {
      path: path || undefined,
      writtenPaths,
    });
  }

  for (const edit of plan.edits) {
    if (!edit.changed || (!edit.nextData && !edit.documentEdit)) {
      unchangedPaths.push(edit.path);
      continue;
    }

    try {
      if (edit.documentEdit) {
        await applyConfigDocumentEdit(edit.documentEdit);
      } else {
        await writeJsonAtomic(edit.path, edit.nextData, { trailingNewline: true });
      }
      writtenPaths.push(edit.path);
    } catch (error) {
      throw new InitInstallerError(`Failed writing ${edit.path}.`, {
        path: edit.path,
        writtenPaths,
      });
    }
  }

  return {
    writtenPaths,
    unchangedPaths,
  };
}

type ExistingInstallerAnswers = {
  configFormat?: ConfigFileFormat;
  quotaUi?: InitQuotaUiChoice[];
  providerMode?: InitProviderMode;
  manualProviders?: string[];
  formatStyle?: CanonicalQuotaFormatStyle;
  percentDisplayMode?: QuotaToastConfig["percentDisplayMode"];
  showSessionTokens?: boolean;
  sessionTokenScope?: SessionTokenScope;
  tuiCommandDisplay?: TuiCommandDisplay;
  maintainerAnnouncements?: boolean;
};

async function readExistingInstallerAnswers(baseDir: string): Promise<ExistingInstallerAnswers> {
  const existingQuotaPath = QUOTA_TOAST_CONFIG_RELATIVE_PATHS.map((relativePath) =>
    join(baseDir, relativePath),
  ).find((path) => existsSync(path));
  const existingHostPath = ["opencode.jsonc", "opencode.json"]
    .map((name) => join(baseDir, name))
    .find((path) => existsSync(path));
  const answers: ExistingInstallerAnswers = {
    configFormat:
      existingQuotaPath?.endsWith(".jsonc") || existingHostPath?.endsWith(".jsonc")
        ? "jsonc"
        : existingQuotaPath || existingHostPath
          ? "json"
          : undefined,
  };
  if (!existingQuotaPath) return answers;

  const quotaToast = await readExistingConfig({
    path: existingQuotaPath,
    format: existingQuotaPath.endsWith(".jsonc") ? "jsonc" : "json",
  });
  const quotaUi: InitQuotaUiChoice[] = [];
  if (isPlainObject(quotaToast.tuiSidebarPanel) && quotaToast.tuiSidebarPanel.enabled === true) {
    quotaUi.push("sidebar");
  }
  if (quotaToast.enableToast === true) quotaUi.push("toast");
  if (isPlainObject(quotaToast.tuiCompactStatus) && quotaToast.tuiCompactStatus.enabled === true) {
    quotaUi.push("compact_status");
  }
  answers.quotaUi = quotaUi.length > 0 ? quotaUi : ["none"];

  if (quotaToast.enabledProviders === "auto") {
    answers.providerMode = "auto";
    answers.manualProviders = [];
  } else if (Array.isArray(quotaToast.enabledProviders)) {
    answers.providerMode = "manual";
    answers.manualProviders = quotaToast.enabledProviders.filter(
      (value): value is string =>
        typeof value === "string" &&
        QUOTA_PROVIDER_SHAPES.some((shape) => shape.id === normalizeQuotaProviderId(value)),
    );
  }
  if (isQuotaFormatStyle(quotaToast.formatStyle)) {
    answers.formatStyle = resolveQuotaFormatStyle(quotaToast.formatStyle);
  }
  if (quotaToast.percentDisplayMode === "remaining" || quotaToast.percentDisplayMode === "used") {
    answers.percentDisplayMode = quotaToast.percentDisplayMode;
  }
  if (typeof quotaToast.showSessionTokens === "boolean") {
    answers.showSessionTokens = quotaToast.showSessionTokens;
  }
  if (quotaToast.sessionTokenScope === "current" || quotaToast.sessionTokenScope === "tree") {
    answers.sessionTokenScope = quotaToast.sessionTokenScope;
  }
  if (quotaToast.tuiCommandDisplay === "inline" || quotaToast.tuiCommandDisplay === "dialog") {
    answers.tuiCommandDisplay = quotaToast.tuiCommandDisplay;
  }
  if (
    isPlainObject(quotaToast.maintainerAnnouncements) &&
    typeof quotaToast.maintainerAnnouncements.enabled === "boolean"
  ) {
    answers.maintainerAnnouncements = quotaToast.maintainerAnnouncements.enabled;
  }
  return answers;
}

async function promptForSelections(
  prompts: PromptAdapter,
  context: { cwd?: string; env?: NodeJS.ProcessEnv; homeDir?: string },
): Promise<InitInstallerSelections | null> {
  const interfaces = await prompts.select({
    message: "Which OpenCode interfaces do you use?",
    options: [
      { label: "TUI", value: "tui", hint: "terminal interface" },
      { label: "Web", value: "web", hint: "browser interface" },
      {
        label: "Both",
        value: "both",
        hint: "configure terminal and browser interfaces",
      },
    ],
  });
  if (prompts.isCancel(interfaces)) return null;

  if (interfaces === "web") {
    prompts.log.info(
      "Web slash commands appear inline. TUI-only surfaces and popup dialogs are unavailable.",
    );
  }

  const scope = await prompts.select({
    message: "Where should OpenCode Quota be configured?",
    initialValue: "global",
    options: [
      {
        label: "Global OpenCode config (recommended)",
        value: "global",
        hint: "install for all projects using your global config",
      },
      { label: "Project config", value: "project", hint: "install only for this repo/worktree" },
    ],
  });
  if (prompts.isCancel(scope)) return null;

  const baseDir = resolveInitInstallerBaseDir({
    scope: scope as InitInstallerScope,
    cwd: context.cwd,
    env: context.env,
    homeDir: context.homeDir,
  });
  const existing = await readExistingInstallerAnswers(baseDir);

  const configFormat = await prompts.select({
    message: "OpenCode config format",
    initialValue: existing.configFormat ?? "jsonc",
    options: [
      {
        label: "JSONC (recommended)",
        value: "jsonc",
        hint: "keeps useful section comments and trailing commas",
      },
      { label: "JSON", value: "json", hint: "strict JSON without comments" },
    ],
  });
  if (prompts.isCancel(configFormat)) return null;

  let quotaUi: unknown = ["none"];
  let tuiCommandDisplay: unknown;
  let maintainerAnnouncements: unknown;
  if (interfaces !== "web") {
    while (true) {
      quotaUi = await prompts.multiselect({
        message: "Which automatic quota displays do you want?",
        required: true,
        initialValues: existing.quotaUi ?? ["sidebar"],
        options: [
          {
            label: "Sidebar panel (TUI)",
            value: "sidebar",
            hint: "recommended; full Quota panel in the session sidebar",
          },
          { label: "Toast (TUI)", value: "toast", hint: "popup quota summaries" },
          {
            label: "Compact status line (TUI)",
            value: "compact_status",
            hint: "short quota summary below the message input",
          },
          {
            label: "Manual commands only",
            value: "none",
            hint: "no automatic surfaces; slash commands remain available",
          },
        ],
      });
      if (prompts.isCancel(quotaUi)) return null;
      if (!Array.isArray(quotaUi)) {
        throw new InitInstallerError("Automatic quota surfaces require selected options.");
      }
      if (!(quotaUi.includes("none") && quotaUi.length > 1)) break;
      prompts.log.error("Manual commands only cannot be combined with automatic surfaces.");
    }

    tuiCommandDisplay = await prompts.select({
      message: "Where should slash commands (e.g. /quota) appear?",
      initialValue: existing.tuiCommandDisplay ?? "inline",
      options: [
        {
          label: "Inline with messages",
          value: "inline",
          hint: "persist output in the message transcript",
        },
        {
          label: "Popup dialog",
          value: "dialog",
          hint: "show output in a temporary TUI popup",
        },
      ],
    });
    if (prompts.isCancel(tuiCommandDisplay)) return null;
  }

  const providerMode = await prompts.select({
    message: "How should pre-configured providers be selected?",
    initialValue: existing.providerMode ?? "auto",
    options: [
      {
        label: "Auto-detect providers",
        value: "auto",
        hint: "use providers found in your OpenCode configuration and authentication",
      },
      {
        label: "Choose providers manually",
        value: "manual",
        hint: "track only the pre-configured providers you select",
      },
    ],
  });
  if (prompts.isCancel(providerMode)) return null;

  let manualProviders: string[] = [];
  if (providerMode === "manual") {
    const selected = await prompts.multiselect({
      message: "Which pre-configured providers should be tracked?",
      required: true,
      initialValues: existing.manualProviders,
      options: getInstallerProviderPromptOptions(),
    });
    if (prompts.isCancel(selected)) return null;
    if (!Array.isArray(selected) || selected.length === 0) {
      throw new InitInstallerError("Manual provider mode requires at least one selected provider.");
    }
    manualProviders = selected.filter((value): value is string => typeof value === "string");
  }
  prompts.log.info("Custom providers are configured after installation.");
  prompts.log.info("npx @slkiser/opencode-quota@latest provider add");

  const formatStyle = await prompts.select({
    message: "Quota reset periods",
    initialValue: existing.formatStyle ?? "allWindows",
    options: [
      {
        label: "All reset periods",
        value: "allWindows",
        hint: "show every available quota window",
      },
      {
        label: "One reset period (expiring soonest)",
        value: "singleWindow",
        hint: "show only the next quota window to expire",
      },
    ],
  });
  if (prompts.isCancel(formatStyle)) return null;

  const percentDisplayMode = await prompts.select({
    message: "What should quota percentages show?",
    initialValue: existing.percentDisplayMode ?? "remaining",
    options: [
      { label: "Remaining quota", value: "remaining", hint: "show how much quota is left" },
      { label: "Used quota", value: "used", hint: "show how much quota has been consumed" },
    ],
  });
  if (prompts.isCancel(percentDisplayMode)) return null;

  const showSessionTokens = await prompts.select({
    message: "Session input/output tokens",
    initialValue: existing.showSessionTokens === true ? "yes" : "no",
    options: [
      { label: "Hide", value: "no", hint: "keep output shorter" },
      {
        label: "Show",
        value: "yes",
        hint: "include current-session input and output totals",
      },
    ],
  });
  if (prompts.isCancel(showSessionTokens)) return null;

  const sessionTokenScope = await prompts.select({
    message: "Session token scope",
    initialValue: existing.sessionTokenScope ?? "current",
    options: [
      {
        label: "Current session",
        value: "current",
        hint: "preserve the existing session-only totals",
      },
      {
        label: "Current session and descendants",
        value: "tree",
        hint: "include child and subagent sessions once",
      },
    ],
  });
  if (prompts.isCancel(sessionTokenScope)) return null;

  if (interfaces !== "web") {
    maintainerAnnouncements = await prompts.confirm({
      message: "Show maintainer announcements on the TUI Home screen when available?",
      initialValue: existing.maintainerAnnouncements ?? true,
    });
    if (prompts.isCancel(maintainerAnnouncements)) return null;
  }

  return {
    interfaces: interfaces as InitInstallerInterface,
    scope: scope as InitInstallerScope,
    quotaUi: Array.isArray(quotaUi)
      ? quotaUi.filter((value): value is InitQuotaUiChoice => typeof value === "string")
      : ["none"],
    providerMode: providerMode as InitProviderMode,
    manualProviders,
    formatStyle: formatStyle as CanonicalQuotaFormatStyle,
    percentDisplayMode: percentDisplayMode as QuotaToastConfig["percentDisplayMode"],
    showSessionTokens: showSessionTokens === "yes",
    sessionTokenScope: sessionTokenScope as SessionTokenScope,
    tuiCommandDisplay: interfaces === "web" ? undefined : (tuiCommandDisplay as TuiCommandDisplay),
    maintainerAnnouncements: interfaces === "web" ? undefined : maintainerAnnouncements !== false,
    configFormat: configFormat as ConfigFileFormat,
  };
}

export async function runInitInstaller(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  prompts?: PromptAdapter;
  syncLegacyConfig?: boolean;
  dryRun?: boolean;
}): Promise<number> {
  const prompts = params?.prompts ?? ((await import("@clack/prompts")) as unknown as PromptAdapter);

  prompts.intro("Configure @slkiser/opencode-quota");

  try {
    const selections = await promptForSelections(prompts, {
      cwd: params?.cwd,
      env: params?.env,
      homeDir: params?.homeDir,
    });
    if (!selections) {
      prompts.outro("OpenCode Quota setup cancelled — no files changed.");
      return 0;
    }

    const plan = await planInitInstaller({
      selections,
      cwd: params?.cwd,
      env: params?.env,
      homeDir: params?.homeDir,
      syncLegacyConfig: params?.syncLegacyConfig,
    });

    for (const line of plan.summaryLines) {
      prompts.log.info(line);
    }

    if (!plan.edits.some((edit) => edit.changed)) {
      prompts.outro(
        `OpenCode Quota is already configured and current. No files changed. ${GITHUB_STAR_NOTE}`,
      );
      return 0;
    }

    if (params?.dryRun) {
      prompts.outro(
        "OpenCode Quota setup preview complete — no files changed. Run npx @slkiser/opencode-quota@latest init to apply.",
      );
      return 0;
    }

    const confirmed = await prompts.confirm({
      message: "Apply these changes?",
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || !confirmed) {
      prompts.outro("OpenCode Quota setup cancelled — no files changed.");
      return 0;
    }

    const result = await applyInitInstallerPlan(plan);
    for (const path of result.writtenPaths) {
      prompts.log.success(`Wrote ${path}`);
    }
    for (const path of result.unchangedPaths) {
      prompts.log.info(`Unchanged ${path}`);
    }

    if (plan.quickSetupNotes.length > 0) {
      prompts.log.info("Manual quick-setup still needed:");
      for (const note of plan.quickSetupNotes) {
        prompts.log.info(`- ${note.label}: README.md#${note.anchor}`);
      }
    }

    const interfaceLabel =
      plan.selections.interfaces === "tui"
        ? "TUI"
        : plan.selections.interfaces === "web"
          ? "Web"
          : "TUI and Web";
    const configuredPaths = [...result.writtenPaths, ...result.unchangedPaths];
    prompts.outro(
      [
        "OpenCode Quota setup complete.",
        `Interfaces: ${interfaceLabel}`,
        "Configured paths:",
        ...configuredPaths.map((path) => `- ${path}`),
        "Restart OpenCode and run /quota.",
        `If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`,
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    prompts.log.error(reason);
    const writtenPaths =
      error instanceof InitInstallerError ? (error.details?.writtenPaths ?? []) : [];
    if (writtenPaths.length > 0) {
      prompts.log.info(`Files changed before failure: ${writtenPaths.join(", ")}`);
      prompts.outro(
        "OpenCode Quota setup failed after some files changed. Review the listed files, fix the reason above, then rerun init.",
      );
    } else {
      prompts.outro(
        "OpenCode Quota setup failed before any files changed. Fix the reason above, then rerun init.",
      );
    }
    return 1;
  }
}
