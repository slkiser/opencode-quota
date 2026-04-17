/**
 * Configuration loader for opencode-quota plugin.
 *
 * Precedence model:
 * - Global/user config provides defaults.
 * - Project/workspace config overrides those defaults for the current project.
 * - SDK config is used only as a fallback when no config files are found.
 */

import type {
  CursorQuotaPlan,
  QuotaToastConfig,
  GoogleModelId,
  PricingSnapshotSource,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { normalizeQuotaProviderId } from "./provider-metadata.js";

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface LoadConfigMeta {
  source: "sdk" | "files" | "defaults";
  paths: string[];
}

export interface LoadConfigOptions {
  cwd?: string;
}

export function createLoadConfigMeta(): LoadConfigMeta {
  return { source: "defaults", paths: [] };
}

/**
 * Validates and normalizes a Google model ID
 */
function isValidGoogleModelId(id: unknown): id is GoogleModelId {
  return typeof id === "string" && ["G3PRO", "G3FLASH", "CLAUDE", "G3IMAGE"].includes(id);
}

function isValidCursorQuotaPlan(plan: unknown): plan is CursorQuotaPlan {
  return (
    typeof plan === "string" &&
    ["none", "pro", "pro-plus", "ultra"].includes(plan)
  );
}

function isValidPricingSnapshotSource(source: unknown): source is PricingSnapshotSource {
  return typeof source === "string" && ["auto", "bundled", "runtime"].includes(source);
}

function isValidPricingSnapshotAutoRefresh(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Remove duplicates from an array while preserving order
 */
function dedupe<T>(list: T[]): T[] {
  return [...new Set(list)];
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
  function normalize(
    quotaToastConfig: Partial<QuotaToastConfig> | undefined | null,
  ): QuotaToastConfig {
    if (!quotaToastConfig) return DEFAULT_CONFIG;

    const config: QuotaToastConfig = {
      enabled:
        typeof quotaToastConfig.enabled === "boolean"
          ? quotaToastConfig.enabled
          : DEFAULT_CONFIG.enabled,

      enableToast:
        typeof quotaToastConfig.enableToast === "boolean"
          ? quotaToastConfig.enableToast
          : DEFAULT_CONFIG.enableToast,

      formatStyle:
        quotaToastConfig.formatStyle === "grouped" || quotaToastConfig.formatStyle === "classic"
          ? quotaToastConfig.formatStyle
          : DEFAULT_CONFIG.formatStyle,
      minIntervalMs:
        typeof quotaToastConfig.minIntervalMs === "number" && quotaToastConfig.minIntervalMs > 0
          ? quotaToastConfig.minIntervalMs
          : DEFAULT_CONFIG.minIntervalMs,

      debug:
        typeof quotaToastConfig.debug === "boolean" ? quotaToastConfig.debug : DEFAULT_CONFIG.debug,

      enabledProviders:
        quotaToastConfig.enabledProviders === "auto"
          ? "auto"
          : Array.isArray(quotaToastConfig.enabledProviders)
            ? dedupe(
                quotaToastConfig.enabledProviders
                  .filter((p): p is string => typeof p === "string")
                  .map(normalizeQuotaProviderId)
                  .filter(Boolean),
              )
            : DEFAULT_CONFIG.enabledProviders,
      anthropicBinaryPath:
        normalizeOptionalString(quotaToastConfig.anthropicBinaryPath) ??
        DEFAULT_CONFIG.anthropicBinaryPath,
      googleModels: Array.isArray(quotaToastConfig.googleModels)
        ? quotaToastConfig.googleModels.filter(isValidGoogleModelId)
        : DEFAULT_CONFIG.googleModels,
      alibabaCodingPlanTier:
        quotaToastConfig.alibabaCodingPlanTier === "lite" ||
        quotaToastConfig.alibabaCodingPlanTier === "pro"
          ? quotaToastConfig.alibabaCodingPlanTier
          : DEFAULT_CONFIG.alibabaCodingPlanTier,
      cursorPlan: isValidCursorQuotaPlan(quotaToastConfig.cursorPlan)
        ? quotaToastConfig.cursorPlan
        : DEFAULT_CONFIG.cursorPlan,
      cursorIncludedApiUsd:
        typeof quotaToastConfig.cursorIncludedApiUsd === "number" &&
        Number.isFinite(quotaToastConfig.cursorIncludedApiUsd) &&
        quotaToastConfig.cursorIncludedApiUsd > 0
          ? quotaToastConfig.cursorIncludedApiUsd
          : undefined,
      cursorBillingCycleStartDay:
        typeof quotaToastConfig.cursorBillingCycleStartDay === "number" &&
        Number.isInteger(quotaToastConfig.cursorBillingCycleStartDay) &&
        quotaToastConfig.cursorBillingCycleStartDay >= 1 &&
        quotaToastConfig.cursorBillingCycleStartDay <= 28
          ? quotaToastConfig.cursorBillingCycleStartDay
          : undefined,
      pricingSnapshot: {
        source: isValidPricingSnapshotSource(quotaToastConfig.pricingSnapshot?.source)
          ? quotaToastConfig.pricingSnapshot.source
          : DEFAULT_CONFIG.pricingSnapshot.source,
        autoRefresh: isValidPricingSnapshotAutoRefresh(quotaToastConfig.pricingSnapshot?.autoRefresh)
          ? quotaToastConfig.pricingSnapshot.autoRefresh
          : DEFAULT_CONFIG.pricingSnapshot.autoRefresh,
      },
      showOnIdle:
        typeof quotaToastConfig.showOnIdle === "boolean"
          ? quotaToastConfig.showOnIdle
          : DEFAULT_CONFIG.showOnIdle,
      showOnQuestion:
        typeof quotaToastConfig.showOnQuestion === "boolean"
          ? quotaToastConfig.showOnQuestion
          : DEFAULT_CONFIG.showOnQuestion,
      showOnCompact:
        typeof quotaToastConfig.showOnCompact === "boolean"
          ? quotaToastConfig.showOnCompact
          : DEFAULT_CONFIG.showOnCompact,
      showOnBothFail:
        typeof quotaToastConfig.showOnBothFail === "boolean"
          ? quotaToastConfig.showOnBothFail
          : DEFAULT_CONFIG.showOnBothFail,
      toastDurationMs:
        typeof quotaToastConfig.toastDurationMs === "number" && quotaToastConfig.toastDurationMs > 0
          ? quotaToastConfig.toastDurationMs
          : DEFAULT_CONFIG.toastDurationMs,
      onlyCurrentModel:
        typeof quotaToastConfig.onlyCurrentModel === "boolean"
          ? quotaToastConfig.onlyCurrentModel
          : DEFAULT_CONFIG.onlyCurrentModel,
      showSessionTokens:
        typeof quotaToastConfig.showSessionTokens === "boolean"
          ? quotaToastConfig.showSessionTokens
          : DEFAULT_CONFIG.showSessionTokens,
      layout: {
        maxWidth:
          typeof quotaToastConfig.layout?.maxWidth === "number" &&
          quotaToastConfig.layout.maxWidth > 0
            ? quotaToastConfig.layout.maxWidth
            : DEFAULT_CONFIG.layout.maxWidth,
        narrowAt:
          typeof quotaToastConfig.layout?.narrowAt === "number" &&
          quotaToastConfig.layout.narrowAt > 0
            ? quotaToastConfig.layout.narrowAt
            : DEFAULT_CONFIG.layout.narrowAt,
        tinyAt:
          typeof quotaToastConfig.layout?.tinyAt === "number" && quotaToastConfig.layout.tinyAt > 0
            ? quotaToastConfig.layout.tinyAt
            : DEFAULT_CONFIG.layout.tinyAt,
      },
    };

    // enabledProviders: "auto" means auto-detect; explicit array means user-specified.

    // Ensure at least one Google model is configured
    if (config.googleModels.length === 0) {
      config.googleModels = DEFAULT_CONFIG.googleModels;
    }

    return config;
  }

  async function readJson(path: string): Promise<unknown | null> {
    try {
      const content = await readFile(path, "utf-8");
      return parseJsonOrJsonc(content, path.endsWith(".jsonc"));
    } catch {
      return null;
    }
  }

  async function loadQuotaToastFromLocations(locations: string[]): Promise<{
    quota: Partial<QuotaToastConfig>;
    usedPaths: string[];
  }> {
    const quota: Partial<QuotaToastConfig> = {};
    const usedPaths: string[] = [];

    for (const dir of locations) {
      for (const filename of ["opencode.json", "opencode.jsonc"]) {
        const p = join(dir, filename);
        if (!existsSync(p)) continue;
        const parsed = await readJson(p);
        if (!parsed || typeof parsed !== "object") continue;

        const root = parsed as any;
        const rawQuotaToast = root?.experimental?.quotaToast;
        if (!rawQuotaToast || typeof rawQuotaToast !== "object") continue;

        Object.assign(quota, rawQuotaToast);
        usedPaths.push(`${p} (experimental.quotaToast)`);
      }
    }

    return { quota, usedPaths };
  }

  async function loadFromFiles(): Promise<{
    config: QuotaToastConfig | null;
    usedPaths: string[];
  }> {
    const cwd = options?.cwd ?? process.cwd();
    const { configDirs } = getOpencodeRuntimeDirCandidates();
    const globalConfig = await loadQuotaToastFromLocations(configDirs);
    const localConfig = await loadQuotaToastFromLocations([cwd]);

    const usedPaths = [...globalConfig.usedPaths, ...localConfig.usedPaths];
    if (usedPaths.length === 0) {
      return { config: null, usedPaths: [] };
    }

    const quota: Partial<QuotaToastConfig> = {
      ...globalConfig.quota,
      ...localConfig.quota,
    };

    return {
      config: normalize(quota),
      usedPaths,
    };
  }

  const fileConfig = await loadFromFiles();
  if (fileConfig.config) {
    if (meta) {
      meta.source = "files";
      meta.paths = fileConfig.usedPaths;
    }
    return fileConfig.config;
  }

  if (client) {
    try {
      const response = await client.config.get();

      // OpenCode config schema is strict; plugin-specific config must live under
      // experimental.* to avoid "unrecognized key" validation errors.
      const quotaToastConfig = (response.data as any)?.experimental?.quotaToast as
        | Partial<QuotaToastConfig>
        | undefined;

      if (quotaToastConfig && typeof quotaToastConfig === "object") {
        if (meta) {
          meta.source = "sdk";
          meta.paths = ["client.config.get"];
        }
        return normalize(quotaToastConfig);
      }
    } catch {
      // ignore; fall back to defaults below
    }
  }

  if (meta) {
    meta.source = "defaults";
    meta.paths = [];
  }
  return DEFAULT_CONFIG;
}
