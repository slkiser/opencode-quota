/**
 * Generic API key resolution from env vars, config files, and auth.json.
 *
 * Used by provider-specific config modules (firmware-config, chutes-config)
 * to resolve API keys with consistent priority and behavior.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { parseJsonOrJsonc } from "./jsonc.js";

/** A candidate config file path with its format */
export interface ConfigCandidate {
  path: string;
  isJsonc: boolean;
}

/**
 * Get candidate paths for opencode.json/opencode.jsonc files.
 *
 * Order: local (cwd) first, then global (~/.config/opencode).
 * Within each location, .jsonc takes precedence over .json.
 */
export function getOpencodeConfigCandidatePaths(): ConfigCandidate[] {
  const cwd = process.cwd();
  const { configDirs } = getOpencodeRuntimeDirCandidates();

  const global: ConfigCandidate[] = [];
  for (const dir of configDirs) {
    global.push({ path: join(dir, "opencode.jsonc"), isJsonc: true });
    global.push({ path: join(dir, "opencode.json"), isJsonc: false });
  }

  return [
    { path: join(cwd, "opencode.jsonc"), isJsonc: true },
    { path: join(cwd, "opencode.json"), isJsonc: false },
    ...global,
  ];
}

/**
 * Read and parse an opencode config file.
 *
 * @returns Parsed config with metadata, or null if file doesn't exist or is invalid
 */
export async function readOpencodeConfig(
  filePath: string,
  isJsonc: boolean,
): Promise<{ config: unknown; path: string; isJsonc: boolean } | null> {
  try {
    if (!existsSync(filePath)) return null;
    const content = await readFile(filePath, "utf-8");
    const config = parseJsonOrJsonc(content, isJsonc);
    return { config, path: filePath, isJsonc };
  } catch {
    return null;
  }
}

/** Result of API key resolution */
export interface ApiKeyResult<Source extends string> {
  key: string;
  source: Source;
}

/** Environment variable definition for key resolution */
export interface EnvVarDef<Source extends string> {
  name: string;
  source: Source;
}

/** Configuration for resolving an API key from multiple sources */
export interface ResolveApiKeyConfig<Source extends string> {
  /** Environment variables to check (in order) */
  envVars: EnvVarDef<Source>[];

  /** Extract API key from parsed config object. Returns null if not found. */
  extractFromConfig: (config: unknown) => string | null;

  /** Source label for opencode.json */
  configJsonSource: Source;

  /** Source label for opencode.jsonc */
  configJsoncSource: Source;

  /** Extract API key from auth.json data. Returns null if not found. */
  extractFromAuth: (auth: unknown) => string | null;

  /** Source label for auth.json */
  authSource: Source;
}

/**
 * Resolve an API key from multiple sources with consistent priority.
 *
 * Priority (first wins):
 * 1. Environment variables (in order specified)
 * 2. opencode.json/opencode.jsonc (local first, then global)
 * 3. auth.json
 *
 * @returns API key and source, or null if not found
 */
export async function resolveApiKey<Source extends string>(
  config: ResolveApiKeyConfig<Source>,
  readAuth: () => Promise<unknown | null>,
): Promise<ApiKeyResult<Source> | null> {
  // 1. Check environment variables (highest priority)
  for (const envVar of config.envVars) {
    const value = process.env[envVar.name]?.trim();
    if (value && value.length > 0) {
      return { key: value, source: envVar.source };
    }
  }

  // 2. Check opencode.json/opencode.jsonc files
  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    const result = await readOpencodeConfig(candidate.path, candidate.isJsonc);
    if (!result) continue;

    const key = config.extractFromConfig(result.config);
    if (key) {
      return {
        key,
        source: result.isJsonc ? config.configJsoncSource : config.configJsonSource,
      };
    }
  }

  // 3. Fallback to auth.json
  const auth = await readAuth();
  const key = config.extractFromAuth(auth);
  if (key) {
    return { key, source: config.authSource };
  }

  return null;
}

/** Configuration for API key diagnostics */
export interface DiagnosticsConfig<Source extends string> {
  /** Environment variable names to check */
  envVarNames: string[];

  /** Resolver function to get the current key result */
  resolve: () => Promise<ApiKeyResult<Source> | null>;
}

/**
 * Get diagnostic info about API key configuration.
 *
 * Reports which sources were checked (env vars that exist, config files that exist)
 * and whether a key was found.
 */
export async function getApiKeyDiagnostics<Source extends string>(
  config: DiagnosticsConfig<Source>,
): Promise<{
  configured: boolean;
  source: Source | null;
  checkedPaths: string[];
}> {
  const checkedPaths: string[] = [];

  // Track env vars checked (only if they exist, even if empty)
  for (const envVarName of config.envVarNames) {
    if (process.env[envVarName] !== undefined) {
      checkedPaths.push(`env:${envVarName}`);
    }
  }

  // Track config files checked (only if they exist)
  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      checkedPaths.push(candidate.path);
    }
  }

  const result = await config.resolve();

  return {
    configured: result !== null,
    source: result?.source ?? null,
    checkedPaths,
  };
}
