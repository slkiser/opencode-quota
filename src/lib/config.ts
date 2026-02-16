/**
 * Configuration loader for opencode-quota plugin
 *
 * Primary: reads configuration from OpenCode's merged config via the SDK client.
 * Fallback: reads local config files directly.
 */

import type { QuotaToastConfig, GoogleModelId } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { parseJsonOrJsonc } from "./jsonc.js";

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface LoadConfigMeta {
  source: "sdk" | "files" | "defaults";
  paths: string[];
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

/**
 * Normalize a provider ID for consistent matching.
 * - Trims whitespace and lowercases
 * - Maps known synonyms to canonical IDs
 */
function normalizeProviderId(id: string): string {
  const s = id.trim().toLowerCase();
  switch (s) {
    case "github-copilot":
    case "copilot-chat":
    case "github-copilot-chat":
      return "copilot";
    default:
      return s;
  }
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
 * @param client - OpenCode SDK client
 * @returns Merged configuration with defaults
 */
export async function loadConfig(
  client: {
    config: {
      get: () => Promise<{ data?: { experimental?: { quotaToast?: Partial<QuotaToastConfig> } } }>;
    };
  },
  meta?: LoadConfigMeta,
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

      toastStyle:
        quotaToastConfig.toastStyle === "grouped" || quotaToastConfig.toastStyle === "classic"
          ? quotaToastConfig.toastStyle
          : DEFAULT_CONFIG.toastStyle,
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
                  .map(normalizeProviderId)
                  .filter(Boolean),
              )
            : DEFAULT_CONFIG.enabledProviders,
      googleModels: Array.isArray(quotaToastConfig.googleModels)
        ? quotaToastConfig.googleModels.filter(isValidGoogleModelId)
        : DEFAULT_CONFIG.googleModels,
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

  async function loadFromFiles(): Promise<QuotaToastConfig> {
    const cwd = process.cwd();
    const { configDirs } = getOpencodeRuntimeDirCandidates();

    // Order: global first, then local overrides.
    // Within each location, load .json first, then .jsonc so that
    // .jsonc takes precedence on key collisions (matching the documented intent).
    const locations = [...configDirs, cwd];

    const quota: Partial<QuotaToastConfig> = {};
    const usedPaths: string[] = [];

    for (const dir of locations) {
      for (const filename of ["opencode.json", "opencode.jsonc"]) {
        const p = join(dir, filename);
        if (!existsSync(p)) continue;
        const parsed = await readJson(p);
        if (!parsed || typeof parsed !== "object") continue;

        const root = parsed as any;

        const picks: Array<{ key: string; value: unknown }> = [
          { key: "experimental.quotaToast", value: root?.experimental?.quotaToast },
        ];

        const usedKeys: string[] = [];
        for (const pick of picks) {
          if (!pick.value || typeof pick.value !== "object") continue;
          Object.assign(quota, pick.value);
          usedKeys.push(pick.key);
        }

        if (usedKeys.length > 0) {
          usedPaths.push(`${p} (${usedKeys.join(", ")})`);
        }
      }
    }

    if (meta) {
      meta.source = usedPaths.length > 0 ? "files" : "defaults";
      meta.paths = usedPaths;
    }

    return normalize(Object.keys(quota).length > 0 ? quota : null);
  }

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

    return await loadFromFiles();
  } catch {
    return await loadFromFiles();
  }
}
