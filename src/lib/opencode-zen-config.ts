/**
 * OpenCode Zen config resolver.
 *
 * Resolves Zen billing access from (in priority order):
 * 1. Env vars: OPENCODE_WORKSPACE_ID + OPENCODE_AUTH_COOKIE (preferred)
 * 2. Env vars: OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE (compat)
 * 3. Config file: {configDir}/opencode-quota/opencode.json
 */

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

function getConfigFileError(error: unknown): string {
  const prefix = error instanceof SyntaxError ? "Failed to parse JSON" : "Failed to read config file";
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}

async function readConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf-8");
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

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "opencode.json"));
}

/**
 * Try to resolve config from env vars.
 * Checks preferred OPENCODE_* vars first, then falls back to OPENCODE_GO_* compat vars.
 * Returns null when neither set of env vars is present.
 */
export function resolveOpenCodeZenConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeZenConfig | null {
  // Preferred: OPENCODE_WORKSPACE_ID + OPENCODE_AUTH_COOKIE
  const preferredWs = env.OPENCODE_WORKSPACE_ID?.trim();
  const preferredCookie = env.OPENCODE_AUTH_COOKIE?.trim();

  if (preferredWs && preferredCookie) {
    return {
      state: "configured",
      config: { workspaceId: preferredWs, authCookie: preferredCookie },
      source: "env(OPENCODE_*)",
    };
  }

  if (preferredWs || preferredCookie) {
    return {
      state: "incomplete",
      source: "env(OPENCODE_*)",
      missing: preferredWs ? "OPENCODE_AUTH_COOKIE" : "OPENCODE_WORKSPACE_ID",
    };
  }

  // Compat: OPENCODE_GO_WORKSPACE_ID + OPENCODE_GO_AUTH_COOKIE
  const compatWs = env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const compatCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();

  if (compatWs && compatCookie) {
    return {
      state: "configured",
      config: { workspaceId: compatWs, authCookie: compatCookie },
      source: "env(OPENCODE_GO_*)",
    };
  }

  if (compatWs || compatCookie) {
    return {
      state: "incomplete",
      source: "env(OPENCODE_GO_*)",
      missing: compatWs ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID",
    };
  }

  return null;
}

export async function resolveOpenCodeZenConfig(): Promise<ResolvedOpenCodeZenConfig> {
  const envResult = resolveOpenCodeZenConfigFromEnv();
  if (envResult) return envResult;

  const candidates = getConfigCandidatePaths();
  for (const path of candidates) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const config = fileResult.config;

    const workspaceId = typeof config.workspaceId === "string" ? config.workspaceId.trim() : "";
    const authCookie = typeof config.authCookie === "string" ? config.authCookie.trim() : "";

    if (workspaceId && authCookie) {
      return {
        state: "configured",
        config: { workspaceId, authCookie },
        source: path,
      };
    }

    const missing = !workspaceId ? "workspaceId" : "authCookie";
    return { state: "incomplete", source: path, missing };
  }

  return { state: "none" };
}

// ---- Cache ----

let cachedConfig: ResolvedOpenCodeZenConfig | null = null;
let cachedAt = 0;

const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS };

export async function resolveOpenCodeZenConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeZenConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveOpenCodeZenConfig();
  cachedAt = now;
  return cachedConfig;
}

// ---- Diagnostics ----

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
