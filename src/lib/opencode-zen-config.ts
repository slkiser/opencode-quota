import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface OpenCodeZenConfig {
  workspaceId: string;
  authCookie: string;
}

export type ResolvedOpenCodeZenConfig =
  | { state: "none" }
  | { state: "configured"; config: OpenCodeZenConfig; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

export interface OpenCodeZenConfigDiagnostics {
  state: ResolvedOpenCodeZenConfig["state"];
  source: string | null;
  missing: string | null;
  error: string | null;
  checkedPaths: string[];
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; config: Partial<OpenCodeZenConfig> }
  | { state: "invalid"; error: string };

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "opencode.json"));
}

function getConfigFileError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return `Failed to parse JSON: ${error.message}`;
  }
  if (error instanceof Error && error.message) {
    return `Failed to read config file: ${error.message}`;
  }
  return `Failed to read config file: ${String(error)}`;
}

async function readConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "Config file must contain a JSON object" };
    }
    return { state: "loaded", config: parsed as Partial<OpenCodeZenConfig> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: getConfigFileError(error) };
  }
}

export function resolveOpenCodeZenConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeZenConfig | null {
  const workspaceId = env.OPENCODE_WORKSPACE_ID?.trim();
  const authCookie = env.OPENCODE_AUTH_COOKIE?.trim();

  if (workspaceId && authCookie) {
    return {
      state: "configured",
      config: { workspaceId, authCookie },
      source: "env(OPENCODE_*)",
    };
  }

  if (workspaceId || authCookie) {
    return {
      state: "incomplete",
      source: "env(OPENCODE_*)",
      missing: workspaceId ? "OPENCODE_AUTH_COOKIE" : "OPENCODE_WORKSPACE_ID",
    };
  }

  return null;
}

export async function resolveOpenCodeZenConfig(): Promise<ResolvedOpenCodeZenConfig> {
  const envResult = resolveOpenCodeZenConfigFromEnv();
  if (envResult) return envResult;

  for (const path of getConfigCandidatePaths()) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const workspaceId =
      typeof fileResult.config.workspaceId === "string" ? fileResult.config.workspaceId.trim() : "";
    const authCookie =
      typeof fileResult.config.authCookie === "string" ? fileResult.config.authCookie.trim() : "";

    if (workspaceId && authCookie) {
      return {
        state: "configured",
        config: { workspaceId, authCookie },
        source: path,
      };
    }

    return {
      state: "incomplete",
      source: path,
      missing: workspaceId ? "authCookie" : "workspaceId",
    };
  }

  return { state: "none" };
}

let cachedConfig: ResolvedOpenCodeZenConfig | null = null;
let cachedAt = 0;

export const DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS = 30_000;

export async function resolveOpenCodeZenConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeZenConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }

  cachedConfig = await resolveOpenCodeZenConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getOpenCodeZenConfigDiagnostics(): Promise<OpenCodeZenConfigDiagnostics> {
  const resolved = await resolveOpenCodeZenConfig();
  return {
    state: resolved.state,
    source: "source" in resolved ? resolved.source : null,
    missing: "missing" in resolved ? resolved.missing : null,
    error: "error" in resolved ? resolved.error : null,
    checkedPaths: getConfigCandidatePaths(),
  };
}
