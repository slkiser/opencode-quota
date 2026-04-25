/**
 * Configuration loader for opencode-quota plugin.
 *
 * Precedence model:
 * - Global/user config provides defaults.
 * - Workspace config at the resolved config root overrides ordinary settings.
 * - SDK config is used only as a fallback when no file-backed config exists.
 */

import type {
  CursorQuotaPlan,
  QuotaToastConfig,
  GoogleModelId,
  PercentDisplayMode,
  PricingSnapshotSource,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { isQuotaFormatStyle, resolveQuotaFormatStyle } from "./quota-format-style.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { getQuotaProviderShape, normalizeQuotaProviderId } from "./provider-metadata.js";

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export const QUOTA_TOAST_SETTING_SOURCE_KEYS = [
  "enabled",
  "enableToast",
  "formatStyle",
  "percentDisplayMode",
  "minIntervalMs",
  "debug",
  "enabledProviders",
  "anthropicBinaryPath",
  "googleModels",
  "alibabaCodingPlanTier",
  "cursorPlan",
  "cursorIncludedApiUsd",
  "cursorBillingCycleStartDay",
  "pricingSnapshot.source",
  "pricingSnapshot.autoRefresh",
  "showOnIdle",
  "showOnQuestion",
  "showOnCompact",
  "showOnBothFail",
  "toastDurationMs",
  "onlyCurrentModel",
  "showSessionTokens",
  "layout.maxWidth",
  "layout.narrowAt",
  "layout.tinyAt",
] as const;

export type QuotaToastSettingSourceKey = (typeof QUOTA_TOAST_SETTING_SOURCE_KEYS)[number];
export type QuotaToastSettingSources = Partial<Record<QuotaToastSettingSourceKey, string>>;

export interface LoadConfigMeta {
  source: "sdk" | "files" | "defaults";
  paths: string[];
  globalConfigPaths: string[];
  workspaceConfigPaths: string[];
  settingSources: QuotaToastSettingSources;
  networkSettingSources: Record<string, string>;
}

export interface LoadConfigOptions {
  /** @deprecated Prefer configRootDir for new callers. */
  cwd?: string;
  configRootDir?: string;
}

export function createLoadConfigMeta(): LoadConfigMeta {
  return {
    source: "defaults",
    paths: [],
    globalConfigPaths: [],
    workspaceConfigPaths: [],
    settingSources: {},
    networkSettingSources: {},
  };
}

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;
const NETWORK_SETTING_SOURCE_KEYS = [
  "enabled",
  "enabledProviders",
  "minIntervalMs",
  "pricingSnapshot.source",
  "pricingSnapshot.autoRefresh",
  "showOnIdle",
  "showOnQuestion",
  "showOnCompact",
  "showOnBothFail",
] as const satisfies readonly QuotaToastSettingSourceKey[];

type PricingSnapshotPatch = Partial<QuotaToastConfig["pricingSnapshot"]>;
type LayoutPatch = Partial<QuotaToastConfig["layout"]>;

type ValidatedQuotaToastPatch = {
  enabled?: boolean;
  enableToast?: boolean;
  formatStyle?: QuotaToastConfig["formatStyle"];
  percentDisplayMode?: PercentDisplayMode;
  minIntervalMs?: number;
  debug?: boolean;
  enabledProviders?: string[] | "auto";
  anthropicBinaryPath?: string;
  googleModels?: GoogleModelId[];
  alibabaCodingPlanTier?: QuotaToastConfig["alibabaCodingPlanTier"];
  cursorPlan?: CursorQuotaPlan;
  cursorIncludedApiUsd?: number;
  cursorBillingCycleStartDay?: number;
  pricingSnapshot?: PricingSnapshotPatch;
  showOnIdle?: boolean;
  showOnQuestion?: boolean;
  showOnCompact?: boolean;
  showOnBothFail?: boolean;
  toastDurationMs?: number;
  onlyCurrentModel?: boolean;
  showSessionTokens?: boolean;
  layout?: LayoutPatch;
};

type ConfigLayerScope = "global" | "workspace";

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates and normalizes a Google model ID
 */
function isValidGoogleModelId(id: unknown): id is GoogleModelId {
  return typeof id === "string" && ["G3PRO", "G3FLASH", "CLAUDE", "G3IMAGE"].includes(id);
}

function isValidCursorQuotaPlan(plan: unknown): plan is CursorQuotaPlan {
  return (
    typeof plan === "string" && ["none", "pro", "pro-plus", "ultra"].includes(plan)
  );
}

function isValidPricingSnapshotSource(source: unknown): source is PricingSnapshotSource {
  return typeof source === "string" && ["auto", "bundled", "runtime"].includes(source);
}

function isValidPricingSnapshotAutoRefresh(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isValidPercentDisplayMode(value: unknown): value is PercentDisplayMode {
  return value === "remaining" || value === "used";
}

function isValidAlibabaCodingPlanTier(
  value: unknown,
): value is QuotaToastConfig["alibabaCodingPlanTier"] {
  return value === "lite" || value === "pro";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidCursorBillingCycleStartDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 28;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getConfiguredFormatStyle(
  quotaToastConfig: Partial<QuotaToastConfig> | undefined | null,
): QuotaToastConfig["formatStyle"] | undefined {
  if (!quotaToastConfig) {
    return undefined;
  }

  if (isQuotaFormatStyle(quotaToastConfig.formatStyle)) {
    return resolveQuotaFormatStyle(quotaToastConfig.formatStyle);
  }

  const legacyFormatStyle = (quotaToastConfig as { toastStyle?: unknown }).toastStyle;
  if (isQuotaFormatStyle(legacyFormatStyle)) {
    return resolveQuotaFormatStyle(legacyFormatStyle);
  }

  return undefined;
}

/**
 * Remove duplicates from an array while preserving order
 */
function dedupe<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function cloneDefaultConfig(): QuotaToastConfig {
  return {
    ...DEFAULT_CONFIG,
    enabledProviders: Array.isArray(DEFAULT_CONFIG.enabledProviders)
      ? [...DEFAULT_CONFIG.enabledProviders]
      : DEFAULT_CONFIG.enabledProviders,
    googleModels: [...DEFAULT_CONFIG.googleModels],
    pricingSnapshot: { ...DEFAULT_CONFIG.pricingSnapshot },
    layout: { ...DEFAULT_CONFIG.layout },
  };
}

function normalizeEnabledProviders(value: unknown): string[] | "auto" | undefined {
  if (value === "auto") {
    return "auto";
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const normalized = dedupe(
    value
      .filter((provider): provider is string => typeof provider === "string")
      .map(normalizeQuotaProviderId)
      .filter((provider): provider is string => Boolean(getQuotaProviderShape(provider))),
  );

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeGoogleModels(value: unknown): GoogleModelId[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const models = value.filter(isValidGoogleModelId);
  return models.length > 0 ? models : undefined;
}

function extractPricingSnapshotPatch(value: unknown): PricingSnapshotPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: PricingSnapshotPatch = {};

  if (hasOwnKey(value, "source") && isValidPricingSnapshotSource(value.source)) {
    patch.source = value.source;
  }

  if (hasOwnKey(value, "autoRefresh") && isValidPricingSnapshotAutoRefresh(value.autoRefresh)) {
    patch.autoRefresh = value.autoRefresh;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractLayoutPatch(value: unknown): LayoutPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: LayoutPatch = {};

  if (hasOwnKey(value, "maxWidth") && isPositiveNumber(value.maxWidth)) {
    patch.maxWidth = value.maxWidth;
  }

  if (hasOwnKey(value, "narrowAt") && isPositiveNumber(value.narrowAt)) {
    patch.narrowAt = value.narrowAt;
  }

  if (hasOwnKey(value, "tinyAt") && isPositiveNumber(value.tinyAt)) {
    patch.tinyAt = value.tinyAt;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractValidatedQuotaToastPatch(
  quotaToastConfig: Record<string, unknown>,
): ValidatedQuotaToastPatch {
  const patch: ValidatedQuotaToastPatch = {};

  if (hasOwnKey(quotaToastConfig, "enabled") && typeof quotaToastConfig.enabled === "boolean") {
    patch.enabled = quotaToastConfig.enabled;
  }

  if (
    hasOwnKey(quotaToastConfig, "enableToast") &&
    typeof quotaToastConfig.enableToast === "boolean"
  ) {
    patch.enableToast = quotaToastConfig.enableToast;
  }

  const formatStyle = getConfiguredFormatStyle(quotaToastConfig as Partial<QuotaToastConfig>);
  if (formatStyle) {
    patch.formatStyle = formatStyle;
  }

  if (
    hasOwnKey(quotaToastConfig, "percentDisplayMode") &&
    isValidPercentDisplayMode(quotaToastConfig.percentDisplayMode)
  ) {
    patch.percentDisplayMode = quotaToastConfig.percentDisplayMode;
  }

  if (hasOwnKey(quotaToastConfig, "minIntervalMs") && isPositiveNumber(quotaToastConfig.minIntervalMs)) {
    patch.minIntervalMs = quotaToastConfig.minIntervalMs;
  }

  if (hasOwnKey(quotaToastConfig, "debug") && typeof quotaToastConfig.debug === "boolean") {
    patch.debug = quotaToastConfig.debug;
  }

  if (hasOwnKey(quotaToastConfig, "enabledProviders")) {
    const enabledProviders = normalizeEnabledProviders(quotaToastConfig.enabledProviders);
    if (enabledProviders !== undefined) {
      patch.enabledProviders = enabledProviders;
    }
  }

  if (hasOwnKey(quotaToastConfig, "anthropicBinaryPath")) {
    const anthropicBinaryPath = normalizeOptionalString(quotaToastConfig.anthropicBinaryPath);
    if (anthropicBinaryPath !== undefined) {
      patch.anthropicBinaryPath = anthropicBinaryPath;
    }
  }

  if (hasOwnKey(quotaToastConfig, "googleModels")) {
    const googleModels = normalizeGoogleModels(quotaToastConfig.googleModels);
    if (googleModels !== undefined) {
      patch.googleModels = googleModels;
    }
  }

  if (
    hasOwnKey(quotaToastConfig, "alibabaCodingPlanTier") &&
    isValidAlibabaCodingPlanTier(quotaToastConfig.alibabaCodingPlanTier)
  ) {
    patch.alibabaCodingPlanTier = quotaToastConfig.alibabaCodingPlanTier;
  }

  if (hasOwnKey(quotaToastConfig, "cursorPlan") && isValidCursorQuotaPlan(quotaToastConfig.cursorPlan)) {
    patch.cursorPlan = quotaToastConfig.cursorPlan;
  }

  if (
    hasOwnKey(quotaToastConfig, "cursorIncludedApiUsd") &&
    isPositiveNumber(quotaToastConfig.cursorIncludedApiUsd)
  ) {
    patch.cursorIncludedApiUsd = quotaToastConfig.cursorIncludedApiUsd;
  }

  if (
    hasOwnKey(quotaToastConfig, "cursorBillingCycleStartDay") &&
    isValidCursorBillingCycleStartDay(quotaToastConfig.cursorBillingCycleStartDay)
  ) {
    patch.cursorBillingCycleStartDay = quotaToastConfig.cursorBillingCycleStartDay;
  }

  if (hasOwnKey(quotaToastConfig, "pricingSnapshot")) {
    const pricingSnapshot = extractPricingSnapshotPatch(quotaToastConfig.pricingSnapshot);
    if (pricingSnapshot) {
      patch.pricingSnapshot = pricingSnapshot;
    }
  }

  if (hasOwnKey(quotaToastConfig, "showOnIdle") && typeof quotaToastConfig.showOnIdle === "boolean") {
    patch.showOnIdle = quotaToastConfig.showOnIdle;
  }

  if (
    hasOwnKey(quotaToastConfig, "showOnQuestion") &&
    typeof quotaToastConfig.showOnQuestion === "boolean"
  ) {
    patch.showOnQuestion = quotaToastConfig.showOnQuestion;
  }

  if (
    hasOwnKey(quotaToastConfig, "showOnCompact") &&
    typeof quotaToastConfig.showOnCompact === "boolean"
  ) {
    patch.showOnCompact = quotaToastConfig.showOnCompact;
  }

  if (
    hasOwnKey(quotaToastConfig, "showOnBothFail") &&
    typeof quotaToastConfig.showOnBothFail === "boolean"
  ) {
    patch.showOnBothFail = quotaToastConfig.showOnBothFail;
  }

  if (
    hasOwnKey(quotaToastConfig, "toastDurationMs") &&
    isPositiveNumber(quotaToastConfig.toastDurationMs)
  ) {
    patch.toastDurationMs = quotaToastConfig.toastDurationMs;
  }

  if (
    hasOwnKey(quotaToastConfig, "onlyCurrentModel") &&
    typeof quotaToastConfig.onlyCurrentModel === "boolean"
  ) {
    patch.onlyCurrentModel = quotaToastConfig.onlyCurrentModel;
  }

  if (
    hasOwnKey(quotaToastConfig, "showSessionTokens") &&
    typeof quotaToastConfig.showSessionTokens === "boolean"
  ) {
    patch.showSessionTokens = quotaToastConfig.showSessionTokens;
  }

  if (hasOwnKey(quotaToastConfig, "layout")) {
    const layout = extractLayoutPatch(quotaToastConfig.layout);
    if (layout) {
      patch.layout = layout;
    }
  }

  return patch;
}

function applySettingSource(
  settingSources: QuotaToastSettingSources,
  key: QuotaToastSettingSourceKey,
  sourcePath: string,
): void {
  settingSources[key] = sourcePath;
}

function applyValidatedQuotaToastPatch(
  config: QuotaToastConfig,
  patch: ValidatedQuotaToastPatch,
  sourcePath: string,
  settingSources: QuotaToastSettingSources,
): void {
  if (hasOwnKey(patch, "enabled")) {
    config.enabled = patch.enabled!;
    applySettingSource(settingSources, "enabled", sourcePath);
  }

  if (hasOwnKey(patch, "enableToast")) {
    config.enableToast = patch.enableToast!;
    applySettingSource(settingSources, "enableToast", sourcePath);
  }

  if (hasOwnKey(patch, "formatStyle")) {
    config.formatStyle = patch.formatStyle!;
    applySettingSource(settingSources, "formatStyle", sourcePath);
  }

  if (hasOwnKey(patch, "percentDisplayMode")) {
    config.percentDisplayMode = patch.percentDisplayMode!;
    applySettingSource(settingSources, "percentDisplayMode", sourcePath);
  }

  if (hasOwnKey(patch, "minIntervalMs")) {
    config.minIntervalMs = patch.minIntervalMs!;
    applySettingSource(settingSources, "minIntervalMs", sourcePath);
  }

  if (hasOwnKey(patch, "debug")) {
    config.debug = patch.debug!;
    applySettingSource(settingSources, "debug", sourcePath);
  }

  if (hasOwnKey(patch, "enabledProviders")) {
    config.enabledProviders =
      patch.enabledProviders === "auto" ? "auto" : [...patch.enabledProviders!];
    applySettingSource(settingSources, "enabledProviders", sourcePath);
  }

  if (hasOwnKey(patch, "anthropicBinaryPath")) {
    config.anthropicBinaryPath = patch.anthropicBinaryPath!;
    applySettingSource(settingSources, "anthropicBinaryPath", sourcePath);
  }

  if (hasOwnKey(patch, "googleModels")) {
    config.googleModels = [...patch.googleModels!];
    applySettingSource(settingSources, "googleModels", sourcePath);
  }

  if (hasOwnKey(patch, "alibabaCodingPlanTier")) {
    config.alibabaCodingPlanTier = patch.alibabaCodingPlanTier!;
    applySettingSource(settingSources, "alibabaCodingPlanTier", sourcePath);
  }

  if (hasOwnKey(patch, "cursorPlan")) {
    config.cursorPlan = patch.cursorPlan!;
    applySettingSource(settingSources, "cursorPlan", sourcePath);
  }

  if (hasOwnKey(patch, "cursorIncludedApiUsd")) {
    config.cursorIncludedApiUsd = patch.cursorIncludedApiUsd;
    applySettingSource(settingSources, "cursorIncludedApiUsd", sourcePath);
  }

  if (hasOwnKey(patch, "cursorBillingCycleStartDay")) {
    config.cursorBillingCycleStartDay = patch.cursorBillingCycleStartDay;
    applySettingSource(settingSources, "cursorBillingCycleStartDay", sourcePath);
  }

  if (patch.pricingSnapshot) {
    if (hasOwnKey(patch.pricingSnapshot, "source")) {
      config.pricingSnapshot.source = patch.pricingSnapshot.source!;
      applySettingSource(settingSources, "pricingSnapshot.source", sourcePath);
    }

    if (hasOwnKey(patch.pricingSnapshot, "autoRefresh")) {
      config.pricingSnapshot.autoRefresh = patch.pricingSnapshot.autoRefresh!;
      applySettingSource(settingSources, "pricingSnapshot.autoRefresh", sourcePath);
    }
  }

  if (hasOwnKey(patch, "showOnIdle")) {
    config.showOnIdle = patch.showOnIdle!;
    applySettingSource(settingSources, "showOnIdle", sourcePath);
  }

  if (hasOwnKey(patch, "showOnQuestion")) {
    config.showOnQuestion = patch.showOnQuestion!;
    applySettingSource(settingSources, "showOnQuestion", sourcePath);
  }

  if (hasOwnKey(patch, "showOnCompact")) {
    config.showOnCompact = patch.showOnCompact!;
    applySettingSource(settingSources, "showOnCompact", sourcePath);
  }

  if (hasOwnKey(patch, "showOnBothFail")) {
    config.showOnBothFail = patch.showOnBothFail!;
    applySettingSource(settingSources, "showOnBothFail", sourcePath);
  }

  if (hasOwnKey(patch, "toastDurationMs")) {
    config.toastDurationMs = patch.toastDurationMs!;
    applySettingSource(settingSources, "toastDurationMs", sourcePath);
  }

  if (hasOwnKey(patch, "onlyCurrentModel")) {
    config.onlyCurrentModel = patch.onlyCurrentModel!;
    applySettingSource(settingSources, "onlyCurrentModel", sourcePath);
  }

  if (hasOwnKey(patch, "showSessionTokens")) {
    config.showSessionTokens = patch.showSessionTokens!;
    applySettingSource(settingSources, "showSessionTokens", sourcePath);
  }

  if (patch.layout) {
    if (hasOwnKey(patch.layout, "maxWidth")) {
      config.layout.maxWidth = patch.layout.maxWidth!;
      applySettingSource(settingSources, "layout.maxWidth", sourcePath);
    }

    if (hasOwnKey(patch.layout, "narrowAt")) {
      config.layout.narrowAt = patch.layout.narrowAt!;
      applySettingSource(settingSources, "layout.narrowAt", sourcePath);
    }

    if (hasOwnKey(patch.layout, "tinyAt")) {
      config.layout.tinyAt = patch.layout.tinyAt!;
      applySettingSource(settingSources, "layout.tinyAt", sourcePath);
    }
  }
}

function projectNetworkSettingSources(
  settingSources: QuotaToastSettingSources,
): Record<string, string> {
  const projected: Record<string, string> = {};

  for (const key of NETWORK_SETTING_SOURCE_KEYS) {
    const source = settingSources[key];
    if (typeof source === "string" && source.length > 0) {
      projected[key] = source;
    }
  }

  return projected;
}

function buildConfigLayerCandidates(
  configDirs: string[],
  configRootDir: string,
): Array<{ path: string; scope: ConfigLayerScope }> {
  const workspaceCandidates = CONFIG_FILENAMES.map((filename) => ({
    path: join(configRootDir, filename),
    scope: "workspace" as const,
  }));
  const workspacePaths = new Set(workspaceCandidates.map((candidate) => candidate.path));
  const globalCandidates = configDirs.flatMap((dir) =>
    CONFIG_FILENAMES.map((filename) => ({ path: join(dir, filename), scope: "global" as const })),
  );

  return [
    ...globalCandidates.filter((candidate) => !workspacePaths.has(candidate.path)),
    ...workspaceCandidates,
  ];
}

/**
 * Load plugin configuration from OpenCode config
 *
 * @param client - Optional OpenCode SDK client fallback
 * @returns Merged configuration with defaults
 */
export async function loadConfig(
  client:
    | {
        config: {
          get: () => Promise<{
            data?: { experimental?: { quotaToast?: Partial<QuotaToastConfig> } };
          }>;
        };
      }
    | undefined,
  meta?: LoadConfigMeta,
  options?: LoadConfigOptions,
): Promise<QuotaToastConfig> {
  async function readJson(path: string): Promise<unknown | null> {
    try {
      const content = await readFile(path, "utf-8");
      return parseJsonOrJsonc(content, path.endsWith(".jsonc"));
    } catch {
      return null;
    }
  }

  async function loadFromFiles(): Promise<{
    config: QuotaToastConfig | null;
    usedPaths: string[];
    globalConfigPaths: string[];
    workspaceConfigPaths: string[];
    settingSources: QuotaToastSettingSources;
    networkSettingSources: Record<string, string>;
  }> {
    const configRootDir = options?.configRootDir ?? options?.cwd ?? process.cwd();
    const { configDirs } = getOpencodeRuntimeDirCandidates();
    const config = cloneDefaultConfig();
    const usedPaths: string[] = [];
    const globalConfigPaths: string[] = [];
    const workspaceConfigPaths: string[] = [];
    const settingSources: QuotaToastSettingSources = {};

    for (const candidate of buildConfigLayerCandidates(configDirs, configRootDir)) {
      if (!existsSync(candidate.path)) {
        continue;
      }

      const parsed = await readJson(candidate.path);
      if (!isPlainObject(parsed) || !isPlainObject(parsed.experimental)) {
        continue;
      }

      const rawQuotaToast = parsed.experimental.quotaToast;
      if (!isPlainObject(rawQuotaToast)) {
        continue;
      }

      const sourcePath = `${candidate.path} (experimental.quotaToast)`;
      usedPaths.push(sourcePath);
      if (candidate.scope === "global") {
        globalConfigPaths.push(sourcePath);
      } else {
        workspaceConfigPaths.push(sourcePath);
      }

      applyValidatedQuotaToastPatch(
        config,
        extractValidatedQuotaToastPatch(rawQuotaToast),
        sourcePath,
        settingSources,
      );
    }

    if (usedPaths.length === 0) {
      return {
        config: null,
        usedPaths: [],
        globalConfigPaths: [],
        workspaceConfigPaths: [],
        settingSources: {},
        networkSettingSources: {},
      };
    }

    return {
      config,
      usedPaths,
      globalConfigPaths,
      workspaceConfigPaths,
      settingSources,
      networkSettingSources: projectNetworkSettingSources(settingSources),
    };
  }

  const fileConfig = await loadFromFiles();
  if (fileConfig.config) {
    if (meta) {
      meta.source = "files";
      meta.paths = fileConfig.usedPaths;
      meta.globalConfigPaths = fileConfig.globalConfigPaths;
      meta.workspaceConfigPaths = fileConfig.workspaceConfigPaths;
      meta.settingSources = fileConfig.settingSources;
      meta.networkSettingSources = fileConfig.networkSettingSources;
    }
    return fileConfig.config;
  }

  if (client) {
    try {
      const response = await client.config.get();

      // OpenCode config schema is strict; plugin-specific config must live under
      // experimental.* to avoid "unrecognized key" validation errors.
      const quotaToastConfig = (response.data as any)?.experimental?.quotaToast;

      if (isPlainObject(quotaToastConfig)) {
        const config = cloneDefaultConfig();
        const settingSources: QuotaToastSettingSources = {};
        applyValidatedQuotaToastPatch(
          config,
          extractValidatedQuotaToastPatch(quotaToastConfig),
          "client.config.get",
          settingSources,
        );

        if (meta) {
          meta.source = "sdk";
          meta.paths = ["client.config.get"];
          meta.globalConfigPaths = [];
          meta.workspaceConfigPaths = [];
          meta.settingSources = settingSources;
          meta.networkSettingSources = projectNetworkSettingSources(settingSources);
        }

        return config;
      }
    } catch {
      // ignore; fall back to defaults below
    }
  }

  if (meta) {
    meta.source = "defaults";
    meta.paths = [];
    meta.globalConfigPaths = [];
    meta.workspaceConfigPaths = [];
    meta.settingSources = {};
    meta.networkSettingSources = {};
  }
  return DEFAULT_CONFIG;
}
