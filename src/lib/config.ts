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

import { getEffectiveConfigRoot } from "./config-file-utils.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export const QUOTA_TOAST_CONFIG_RELATIVE_PATH = "opencode-quota/quota-toast.json";

export const QUOTA_TOAST_SETTING_SOURCE_KEYS = [
  "enabled",
  "enableToast",
  "formatStyle",
  "percentDisplayMode",
  "minIntervalMs",
  "requestTimeoutMs",
  "debug",
  "enabledProviders",
  "anthropicBinaryPath",
  "googleModels",
  "alibabaCodingPlanTier",
  "cursorPlan",
  "cursorIncludedApiUsd",
  "cursorBillingCycleStartDay",
  "opencodeGoWindows",
  "pricingSnapshot.source",
  "pricingSnapshot.autoRefresh",
  "showOnIdle",
  "showOnQuestion",
  "showOnCompact",
  "showOnBothFail",
  "toastDurationMs",
  "onlyCurrentModel",
  "showSessionTokens",
  "tuiSidebarPanel.enabled",
  "tuiSidebarPanel.formatStyle",
  "tuiCompactStatus.enabled",
  "tuiCompactStatus.homeBottom",
  "tuiCompactStatus.sessionPrompt",
  "tuiCompactStatus.suppressWhenNativeProviderQuota",
  "tuiCompactStatus.maxWidth",
  "tuiCompactStatus.formatStyle",
  "maintainerAnnouncements.enabled",
  "maintainerAnnouncements.home",
  "layout.maxWidth",
  "layout.narrowAt",
  "layout.tinyAt",
  "export.enabled",
  "export.path",
] as const;

export type QuotaToastSettingSourceKey = (typeof QUOTA_TOAST_SETTING_SOURCE_KEYS)[number];
export type QuotaToastSettingSources = Partial<Record<QuotaToastSettingSourceKey, string>>;

export interface LoadConfigIssue {
  path: string;
  key: string;
  message: string;
}

export interface LoadConfigMeta {
  source: "sdk" | "files" | "defaults";
  paths: string[];
  globalConfigPaths: string[];
  workspaceConfigPaths: string[];
  settingSources: QuotaToastSettingSources;
  networkSettingSources: Record<string, string>;
  configIssues: LoadConfigIssue[];
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
    configIssues: [],
  };
}

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;
const NETWORK_SETTING_SOURCE_KEYS = [
  "enabled",
  "enabledProviders",
  "minIntervalMs",
  "requestTimeoutMs",
  "pricingSnapshot.source",
  "pricingSnapshot.autoRefresh",
  "showOnIdle",
  "showOnQuestion",
  "showOnCompact",
  "showOnBothFail",
] as const satisfies readonly QuotaToastSettingSourceKey[];

type PricingSnapshotPatch = Partial<QuotaToastConfig["pricingSnapshot"]>;
type TuiSidebarPanelPatch = Partial<QuotaToastConfig["tuiSidebarPanel"]>;
type TuiCompactStatusPatch = Partial<QuotaToastConfig["tuiCompactStatus"]>;
type MaintainerAnnouncementsPatch = Partial<QuotaToastConfig["maintainerAnnouncements"]>;
type LayoutPatch = Partial<QuotaToastConfig["layout"]>;
type ExportConfigPatch = Partial<QuotaToastConfig["export"]>;

type ValidatedQuotaToastPatch = {
  enabled?: boolean;
  enableToast?: boolean;
  formatStyle?: QuotaToastConfig["formatStyle"];
  percentDisplayMode?: PercentDisplayMode;
  minIntervalMs?: number;
  requestTimeoutMs?: number;
  debug?: boolean;
  enabledProviders?: string[] | "auto";
  enabledProvidersInvalidEmpty?: boolean;
  anthropicBinaryPath?: string;
  googleModels?: GoogleModelId[];
  alibabaCodingPlanTier?: QuotaToastConfig["alibabaCodingPlanTier"];
  cursorPlan?: CursorQuotaPlan;
  cursorIncludedApiUsd?: number;
  cursorBillingCycleStartDay?: number;
  opencodeGoWindows?: Array<"rolling" | "weekly" | "monthly">;
  pricingSnapshot?: PricingSnapshotPatch;
  showOnIdle?: boolean;
  showOnQuestion?: boolean;
  showOnCompact?: boolean;
  showOnBothFail?: boolean;
  toastDurationMs?: number;
  onlyCurrentModel?: boolean;
  showSessionTokens?: boolean;
  tuiSidebarPanel?: TuiSidebarPanelPatch;
  tuiCompactStatus?: TuiCompactStatusPatch;
  maintainerAnnouncements?: MaintainerAnnouncementsPatch;
  layout?: LayoutPatch;
  export?: ExportConfigPatch;
};

type ConfigLayerScope = "global" | "workspace";
type ConfigLayerKind = "legacy" | "plugin";

interface ConfigLayerCandidate {
  path: string;
  scope: ConfigLayerScope;
  kind: ConfigLayerKind;
  pluginPath: string;
}

export function getQuotaToastConfigPath(configRootDir: string): string {
  return join(configRootDir, QUOTA_TOAST_CONFIG_RELATIVE_PATH);
}

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

const VALID_OPENCODE_GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;

function isValidOpenCodeGoWindows(value: unknown): value is Array<"rolling" | "weekly" | "monthly"> {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  return value.every((v) => typeof v === "string" && VALID_OPENCODE_GO_WINDOWS.includes(v as typeof VALID_OPENCODE_GO_WINDOWS[number]));
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function getExplicitFormatStyle(
  config: { formatStyle?: unknown } | undefined | null,
): QuotaToastConfig["formatStyle"] | undefined {
  if (!config || !isQuotaFormatStyle(config.formatStyle)) {
    return undefined;
  }

  return resolveQuotaFormatStyle(config.formatStyle);
}

function getConfiguredFormatStyle(
  quotaToastConfig: Partial<QuotaToastConfig> | undefined | null,
): QuotaToastConfig["formatStyle"] | undefined {
  const formatStyle = getExplicitFormatStyle(quotaToastConfig);
  if (formatStyle) {
    return formatStyle;
  }

  const legacyFormatStyle = (quotaToastConfig as { toastStyle?: unknown } | undefined | null)
    ?.toastStyle;
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
  return cloneConfig(DEFAULT_CONFIG);
}

function cloneConfig(config: QuotaToastConfig): QuotaToastConfig {
  return {
    ...config,
    enabledProviders: Array.isArray(config.enabledProviders)
      ? [...config.enabledProviders]
      : config.enabledProviders,
    googleModels: [...config.googleModels],
    opencodeGoWindows: [...config.opencodeGoWindows],
    pricingSnapshot: { ...config.pricingSnapshot },
    tuiSidebarPanel: { ...config.tuiSidebarPanel },
    tuiCompactStatus: { ...config.tuiCompactStatus },
    maintainerAnnouncements: { ...config.maintainerAnnouncements },
    layout: { ...config.layout },
    export: { ...config.export },
  };
}

type NormalizedEnabledProviders = {
  value?: string[] | "auto";
  issues: string[];
  invalidEmpty?: boolean;
};

function describeInvalidProviderValue(value: unknown): string {
  return typeof value === "string" ? value : typeof value;
}

function normalizeEnabledProviders(value: unknown): NormalizedEnabledProviders {
  if (value === "auto") {
    return { value: "auto", issues: [] };
  }

  if (!Array.isArray(value)) {
    return {
      value: [],
      issues: ["expected \"auto\" or an array of provider ids"],
      invalidEmpty: true,
    };
  }

  if (value.length === 0) {
    return { value: [], issues: [] };
  }

  const validProviders: string[] = [];
  const invalidProviders: string[] = [];

  for (const provider of value) {
    if (typeof provider !== "string") {
      invalidProviders.push(describeInvalidProviderValue(provider));
      continue;
    }

    const normalized = normalizeQuotaProviderId(provider);
    if (normalized && getQuotaProviderShape(normalized)) {
      validProviders.push(normalized);
    } else {
      invalidProviders.push(provider);
    }
  }

  const issues = invalidProviders.length
    ? [`unknown provider id(s): ${dedupe(invalidProviders).join(", ")}`]
    : [];

  const normalizedProviders = dedupe(validProviders);
  return {
    value: normalizedProviders,
    issues,
    invalidEmpty: normalizedProviders.length === 0 && invalidProviders.length > 0,
  };
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

function extractTuiSidebarPanelPatch(value: unknown): TuiSidebarPanelPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: TuiSidebarPanelPatch = {};

  if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
    patch.enabled = value.enabled;
  }

  const sidebarFormatStyle = getExplicitFormatStyle(value);
  if (sidebarFormatStyle) {
    patch.formatStyle = sidebarFormatStyle;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractTuiCompactStatusPatch(value: unknown): TuiCompactStatusPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: TuiCompactStatusPatch = {};

  if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
    patch.enabled = value.enabled;
  }

  if (hasOwnKey(value, "homeBottom") && typeof value.homeBottom === "boolean") {
    patch.homeBottom = value.homeBottom;
  }

  if (hasOwnKey(value, "sessionPrompt") && typeof value.sessionPrompt === "boolean") {
    patch.sessionPrompt = value.sessionPrompt;
  }

  if (
    hasOwnKey(value, "suppressWhenNativeProviderQuota") &&
    typeof value.suppressWhenNativeProviderQuota === "boolean"
  ) {
    patch.suppressWhenNativeProviderQuota = value.suppressWhenNativeProviderQuota;
  }

  if (hasOwnKey(value, "maxWidth") && isPositiveNumber(value.maxWidth)) {
    patch.maxWidth = value.maxWidth;
  }

  const compactFormatStyle = getExplicitFormatStyle(value);
  if (compactFormatStyle) {
    patch.formatStyle = compactFormatStyle;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractMaintainerAnnouncementsPatch(value: unknown): MaintainerAnnouncementsPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: MaintainerAnnouncementsPatch = {};

  if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
    patch.enabled = value.enabled;
  }

  if (hasOwnKey(value, "home") && typeof value.home === "boolean") {
    patch.home = value.home;
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

function extractExportConfigPatch(value: unknown): ExportConfigPatch | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const patch: ExportConfigPatch = {};

  if (hasOwnKey(value, "enabled") && typeof value.enabled === "boolean") {
    patch.enabled = value.enabled;
  }

  if (hasOwnKey(value, "path") && typeof value.path === "string") {
    patch.path = value.path;
  }

  return Object.keys(patch).length > 0 ? patch : undefined;
}

function extractValidatedQuotaToastPatch(
  quotaToastConfig: Record<string, unknown>,
  reportIssue?: (key: string, message: string) => void,
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

  if (
    hasOwnKey(quotaToastConfig, "requestTimeoutMs") &&
    isPositiveNumber(quotaToastConfig.requestTimeoutMs)
  ) {
    patch.requestTimeoutMs = quotaToastConfig.requestTimeoutMs;
  }

  if (hasOwnKey(quotaToastConfig, "debug") && typeof quotaToastConfig.debug === "boolean") {
    patch.debug = quotaToastConfig.debug;
  }

  if (hasOwnKey(quotaToastConfig, "enabledProviders")) {
    const enabledProviders = normalizeEnabledProviders(quotaToastConfig.enabledProviders);
    for (const issue of enabledProviders.issues) {
      reportIssue?.("enabledProviders", issue);
    }
    if (enabledProviders.value !== undefined) {
      patch.enabledProviders = enabledProviders.value;
      if (enabledProviders.invalidEmpty) {
        patch.enabledProvidersInvalidEmpty = true;
      }
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

  if (
    hasOwnKey(quotaToastConfig, "opencodeGoWindows") &&
    isValidOpenCodeGoWindows(quotaToastConfig.opencodeGoWindows)
  ) {
    patch.opencodeGoWindows = quotaToastConfig.opencodeGoWindows;
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

  if (hasOwnKey(quotaToastConfig, "tuiSidebarPanel")) {
    const tuiSidebarPanel = extractTuiSidebarPanelPatch(quotaToastConfig.tuiSidebarPanel);
    if (tuiSidebarPanel) {
      patch.tuiSidebarPanel = tuiSidebarPanel;
    }
  }

  if (hasOwnKey(quotaToastConfig, "tuiCompactStatus")) {
    const tuiCompactStatus = extractTuiCompactStatusPatch(quotaToastConfig.tuiCompactStatus);
    if (tuiCompactStatus) {
      patch.tuiCompactStatus = tuiCompactStatus;
    }
  }

  if (hasOwnKey(quotaToastConfig, "maintainerAnnouncements")) {
    const maintainerAnnouncements = extractMaintainerAnnouncementsPatch(
      quotaToastConfig.maintainerAnnouncements,
    );
    if (maintainerAnnouncements) {
      patch.maintainerAnnouncements = maintainerAnnouncements;
    }
  }

  if (hasOwnKey(quotaToastConfig, "layout")) {
    const layout = extractLayoutPatch(quotaToastConfig.layout);
    if (layout) {
      patch.layout = layout;
    }
  }

  if (hasOwnKey(quotaToastConfig, "export")) {
    const exportConfig = extractExportConfigPatch(quotaToastConfig.export);
    if (exportConfig) {
      patch.export = exportConfig;
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

  if (hasOwnKey(patch, "requestTimeoutMs")) {
    config.requestTimeoutMs = patch.requestTimeoutMs!;
    applySettingSource(settingSources, "requestTimeoutMs", sourcePath);
  }

  if (hasOwnKey(patch, "debug")) {
    config.debug = patch.debug!;
    applySettingSource(settingSources, "debug", sourcePath);
  }

  if (hasOwnKey(patch, "enabledProviders")) {
    if (!(patch.enabledProvidersInvalidEmpty && settingSources.enabledProviders)) {
      config.enabledProviders =
        patch.enabledProviders === "auto" ? "auto" : [...patch.enabledProviders!];
      applySettingSource(settingSources, "enabledProviders", sourcePath);
    }
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

  if (hasOwnKey(patch, "opencodeGoWindows")) {
    config.opencodeGoWindows = [...patch.opencodeGoWindows!];
    applySettingSource(settingSources, "opencodeGoWindows", sourcePath);
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

  if (patch.tuiSidebarPanel) {
    if (hasOwnKey(patch.tuiSidebarPanel, "enabled")) {
      config.tuiSidebarPanel.enabled = patch.tuiSidebarPanel.enabled!;
      applySettingSource(settingSources, "tuiSidebarPanel.enabled", sourcePath);
    }

    if (hasOwnKey(patch.tuiSidebarPanel, "formatStyle")) {
      config.tuiSidebarPanel.formatStyle = patch.tuiSidebarPanel.formatStyle!;
      applySettingSource(settingSources, "tuiSidebarPanel.formatStyle", sourcePath);
    }
  }

  if (patch.tuiCompactStatus) {
    if (hasOwnKey(patch.tuiCompactStatus, "enabled")) {
      config.tuiCompactStatus.enabled = patch.tuiCompactStatus.enabled!;
      applySettingSource(settingSources, "tuiCompactStatus.enabled", sourcePath);
    }

    if (hasOwnKey(patch.tuiCompactStatus, "homeBottom")) {
      config.tuiCompactStatus.homeBottom = patch.tuiCompactStatus.homeBottom!;
      applySettingSource(settingSources, "tuiCompactStatus.homeBottom", sourcePath);
    }

    if (hasOwnKey(patch.tuiCompactStatus, "sessionPrompt")) {
      config.tuiCompactStatus.sessionPrompt = patch.tuiCompactStatus.sessionPrompt!;
      applySettingSource(settingSources, "tuiCompactStatus.sessionPrompt", sourcePath);
    }

    if (hasOwnKey(patch.tuiCompactStatus, "suppressWhenNativeProviderQuota")) {
      config.tuiCompactStatus.suppressWhenNativeProviderQuota =
        patch.tuiCompactStatus.suppressWhenNativeProviderQuota!;
      applySettingSource(
        settingSources,
        "tuiCompactStatus.suppressWhenNativeProviderQuota",
        sourcePath,
      );
    }

    if (hasOwnKey(patch.tuiCompactStatus, "maxWidth")) {
      config.tuiCompactStatus.maxWidth = patch.tuiCompactStatus.maxWidth!;
      applySettingSource(settingSources, "tuiCompactStatus.maxWidth", sourcePath);
    }

    if (hasOwnKey(patch.tuiCompactStatus, "formatStyle")) {
      config.tuiCompactStatus.formatStyle = patch.tuiCompactStatus.formatStyle!;
      applySettingSource(settingSources, "tuiCompactStatus.formatStyle", sourcePath);
    }
  }

  if (patch.maintainerAnnouncements) {
    if (hasOwnKey(patch.maintainerAnnouncements, "enabled")) {
      config.maintainerAnnouncements.enabled = patch.maintainerAnnouncements.enabled!;
      applySettingSource(settingSources, "maintainerAnnouncements.enabled", sourcePath);
    }

    if (hasOwnKey(patch.maintainerAnnouncements, "home")) {
      config.maintainerAnnouncements.home = patch.maintainerAnnouncements.home!;
      applySettingSource(settingSources, "maintainerAnnouncements.home", sourcePath);
    }

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

  if (patch.export) {
    if (hasOwnKey(patch.export, "enabled")) {
      config.export.enabled = patch.export.enabled!;
      applySettingSource(settingSources, "export.enabled", sourcePath);
    }

    if (hasOwnKey(patch.export, "path")) {
      config.export.path = patch.export.path!;
      applySettingSource(settingSources, "export.path", sourcePath);
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

function buildConfigLayerCandidatesForRoot(
  dir: string,
  scope: ConfigLayerScope,
): ConfigLayerCandidate[] {
  const pluginPath = getQuotaToastConfigPath(dir);
  return [
    {
      path: pluginPath,
      scope,
      kind: "plugin" as const,
      pluginPath,
    },
    ...CONFIG_FILENAMES.map((filename) => ({
      path: join(dir, filename),
      scope,
      kind: "legacy" as const,
      pluginPath,
    })),
  ];
}

function buildConfigLayerCandidates(
  configDirs: string[],
  configRootDir: string,
): ConfigLayerCandidate[] {
  const workspaceCandidates = buildConfigLayerCandidatesForRoot(configRootDir, "workspace");
  const workspacePaths = new Set(workspaceCandidates.map((candidate) => candidate.path));
  const globalCandidates = configDirs.flatMap((dir) =>
    buildConfigLayerCandidatesForRoot(dir, "global"),
  );

  return [
    ...globalCandidates.filter((candidate) => !workspacePaths.has(candidate.path)),
    ...workspaceCandidates,
  ];
}

function getConfigLayerSourceLabel(candidate: ConfigLayerCandidate): string {
  const suffix =
    candidate.kind === "plugin" ? QUOTA_TOAST_CONFIG_RELATIVE_PATH : "experimental.quotaToast";
  return `${candidate.path} (${suffix})`;
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
    configIssues: LoadConfigIssue[];
  }> {
    const configRootDir = options?.configRootDir ?? getEffectiveConfigRoot(options?.cwd ?? process.cwd());
    const { configDirs } = getOpencodeRuntimeDirCandidates();
    const config = cloneDefaultConfig();
    const usedPaths: string[] = [];
    const globalConfigPaths: string[] = [];
    const workspaceConfigPaths: string[] = [];
    const settingSources: QuotaToastSettingSources = {};
    const configIssues: LoadConfigIssue[] = [];

    for (const candidate of buildConfigLayerCandidates(configDirs, configRootDir)) {
      if (candidate.kind === "legacy" && existsSync(candidate.pluginPath)) {
        continue;
      }

      if (!existsSync(candidate.path)) {
        continue;
      }

      const parsed = await readJson(candidate.path);
      if (!isPlainObject(parsed)) {
        if (candidate.kind === "plugin") {
          const sourcePath = getConfigLayerSourceLabel(candidate);
          usedPaths.push(sourcePath);
          if (candidate.scope === "global") {
            globalConfigPaths.push(sourcePath);
          } else {
            workspaceConfigPaths.push(sourcePath);
          }
          configIssues.push({
            path: sourcePath,
            key: "$root",
            message: "expected readable JSON object",
          });
        }
        continue;
      }

      const extractedQuotaToast =
        candidate.kind === "plugin"
          ? parsed
          : isPlainObject(parsed.experimental)
            ? parsed.experimental.quotaToast
            : undefined;
      if (!isPlainObject(extractedQuotaToast)) {
        continue;
      }

      const sourcePath = getConfigLayerSourceLabel(candidate);
      usedPaths.push(sourcePath);
      if (candidate.scope === "global") {
        globalConfigPaths.push(sourcePath);
      } else {
        workspaceConfigPaths.push(sourcePath);
      }

      applyValidatedQuotaToastPatch(
        config,
        extractValidatedQuotaToastPatch(extractedQuotaToast, (key, message) => {
          configIssues.push({ path: sourcePath, key, message });
        }),
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
        configIssues: [],
      };
    }

    return {
      config,
      usedPaths,
      globalConfigPaths,
      workspaceConfigPaths,
      settingSources,
      networkSettingSources: projectNetworkSettingSources(settingSources),
      configIssues,
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
      meta.configIssues = fileConfig.configIssues;
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
        const configIssues: LoadConfigIssue[] = [];
        applyValidatedQuotaToastPatch(
          config,
          extractValidatedQuotaToastPatch(quotaToastConfig, (key, message) => {
            configIssues.push({ path: "client.config.get", key, message });
          }),
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
          meta.configIssues = configIssues;
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
    meta.configIssues = [];
  }
  return cloneDefaultConfig();
}
