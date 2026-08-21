/**
 * Generic API key resolution from env vars, config files, and opencode.db.
 *
 * Used by provider-specific config modules (synthetic-config, chutes-config)
 * to resolve API keys with consistent priority and behavior.
 */

import { existsSync } from "fs";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { resolveEnvTemplate } from "./env-template.js";
import {
  buildOpenCodeConfigCandidates,
  readOpenCodeConfigCandidate,
} from "./opencode-config-read.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

/** A candidate config file path with its format */
export interface ConfigCandidate {
  path: string;
  isJsonc: boolean;
}

function buildOpencodeConfigCandidates(configDirs: readonly string[]): ConfigCandidate[] {
  return buildOpenCodeConfigCandidates({
    directories: configDirs,
    formatOrder: ["jsonc", "json"],
  }).map((candidate) => ({
    path: candidate.path,
    isJsonc: candidate.format === "jsonc",
  }));
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

  return [...buildOpencodeConfigCandidates([cwd]), ...buildOpencodeConfigCandidates(configDirs)];
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
  const result = await readOpenCodeConfigCandidate({
    path: filePath,
    format: isJsonc ? "jsonc" : "json",
  });
  return result.state === "parsed" ? { config: result.value, path: filePath, isJsonc } : null;
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

export function getFirstAuthEntryValue(auth: unknown, authKeys: readonly string[]): unknown {
  const root = asRecord(auth);
  if (!root) return undefined;

  for (const authKey of authKeys) {
    if (Object.hasOwn(root, authKey)) {
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

export function extractAuthApiKeyEntry(auth: unknown, authKeys: readonly string[]): string | null {
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
  /** Extract API key from opencode.db data. Returns null if not found. */
  extractFromAuth: (auth: unknown) => string | null;

  /** Source label for opencode.db */
  authSource: Source;
}

/** Shared configuration for provider-specific API key resolution. */
export interface ResolveProviderApiKeyBaseConfig<Source extends string> {
  envVars: EnvVarDef<Source>[];
  providerKeys: readonly string[];
  allowedEnvVars?: readonly string[];
  configJsonSource: Source;
  configJsoncSource: Source;
  getConfigCandidates?: () => ConfigCandidate[];
}

export interface StrictApiKeyAuthConfig<Source extends string> {
  policy?: "strict-api-key";
  readAuth: () => Promise<unknown | null>;
  getCredentialDatabasePaths?: () => string[];
  authKeys?: readonly string[];
  authSource: Source;
}

export interface InvalidAwareApiKeyAuthConfig<AuthSource extends string> {
  policy: "invalid-aware-api-key";
  readAuth: (maxAgeMs: number) => Promise<unknown | null>;
  getCredentialDatabasePaths: () => string[];
  authKeys: readonly string[];
  authSource: AuthSource;
  displayName: string;
  defaultMaxAgeMs: number;
  unsupportedTypeError?: string;
}

/** Configuration for simple nullable API key resolution. */
export interface ResolveProviderApiKeyConfig<Source extends string>
  extends ResolveProviderApiKeyBaseConfig<Source> {
  auth?: StrictApiKeyAuthConfig<Source>;
}

/** Configuration for providers that surface malformed winning opencode.db entries. */
export interface ResolveInvalidAwareProviderApiKeyConfig<
  Source extends string,
  AuthSource extends Source,
> extends ResolveProviderApiKeyBaseConfig<Source> {
  auth: InvalidAwareApiKeyAuthConfig<AuthSource>;
}

export type InvalidAwareAuthResult =
  | { state: "none" }
  | { state: "configured"; apiKey: string }
  | { state: "invalid"; error: string };

export type InvalidAwareAuthDiagnostics<Source extends string, AuthSource extends Source> =
  | {
      state: "none";
      source: null;
      checkedPaths: string[];
      credentialDatabasePaths: string[];
    }
  | {
      state: "configured";
      source: Source;
      checkedPaths: string[];
      credentialDatabasePaths: string[];
    }
  | {
      state: "invalid";
      source: AuthSource;
      checkedPaths: string[];
      credentialDatabasePaths: string[];
      error: string;
    };

export interface ProviderApiKeyResolver<Source extends string> {
  resolve: () => Promise<ApiKeyResult<Source> | null>;
  has: () => Promise<boolean>;
  diagnostics: () => Promise<{
    configured: boolean;
    source: Source | null;
    checkedPaths: string[];
    credentialDatabasePaths: string[];
  }>;
}

export interface InvalidAwareProviderApiKeyResolver<
  Source extends string,
  AuthSource extends Source,
> {
  parseAuth: (auth: unknown) => InvalidAwareAuthResult;
  resolve: (params?: { maxAgeMs?: number }) => Promise<InvalidAwareAuthResult>;
  diagnostics: (params?: {
    maxAgeMs?: number;
  }) => Promise<InvalidAwareAuthDiagnostics<Source, AuthSource>>;
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

function buildProviderEnvAndConfig<Source extends string>(
  config: ResolveProviderApiKeyBaseConfig<Source>,
): ResolveEnvAndConfigApiKeyConfig<Source> {
  return {
    envVars: config.envVars,
    extractFromConfig: (candidate) =>
      extractProviderOptionsApiKey(candidate, {
        providerKeys: config.providerKeys,
        allowedEnvVars: config.allowedEnvVars,
      }),
    configJsonSource: config.configJsonSource,
    configJsoncSource: config.configJsoncSource,
    getConfigCandidates: config.getConfigCandidates,
  };
}

function parseInvalidAwareAuth(
  auth: unknown,
  config: InvalidAwareApiKeyAuthConfig<string>,
): InvalidAwareAuthResult {
  const entry = getFirstAuthEntryValue(auth, config.authKeys);
  if (entry === null || entry === undefined) return { state: "none" };
  if (typeof entry !== "object") {
    return { state: "invalid", error: `${config.displayName} auth entry has invalid shape` };
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.type !== "string") {
    return {
      state: "invalid",
      error: `${config.displayName} auth entry present but type is missing or invalid`,
    };
  }
  if (record.type !== "api") {
    const sanitized = sanitizeDisplayText(record.type).replace(/\s+/g, " ").trim();
    return {
      state: "invalid",
      error:
        config.unsupportedTypeError ??
        `Unsupported ${config.displayName} auth type: "${(sanitized || "unknown").slice(0, 120)}"`,
    };
  }

  const apiKey = typeof record.key === "string" ? record.key.trim() : "";
  return apiKey
    ? { state: "configured", apiKey }
    : {
        state: "invalid",
        error: `${config.displayName} auth entry present but key is empty`,
      };
}

function createInvalidAwareProviderApiKeyResolver<Source extends string, AuthSource extends Source>(
  config: ResolveInvalidAwareProviderApiKeyConfig<Source, AuthSource>,
): InvalidAwareProviderApiKeyResolver<Source, AuthSource> {
  const parseAuth = (auth: unknown) => parseInvalidAwareAuth(auth, config.auth);
  const resolveWithSource = async (params?: { maxAgeMs?: number }) => {
    const envOrConfig = await resolveApiKeyFromEnvAndConfig(buildProviderEnvAndConfig(config));
    if (envOrConfig) {
      return {
        auth: { state: "configured", apiKey: envOrConfig.key } as InvalidAwareAuthResult,
        source: envOrConfig.source as Source | AuthSource | null,
      };
    }

    const maxAgeMs = Math.max(0, params?.maxAgeMs ?? config.auth.defaultMaxAgeMs);
    const auth = parseAuth(await config.auth.readAuth(maxAgeMs));
    return {
      auth,
      source: auth.state === "none" ? null : config.auth.authSource,
    };
  };

  return {
    parseAuth,
    resolve: async (params) => (await resolveWithSource(params)).auth,
    diagnostics: async (params) => {
      const { auth, source } = await resolveWithSource(params);
      const paths = {
        checkedPaths: getApiKeyCheckedPaths({
          envVarNames: config.envVars.map((envVar) => envVar.name),
          getConfigCandidates: config.getConfigCandidates,
        }),
        credentialDatabasePaths: config.auth.getCredentialDatabasePaths(),
      };
      if (auth.state === "none") return { state: "none", source: null, ...paths };
      if (auth.state === "invalid") {
        return {
          state: "invalid",
          source: config.auth.authSource,
          error: auth.error,
          ...paths,
        };
      }
      return {
        state: "configured",
        source: source ?? config.auth.authSource,
        ...paths,
      };
    },
  };
}

export function createProviderApiKeyResolver<Source extends string, AuthSource extends Source>(
  config: ResolveInvalidAwareProviderApiKeyConfig<Source, AuthSource>,
): InvalidAwareProviderApiKeyResolver<Source, AuthSource>;
export function createProviderApiKeyResolver<Source extends string>(
  config: ResolveProviderApiKeyConfig<Source>,
): ProviderApiKeyResolver<Source>;
export function createProviderApiKeyResolver<Source extends string, AuthSource extends Source>(
  config:
    | ResolveProviderApiKeyConfig<Source>
    | ResolveInvalidAwareProviderApiKeyConfig<Source, AuthSource>,
): ProviderApiKeyResolver<Source> | InvalidAwareProviderApiKeyResolver<Source, AuthSource> {
  if (config.auth?.policy === "invalid-aware-api-key") {
    return createInvalidAwareProviderApiKeyResolver<Source, AuthSource>(
      config as ResolveInvalidAwareProviderApiKeyConfig<Source, AuthSource>,
    );
  }

  const simpleConfig = config as ResolveProviderApiKeyConfig<Source>;
  const resolve = () => resolveProviderApiKey(simpleConfig);
  return {
    resolve,
    has: async () => (await resolve()) !== null,
    diagnostics: async () => ({
      ...(await getApiKeyDiagnostics({
        envVarNames: simpleConfig.envVars.map((envVar) => envVar.name),
        resolve,
        getConfigCandidates: simpleConfig.getConfigCandidates,
      })),
      credentialDatabasePaths: simpleConfig.auth?.getCredentialDatabasePaths?.() ?? [],
    }),
  };
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
 * 3. opencode.db
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

  // 3. Fallback to opencode.db
  const auth = await readAuth();
  const key = config.extractFromAuth(auth);
  if (key) {
    return { key, source: config.authSource };
  }

  return null;
}

export async function resolveProviderApiKey<Source extends string>(
  config: ResolveProviderApiKeyConfig<Source>,
): Promise<ApiKeyResult<Source> | null> {
  const envAndConfig = buildProviderEnvAndConfig(config);

  if (!config.auth) {
    return resolveApiKeyFromEnvAndConfig(envAndConfig);
  }

  return resolveApiKey(
    {
      ...envAndConfig,
      extractFromAuth: (auth) =>
        extractAuthApiKeyEntry(auth, config.auth?.authKeys ?? config.providerKeys),
      authSource: config.auth.authSource,
    },
    config.auth.readAuth,
  );
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
