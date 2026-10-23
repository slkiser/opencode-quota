import { readFile } from "fs/promises";
import { join } from "path";

import { isRecord } from "./json-guards.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

type ResolvedMimoConfig =
  | { state: "none" }
  | { state: "configured"; config: { cookie: string }; source: string }
  | { state: "invalid"; source: string; error: string };

interface MimoConfigDiagnostics {
  state: ResolvedMimoConfig["state"];
  source: string | null;
  error: string | null;
  checkedPaths: string[];
}

const MIMO_COOKIE_ENV = "MIMO_USAGE_COOKIE";
const RETAINED_COOKIE_NAMES = [
  "api-platform_serviceToken",
  "userId",
  "api-platform_ph",
  "api-platform_slh",
] as const;
const RETAINED_COOKIE_NAME_SET = new Set<string>(RETAINED_COOKIE_NAMES);
const REQUIRED_COOKIE_NAMES = ["api-platform_serviceToken", "userId"] as const;

function getConfigPath(): string {
  return join(getOpencodeRuntimeDirs().configDir, "opencode-quota", "mimo.json");
}

function normalizeMimoCookieHeader(raw: string): string | null {
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

function resolveCookie(raw: string, source: string): ResolvedMimoConfig {
  const cookie = normalizeMimoCookieHeader(raw);
  if (!cookie) return { state: "invalid", source, error: "Invalid cookie header" };
  return { state: "configured", config: { cookie }, source };
}

async function resolveMimoConfigFile(path: string): Promise<ResolvedMimoConfig> {
  const invalid = (error: string): ResolvedMimoConfig => ({
    state: "invalid",
    source: path,
    error,
  });

  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { state: "none" };
    return invalid("Failed to read config file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return invalid("Failed to parse JSON");
  }

  if (!isRecord(parsed)) return invalid("Config file must contain a JSON object");
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== "cookie") {
    return invalid("Config file must contain only the cookie field");
  }
  if (typeof parsed.cookie !== "string") return invalid("Config cookie field must be a string");

  return resolveCookie(parsed.cookie, path);
}

/** A set environment variable wins over the config file, even when it is invalid. */
async function resolveMimoConfig(): Promise<ResolvedMimoConfig> {
  const envCookie = process.env[MIMO_COOKIE_ENV];
  if (envCookie !== undefined) return resolveCookie(envCookie, `env:${MIMO_COOKIE_ENV}`);
  return resolveMimoConfigFile(getConfigPath());
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
    checkedPaths: [getConfigPath()],
  };
}
