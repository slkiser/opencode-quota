/**
 * Generic API key resolution from env vars, config files, and auth.json.
 *
 * Used by provider-specific config modules (synthetic-config, chutes-config)
 * to resolve API keys with consistent priority and behavior.
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { resolveEnvTemplate } from "./env-template.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { parseJsonOrJsonc } from "./jsonc.js";

/** A candidate config file path with its format */
export interface ConfigCandidate {
  path: string;
  isJsonc: boolean;
}

function buildOpencodeConfigCandidates(configDirs: readonly string[]): ConfigCandidate[] {
  const candidates: ConfigCandidate[] = [];
  for (const dir of configDirs) {
    candidates.push({ path: join(dir, "opencode.jsonc"), isJsonc: true });
    candidates.push({ path: join(dir, "opencode.json"), isJsonc: false });
  }
  return candidates;
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

  return [
    { path: join(cwd, "opencode.jsonc"), isJsonc: true },
    { path: join(cwd, "opencode.json"), isJsonc: false },
    ...buildOpencodeConfigCandidates(configDirs),
  ];
}

/**
 * Get trusted global-only candidate paths for opencode.json/opencode.jsonc files.
 *
 * Provider secrets must not be sourced from repo-local config because the
 * current workspace may be untrusted.
 */
export function getGlobalOpencodeConfigCandidatePaths(): ConfigCandidate[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return buildOpencodeConfigCandidates(configDirs);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function getFirstAuthEntryValue(
  auth: unknown,
  authKeys: readonly string[],
): unknown {
  const root = asRecord(auth);
  if (!root) return undefined;

  for (const authKey of authKeys) {
    if (Object.prototype.hasOwnProperty.call(root, authKey)) {
      return root[authKey];
    }
  }

  return undefined;
}

export function getFirstAuthEntryRecord(
  auth: unknown,
  authKeys: readonly string[],
): Record<string, unknown> | null {
  return asRecord(getFirstAuthEntryValue(auth, authKeys));
}

export function extractProviderOptionsApiKey(
  config: unknown,
  params: {
    providerKeys: readonly string[];
    allowedEnvVars?: readonly string[];
  },
): string | null {
  const provider = asRecord(asRecord(config)?.provider);
  if (!provider) return null;

  for (const providerKey of params.providerKeys) {
    const options = asRecord(asRecord(provider[providerKey])?.options);
    const apiKey = options?.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) continue;

    const trimmed = apiKey.trim();
    if (!params.allowedEnvVars) return trimmed;

    const resolved = resolveEnvTemplate(trimmed, params.allowedEnvVars);
    if (resolved) return resolved;
  }

  return null;
}

export function extractAuthApiKeyEntry(
  auth: unknown,
  authKeys: readonly string[],
): string | null {
  for (const authKey of authKeys) {
    const record = getFirstAuthEntryRecord(auth, [authKey]);
    const key = record?.key;
    if (record?.type === "api" && typeof key === "string" && key.trim().length > 0) {
      return key.trim();
    }
  }

  return null;
}

/** Configuration for resolving an API key from trusted env/config sources */
export interface ResolveEnvAndConfigApiKeyConfig<Source extends string> {
  /** Environment variables to check (in order) */
  envVars: EnvVarDef<Source>[];

  /** Extract API key from parsed config object. Returns null if not found. */
  extractFromConfig: (config: unknown) => string | null;

  /** Source label for opencode.json */
  configJsonSource: Source;

  /** Source label for opencode.jsonc */
  configJsoncSource: Source;

  /**
   * Candidate config file paths to trust for provider-secret lookup.
   *
   * Defaults to trusted user/global OpenCode config paths only.
   */
  getConfigCandidates?: () => ConfigCandidate[];
}

/** Configuration for resolving an API key from multiple sources */
export interface ResolveApiKeyConfig<Source extends string>
  extends ResolveEnvAndConfigApiKeyConfig<Source> {

  /** Extract API key from auth.json data. Returns null if not found. */
  extractFromAuth: (auth: unknown) => string | null;

  /** Source label for auth.json */
  authSource: Source;
}

export interface ApiKeyCheckedPathsConfig {
  /** Environment variable names to check */
  envVarNames: string[];

  /**
   * Candidate config file paths to report for provider-secret lookup.
   *
   * Defaults to trusted user/global OpenCode config paths only.
   */
  getConfigCandidates?: () => ConfigCandidate[];
}

/**
 * Resolve an API key from trusted env vars and config files.
 *
 * Priority (first wins):
 * 1. Environment variables (in order specified)
 * 2. Trusted user/global opencode.json/opencode.jsonc candidates
 */
export async function resolveApiKeyFromEnvAndConfig<Source extends string>(
  config: ResolveEnvAndConfigApiKeyConfig<Source>,
): Promise<ApiKeyResult<Source> | null> {
  for (const envVar of config.envVars) {
    const value = process.env[envVar.name]?.trim();
    if (value && value.length > 0) {
      return { key: value, source: envVar.source };
    }
  }

  const candidates = config.getConfigCandidates?.() ?? getGlobalOpencodeConfigCandidatePaths();
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

  return null;
}

export function getApiKeyCheckedPaths(config: ApiKeyCheckedPathsConfig): string[] {
  const checkedPaths: string[] = [];

  for (const envVarName of config.envVarNames) {
    if (process.env[envVarName] !== undefined) {
      checkedPaths.push(`env:${envVarName}`);
    }
  }

  const candidates = config.getConfigCandidates?.() ?? getGlobalOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      checkedPaths.push(candidate.path);
    }
  }

  return checkedPaths;
}

/**
 * Resolve an API key from multiple sources with consistent priority.
 *
 * Priority (first wins):
 * 1. Environment variables (in order specified)
 * 2. Trusted user/global opencode.json/opencode.jsonc
 * 3. auth.json
 *
 * @returns API key and source, or null if not found
 */
export async function resolveApiKey<Source extends string>(
  config: ResolveApiKeyConfig<Source>,
  readAuth: () => Promise<unknown | null>,
): Promise<ApiKeyResult<Source> | null> {
  const resolvedFromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(config);
  if (resolvedFromEnvOrConfig) {
    return resolvedFromEnvOrConfig;
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

  /** Candidate config file paths to report for provider-secret lookup. */
  getConfigCandidates?: () => ConfigCandidate[];
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
  const checkedPaths = getApiKeyCheckedPaths(config);
  const result = await config.resolve();

  return {
    configured: result !== null,
    source: result?.source ?? null,
    checkedPaths,
  };
}
