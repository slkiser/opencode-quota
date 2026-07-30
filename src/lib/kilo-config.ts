import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface KiloConfig {
  cookie: string;
}

export type ResolvedKiloConfig =
  | { state: "none" }
  | { state: "configured"; config: KiloConfig; source: string }
  | { state: "invalid"; source: string; error: string };

export interface KiloConfigDiagnostics {
  state: ResolvedKiloConfig["state"];
  source: string | null;
  error: string | null;
  checkedPaths: string[];
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; cookie: unknown; keys: string[] }
  | { state: "invalid"; error: string };

const KILO_COOKIE_ENV = "KILO_USAGE_COOKIE";
const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
] as const;

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "kilo.json"));
}

function parseCookiePairs(raw: string): Map<string, string> | null {
  if (raw.includes("\r") || raw.includes("\n")) return null;

  const withoutPrefix = raw.trim().replace(/^cookie\s*:\s*/iu, "");
  if (!withoutPrefix) return null;

  const pairs = new Map<string, string>();
  for (const rawPair of withoutPrefix.split(";")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const separator = pair.indexOf("=");
    if (separator <= 0) return null;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value || pairs.has(name)) return null;
    pairs.set(name, value);
  }

  return pairs;
}

export function normalizeKiloCookieHeader(raw: string): string | null {
  const pairs = parseCookiePairs(raw);
  if (!pairs) return null;

  for (const name of SESSION_COOKIE_NAMES) {
    const value = pairs.get(name);
    if (value) return `${name}=${value}`;
  }

  if (pairs.size === 1) {
    const [[name, value]] = [...pairs.entries()];
    if (name === "session-token" || name === "session") {
      return `__Secure-next-auth.session-token=${value}`;
    }
  }

  return null;
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

export function resolveKiloConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKiloConfig | null {
  if (env[KILO_COOKIE_ENV] === undefined) return null;

  const cookie = normalizeKiloCookieHeader(env[KILO_COOKIE_ENV] ?? "");
  if (!cookie) {
    return {
      state: "invalid",
      source: `env:${KILO_COOKIE_ENV}`,
      error: "Invalid cookie header",
    };
  }

  return {
    state: "configured",
    config: { cookie },
    source: `env:${KILO_COOKIE_ENV}`,
  };
}

export async function resolveKiloConfig(): Promise<ResolvedKiloConfig> {
  const envResult = resolveKiloConfigFromEnv();
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

    const cookie = normalizeKiloCookieHeader(fileResult.cookie);
    if (!cookie) {
      return { state: "invalid", source: path, error: "Invalid cookie header" };
    }

    return { state: "configured", config: { cookie }, source: path };
  }

  return { state: "none" };
}

let cachedConfig: ResolvedKiloConfig | null = null;
let cachedAt = 0;

export const DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS = 30_000;

export async function resolveKiloConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKiloConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_KILO_CONFIG_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) return cachedConfig;

  cachedConfig = await resolveKiloConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getKiloConfigDiagnostics(): Promise<KiloConfigDiagnostics> {
  const resolved = await resolveKiloConfig();
  return {
    state: resolved.state,
    source: "source" in resolved ? resolved.source : null,
    error: "error" in resolved ? resolved.error : null,
    checkedPaths: getConfigCandidatePaths(),
  };
}
