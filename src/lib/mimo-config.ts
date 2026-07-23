import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface MimoConfig {
  cookie: string;
}

export type ResolvedMimoConfig =
  | { state: "none" }
  | { state: "configured"; config: MimoConfig; source: string }
  | { state: "invalid"; source: string; error: string };

export interface MimoConfigDiagnostics {
  state: ResolvedMimoConfig["state"];
  source: string | null;
  error: string | null;
  checkedPaths: string[];
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; cookie: unknown; keys: string[] }
  | { state: "invalid"; error: string };

const MIMO_COOKIE_ENV = "MIMO_USAGE_COOKIE";
const RETAINED_COOKIE_NAMES = [
  "api-platform_serviceToken",
  "userId",
  "api-platform_ph",
  "api-platform_slh",
] as const;
const RETAINED_COOKIE_NAME_SET = new Set<string>(RETAINED_COOKIE_NAMES);
const REQUIRED_COOKIE_NAMES = ["api-platform_serviceToken", "userId"] as const;

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "mimo.json"));
}

export function normalizeMimoCookieHeader(raw: string): string | null {
  if (raw.includes("\r") || raw.includes("\n")) return null;

  const withoutPrefix = raw.trim().replace(/^cookie\s*:\s*/iu, "");
  if (!withoutPrefix) return null;

  const retained = new Map<string, string>();
  for (const rawPair of withoutPrefix.split(";")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const separator = pair.indexOf("=");
    if (separator <= 0) return null;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) return null;
    if (!RETAINED_COOKIE_NAME_SET.has(name)) continue;
    if (!value || retained.has(name)) return null;

    retained.set(name, value);
  }

  if (REQUIRED_COOKIE_NAMES.some((name) => !retained.has(name))) return null;

  return RETAINED_COOKIE_NAMES.flatMap((name) => {
    const value = retained.get(name);
    return value === undefined ? [] : [`${name}=${value}`];
  }).join("; ");
}

async function readConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return { state: "invalid", error: "Failed to parse JSON" };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "Config file must contain a JSON object" };
    }

    const record = parsed as Record<string, unknown>;
    return { state: "loaded", cookie: record.cookie, keys: Object.keys(record) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: "Failed to read config file" };
  }
}

export function resolveMimoConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMimoConfig | null {
  if (env[MIMO_COOKIE_ENV] === undefined) return null;

  const cookie = normalizeMimoCookieHeader(env[MIMO_COOKIE_ENV] ?? "");
  if (!cookie) {
    return {
      state: "invalid",
      source: `env:${MIMO_COOKIE_ENV}`,
      error: "Invalid cookie header",
    };
  }

  return {
    state: "configured",
    config: { cookie },
    source: `env:${MIMO_COOKIE_ENV}`,
  };
}

export async function resolveMimoConfig(): Promise<ResolvedMimoConfig> {
  const envResult = resolveMimoConfigFromEnv();
  if (envResult) return envResult;

  for (const path of getConfigCandidatePaths()) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    if (fileResult.keys.length !== 1 || fileResult.keys[0] !== "cookie") {
      return {
        state: "invalid",
        source: path,
        error: "Config file must contain only the cookie field",
      };
    }
    if (typeof fileResult.cookie !== "string") {
      return {
        state: "invalid",
        source: path,
        error: "Config cookie field must be a string",
      };
    }

    const cookie = normalizeMimoCookieHeader(fileResult.cookie);
    if (!cookie) {
      return { state: "invalid", source: path, error: "Invalid cookie header" };
    }

    return {
      state: "configured",
      config: { cookie },
      source: path,
    };
  }

  return { state: "none" };
}

let cachedConfig: ResolvedMimoConfig | null = null;
let cachedAt = 0;

export const DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS = 30_000;

export async function resolveMimoConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedMimoConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_MIMO_CONFIG_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }

  cachedConfig = await resolveMimoConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getMimoConfigDiagnostics(): Promise<MimoConfigDiagnostics> {
  const resolved = await resolveMimoConfig();
  return {
    state: resolved.state,
    source: "source" in resolved ? resolved.source : null,
    error: "error" in resolved ? resolved.error : null,
    checkedPaths: getConfigCandidatePaths(),
  };
}
