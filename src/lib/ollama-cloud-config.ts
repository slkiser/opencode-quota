import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { xdgConfig } from "xdg-basedir";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface OllamaCloudConfig {
  cookie: string;
}

export type ResolvedOllamaCloudConfig =
  | { state: "none" }
  | { state: "configured"; config: OllamaCloudConfig; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

export interface OllamaCloudConfigDiagnostics {
  state: ResolvedOllamaCloudConfig["state"];
  source: string | null;
  missing: string | null;
  error: string | null;
  checkedPaths: string[];
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; config: Partial<OllamaCloudConfig> }
  | { state: "invalid"; error: string };

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const paths = configDirs.map((dir) =>
    join(dir, "opencode-quota", "ollama-cloud.json"),
  );

  const xdgConfigDir =
    xdgConfig || join(homedir(), ".config");
  paths.push(join(xdgConfigDir, "ollama-usage", "config.yaml"));

  const home = homedir();
  paths.push(join(home, ".ollama-usage", "config.yaml"));

  return paths;
}

function getOllamaUsageConfigPath(): string {
  const xdgConfigDir = xdgConfig || join(homedir(), ".config");
  return join(xdgConfigDir, "ollama-usage", "config.yaml");
}

function getOllamaUsageLegacyPath(): string {
  return join(homedir(), ".ollama-usage", "config.yaml");
}

function getConfigFileError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return `Failed to parse config: ${error.message}`;
  }
  if (error instanceof Error && error.message) {
    return `Failed to read config file: ${error.message}`;
  }
  return `Failed to read config file: ${String(error)}`;
}

async function readJsonConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "Config file must contain a JSON object" };
    }
    return { state: "loaded", config: parsed as Partial<OllamaCloudConfig> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: getConfigFileError(error) };
  }
}

async function readYamlConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf-8");
    const cookieMatch = data.match(/(?:^|\n)\s*cookie\s*:\s*["']?\s*(.+?)\s*["']?\s*(?:\n|$)/);
    if (cookieMatch && cookieMatch[1]) {
      return { state: "loaded", config: { cookie: cookieMatch[1].trim() } };
    }
    return { state: "missing" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: getConfigFileError(error) };
  }
}

export function resolveOllamaCloudConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOllamaCloudConfig | null {
  const cookie = env.OLLAMA_USAGE_COOKIE?.trim();

  if (!cookie) return null;

  return {
    state: "configured",
    config: { cookie },
    source: "env",
  };
}

export async function resolveOllamaCloudConfig(): Promise<ResolvedOllamaCloudConfig> {
  const envResult = resolveOllamaCloudConfigFromEnv();
  if (envResult) return envResult;

  const candidates = getConfigCandidatePaths();

  for (const path of candidates) {
    const isYaml = path.endsWith(".yaml");
    const fileResult = isYaml
      ? await readYamlConfigFile(path)
      : await readJsonConfigFile(path);

    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const config = fileResult.config;
    const cookie = typeof config.cookie === "string" ? config.cookie.trim() : "";

    if (cookie) {
      return {
        state: "configured",
        config: { cookie },
        source: path,
      };
    }

    return { state: "incomplete", source: path, missing: "cookie" };
  }

  return { state: "none" };
}

let cachedConfig: ResolvedOllamaCloudConfig | null = null;
let cachedAt = 0;

const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_OLLAMA_CLOUD_CONFIG_CACHE_MAX_AGE_MS };

export async function resolveOllamaCloudConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOllamaCloudConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveOllamaCloudConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getOllamaCloudConfigDiagnostics(): Promise<OllamaCloudConfigDiagnostics> {
  const resolved = await resolveOllamaCloudConfig();
  const checkedPaths = getConfigCandidatePaths();

  if (resolved.state === "none") {
    return { state: "none", source: null, missing: null, error: null, checkedPaths };
  }

  if (resolved.state === "incomplete") {
    return {
      state: "incomplete",
      source: resolved.source,
      missing: resolved.missing,
      error: null,
      checkedPaths,
    };
  }

  if (resolved.state === "invalid") {
    return {
      state: "invalid",
      source: resolved.source,
      missing: null,
      error: resolved.error,
      checkedPaths,
    };
  }

  return {
    state: "configured",
    source: resolved.source,
    missing: null,
    error: null,
    checkedPaths,
  };
}

export { getOllamaUsageConfigPath, getOllamaUsageLegacyPath };
