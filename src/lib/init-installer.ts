import { readFile } from "fs/promises";
import { basename } from "path";

import { writeJsonAtomic } from "./atomic-json.js";
import {
  dedupeNonEmptyStrings,
  extractPluginSpecsFromParsedConfig,
  getPluginSpecFromEntry,
  isQuotaPluginSpec,
  resolveEditableConfigPath,
  findGitWorktreeRoot,
  type ConfigFileFormat,
} from "./config-file-utils.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import {
  QUOTA_PROVIDER_SHAPES,
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
} from "./provider-metadata.js";
import type { QuotaToastConfig } from "./types.js";

const QUOTA_PLUGIN_SPEC = "@slkiser/opencode-quota";
const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
const TUI_SCHEMA_URL = "https://opencode.ai/tui.json";

export type InitInstallerScope = "project" | "global";
export type InitQuotaUi = "toast" | "sidebar" | "toast_sidebar" | "none";
export type InitProviderMode = "auto" | "manual";

export interface InitInstallerSelections {
  scope: InitInstallerScope;
  quotaUi: InitQuotaUi;
  providerMode: InitProviderMode;
  manualProviders: string[];
  formatStyle: QuotaToastConfig["formatStyle"];
  showSessionTokens: boolean;
}

export interface InitInstallerQuickSetupNote {
  providerId: string;
  label: string;
  anchor: string;
}

export interface PlannedConfigEdit {
  kind: "opencode" | "tui";
  path: string;
  existed: boolean;
  format: ConfigFileFormat;
  changed: boolean;
  addedPlugins: string[];
  addedKeys: string[];
  skippedValues: string[];
  warnings: string[];
  nextData?: Record<string, unknown>;
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
};

type PromptAdapter = {
  intro: (message: string) => void;
  outro: (message: string) => void;
  select: (options: { message: string; options: PromptOption[] }) => Promise<unknown>;
  multiselect: (options: {
    message: string;
    required?: boolean;
    options: PromptOption[];
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

function getUiLabel(mode: InitQuotaUi): string {
  if (mode === "toast") return "Toast";
  if (mode === "sidebar") return "Sidebar";
  if (mode === "toast_sidebar") return "Toast + Sidebar";
  return "None";
}

function getProviderModeLabel(mode: InitProviderMode): string {
  return mode === "manual" ? "Manual" : "Auto-detect";
}

function getDesiredEnableToast(mode: InitQuotaUi): boolean {
  return mode === "toast" || mode === "toast_sidebar";
}

function shouldInstallTuiPlugin(mode: InitQuotaUi): boolean {
  return mode === "sidebar" || mode === "toast_sidebar";
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
  selectedFormatStyle: QuotaToastConfig["formatStyle"];
}): QuotaToastConfig["formatStyle"] {
  if (params.quotaToast.toastStyle === "classic" || params.quotaToast.toastStyle === "grouped") {
    return params.quotaToast.toastStyle;
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

function ensureJsonObject(
  parent: JsonObject,
  key: string,
  pathLabel: string,
  edit: PlannedConfigEdit,
): JsonObject {
  if (!hasOwnKey(parent, key) || parent[key] === undefined) {
    const next: JsonObject = {};
    parent[key] = next;
    edit.changed = true;
    return next;
  }

  const existing = parent[key];
  if (!isPlainObject(existing)) {
    throw new InitInstallerError(
      `Cannot update ${edit.kind} config because ${pathLabel} is not an object.`,
      {
        path: edit.path,
      },
    );
  }

  return existing;
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

async function planOpencodeEdit(params: {
  selections: InitInstallerSelections;
  baseDir: string;
}): Promise<PlannedConfigEdit> {
  const target = resolveEditableConfigPath({ dir: params.baseDir, kind: "opencode" });
  const edit: PlannedConfigEdit = {
    kind: "opencode",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    skippedValues: [],
    warnings:
      target.format === "jsonc"
        ? ["Existing JSONC comments/trailing commas will be stripped."]
        : [],
  };

  const root = target.existed ? await readExistingConfig(target) : {};

  ensureSchema(root, OPENCODE_SCHEMA_URL, edit);

  const plugin = ensureTopLevelPluginArray(root, edit);
  appendQuotaPluginIfMissing({
    container: plugin,
    pathLabel: "plugin",
    kind: "opencode",
    edit,
  });

  const experimental = ensureJsonObject(root, "experimental", "experimental", edit);
  const quotaToast = ensureJsonObject(experimental, "quotaToast", "experimental.quotaToast", edit);

  addSettingIfMissing(
    quotaToast,
    "enableToast",
    getDesiredEnableToast(params.selections.quotaUi),
    "experimental.quotaToast.enableToast",
    edit,
  );
  addSettingIfMissing(
    quotaToast,
    "showSessionTokens",
    params.selections.showSessionTokens,
    "experimental.quotaToast.showSessionTokens",
    edit,
  );
  addSettingIfMissing(
    quotaToast,
    "enabledProviders",
    resolveRequestedProviders(params.selections),
    "experimental.quotaToast.enabledProviders",
    edit,
  );
  addSettingIfMissing(
    quotaToast,
    "formatStyle",
    pickFormatStyleToWrite({
      quotaToast,
      selectedFormatStyle: params.selections.formatStyle,
    }),
    "experimental.quotaToast.formatStyle",
    edit,
  );

  if (edit.changed) {
    edit.nextData = root;
  }

  return edit;
}

async function planTuiEdit(params: {
  selections: InitInstallerSelections;
  baseDir: string;
}): Promise<PlannedConfigEdit> {
  const target = resolveEditableConfigPath({ dir: params.baseDir, kind: "tui" });
  const edit: PlannedConfigEdit = {
    kind: "tui",
    path: target.path,
    existed: target.existed,
    format: target.format,
    changed: false,
    addedPlugins: [],
    addedKeys: [],
    skippedValues: [],
    warnings:
      target.format === "jsonc"
        ? ["Existing JSONC comments/trailing commas will be stripped."]
        : [],
  };

  const root = target.existed ? await readExistingConfig(target) : {};
  ensureSchema(root, TUI_SCHEMA_URL, edit);

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

  if (edit.changed) {
    edit.nextData = root;
  }

  return edit;
}

function buildPlanSummary(plan: InitInstallerPlan): string[] {
  const lines: string[] = [
    `Scope: ${plan.selections.scope} (${plan.baseDir})`,
    `Quota UI: ${getUiLabel(plan.selections.quotaUi)}`,
    `Provider mode: ${getProviderModeLabel(plan.selections.providerMode)}`,
    `Layout style: ${plan.selections.formatStyle}`,
    `Show session tokens: ${plan.selections.showSessionTokens ? "Yes" : "No"}`,
  ];

  const requestedProviders = resolveRequestedProviders(plan.selections);
  if (requestedProviders !== "auto") {
    lines.push(
      `Manual providers: ${requestedProviders.map((providerId) => getQuotaProviderDisplayLabel(providerId)).join(", ")}`,
    );
  }

  for (const edit of plan.edits) {
    const mode = !edit.existed ? "create" : edit.changed ? "update" : "unchanged";
    lines.push(`${mode}: ${edit.path}`);

    for (const plugin of edit.addedPlugins) {
      lines.push(`  + plugin ${plugin}`);
    }
    for (const key of edit.addedKeys) {
      lines.push(`  + ${key}`);
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
}): Promise<InitInstallerPlan> {
  const selections: InitInstallerSelections = {
    ...params.selections,
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
  const edits = [await planOpencodeEdit({ selections, baseDir })];
  if (shouldInstallTuiPlugin(selections.quotaUi)) {
    edits.push(await planTuiEdit({ selections, baseDir }));
  }

  const quickSetupNotes = buildQuickSetupNotes(selections);
  const plan: InitInstallerPlan = {
    selections,
    baseDir,
    edits,
    warnings: edits.flatMap((edit) => edit.warnings),
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

  for (const edit of plan.edits) {
    if (!edit.changed || !edit.nextData) {
      unchangedPaths.push(edit.path);
      continue;
    }

    try {
      await writeJsonAtomic(edit.path, edit.nextData, { trailingNewline: true });
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

async function promptForSelections(
  prompts: PromptAdapter,
): Promise<InitInstallerSelections | null> {
  const scope = await prompts.select({
    message: "Install scope",
    options: [
      { label: "Project", value: "project" },
      { label: "Global", value: "global" },
    ],
  });
  if (prompts.isCancel(scope)) return null;

  const quotaUi = await prompts.select({
    message: "Quota UI",
    options: [
      { label: "Toast", value: "toast" },
      { label: "Sidebar", value: "sidebar" },
      { label: "Toast + Sidebar", value: "toast_sidebar" },
      { label: "None (manual /quota and /tokens_* only)", value: "none" },
    ],
  });
  if (prompts.isCancel(quotaUi)) return null;

  const providerMode = await prompts.select({
    message: "Provider mode",
    options: [
      { label: "Auto-detect", value: "auto" },
      { label: "Manual select", value: "manual" },
    ],
  });
  if (prompts.isCancel(providerMode)) return null;

  let manualProviders: string[] = [];
  if (providerMode === "manual") {
    const selected = await prompts.multiselect({
      message: "Manual providers",
      required: true,
      options: getInstallerProviderPromptOptions(),
    });
    if (prompts.isCancel(selected)) return null;
    if (!Array.isArray(selected) || selected.length === 0) {
      throw new InitInstallerError("Manual provider mode requires at least one selected provider.");
    }
    manualProviders = selected.filter((value): value is string => typeof value === "string");
  }

  const formatStyle = await prompts.select({
    message: "Layout style",
    options: [
      { label: "Classic", value: "classic" },
      { label: "Grouped", value: "grouped" },
    ],
  });
  if (prompts.isCancel(formatStyle)) return null;

  const showSessionTokens = await prompts.select({
    message: "Show session input/output tokens",
    options: [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
  });
  if (prompts.isCancel(showSessionTokens)) return null;

  return {
    scope: scope as InitInstallerScope,
    quotaUi: quotaUi as InitQuotaUi,
    providerMode: providerMode as InitProviderMode,
    manualProviders,
    formatStyle: formatStyle as QuotaToastConfig["formatStyle"],
    showSessionTokens: showSessionTokens === "yes",
  };
}

export async function runInitInstaller(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  prompts?: PromptAdapter;
}): Promise<number> {
  const prompts = params?.prompts ?? ((await import("@clack/prompts")) as unknown as PromptAdapter);

  prompts.intro("Configure @slkiser/opencode-quota");

  try {
    const selections = await promptForSelections(prompts);
    if (!selections) {
      prompts.outro("Cancelled");
      return 0;
    }

    const plan = await planInitInstaller({
      selections,
      cwd: params?.cwd,
      env: params?.env,
      homeDir: params?.homeDir,
    });

    for (const line of plan.summaryLines) {
      prompts.log.info(line);
    }

    if (!plan.edits.some((edit) => edit.changed)) {
      prompts.outro("No changes needed");
      return 0;
    }

    const confirmed = await prompts.confirm({
      message: "Apply these changes?",
      initialValue: true,
    });
    if (prompts.isCancel(confirmed) || !confirmed) {
      prompts.outro("Cancelled");
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

    prompts.outro("Quota init complete");
    return 0;
  } catch (error) {
    if (error instanceof InitInstallerError) {
      prompts.log.error(error.message);
      if (error.details?.writtenPaths?.length) {
        prompts.log.info(`Already written: ${error.details.writtenPaths.join(", ")}`);
      }
    } else {
      prompts.log.error(error instanceof Error ? error.message : String(error));
    }
    prompts.outro("Quota init failed");
    return 1;
  }
}
