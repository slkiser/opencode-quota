import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface OpenCodeGoConfig {
  workspaceId: string;
  authCookie: string;
}

export type ResolvedOpenCodeGoConfig =
  | { state: "none" }
  | { state: "configured"; config: OpenCodeGoConfig; source: string }
  | { state: "incomplete"; source: string; missing: string };

export interface OpenCodeGoConfigDiagnostics {
  state: ResolvedOpenCodeGoConfig["state"];
  source: string | null;
  missing: string | null;
  checkedPaths: string[];
}

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "opencode-go.json"));
}

async function readConfigFile(path: string): Promise<Partial<OpenCodeGoConfig> | null> {
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<OpenCodeGoConfig>;
  } catch {
    return null;
  }
}

export function resolveOpenCodeGoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenCodeGoConfig | null {
  const workspaceId = env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = env.OPENCODE_GO_AUTH_COOKIE?.trim();

  if (!workspaceId && !authCookie) return null;

  if (workspaceId && authCookie) {
    return {
      state: "configured",
      config: { workspaceId, authCookie },
      source: "env",
    };
  }

  return {
    state: "incomplete",
    source: "env",
    missing: workspaceId ? "OPENCODE_GO_AUTH_COOKIE" : "OPENCODE_GO_WORKSPACE_ID",
  };
}

export async function resolveOpenCodeGoConfig(): Promise<ResolvedOpenCodeGoConfig> {
  const envResult = resolveOpenCodeGoConfigFromEnv();
  if (envResult) return envResult;

  const candidates = getConfigCandidatePaths();
  for (const path of candidates) {
    const config = await readConfigFile(path);
    if (!config) continue;

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

let cachedConfig: ResolvedOpenCodeGoConfig | null = null;
let cachedAt = 0;

const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS };

export async function resolveOpenCodeGoConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedOpenCodeGoConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveOpenCodeGoConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getOpenCodeGoConfigDiagnostics(): Promise<OpenCodeGoConfigDiagnostics> {
  const resolved = await resolveOpenCodeGoConfig();
  const checkedPaths = getConfigCandidatePaths();

  if (resolved.state === "none") {
    return { state: "none", source: null, missing: null, checkedPaths };
  }

  if (resolved.state === "incomplete") {
    return {
      state: "incomplete",
      source: resolved.source,
      missing: resolved.missing,
      checkedPaths,
    };
  }

  return {
    state: "configured",
    source: resolved.source,
    missing: null,
    checkedPaths,
  };
}
