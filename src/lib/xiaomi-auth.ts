/**
 * Xiaomi Token Plan auth resolution.
 *
 * Resolves the Xiaomi platform session cookie from:
 * 1. Environment variable XIAOMI_COOKIE
 * 2. Trusted user/global OpenCode config (opencode.json/opencode.jsonc)
 * 3. Config file (~/.config/opencode/opencode-quota/xiaomi.json)
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import {
  getGlobalOpencodeConfigCandidatePaths,
  getOpencodeConfigCandidatePaths,
  readOpencodeConfig,
  type ConfigCandidate,
} from "./api-key-resolver.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface XiaomiCookieResult {
  cookie: string;
  source: XiaomiCookieSource;
}

export type XiaomiCookieSource =
  | "env:XIAOMI_COOKIE"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json"
  | "xiaomi.json";

const XIAOMI_CONFIG_FILENAME = "xiaomi.json";

function getConfigCandidatePaths(): ConfigCandidate[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => ({
    path: join(dir, "opencode-quota", XIAOMI_CONFIG_FILENAME),
    isJsonc: false,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractCookieFromConfig(config: unknown): string | null {
  if (!isRecord(config)) return null;

  // Check provider.xiaomi.options.cookie
  const provider = isRecord(config.provider) ? config.provider : undefined;
  const xiaomi = provider ? (isRecord(provider.xiaomi) ? provider.xiaomi : undefined) : undefined;
  const options = xiaomi ? (isRecord(xiaomi.options) ? xiaomi.options : undefined) : undefined;
  const cookieFromOptions = options?.cookie;
  if (typeof cookieFromOptions === "string" && cookieFromOptions.trim().length > 0) {
    return cookieFromOptions.trim();
  }

  // Check provider.xiaomi.options.sessionCookie
  const sessionCookie = options?.sessionCookie;
  if (typeof sessionCookie === "string" && sessionCookie.trim().length > 0) {
    return sessionCookie.trim();
  }

  return null;
}

function extractCookieFromXiaomiConfig(config: unknown): string | null {
  if (!isRecord(config)) return null;

  const cookie = config.cookie;
  if (typeof cookie === "string" && cookie.trim().length > 0) {
    return cookie.trim();
  }

  const sessionCookie = config.sessionCookie;
  if (typeof sessionCookie === "string" && sessionCookie.trim().length > 0) {
    return sessionCookie.trim();
  }

  return null;
}

function extractCookieFromAuth(auth: unknown): string | null {
  if (!isRecord(auth)) return null;

  // Check for xiaomi entry
  const xiaomi = auth.xiaomi;
  if (isRecord(xiaomi)) {
    const cookie = xiaomi.cookie ?? xiaomi.sessionCookie;
    if (typeof cookie === "string" && cookie.trim().length > 0) {
      return cookie.trim();
    }
  }

  // Check for mimo entry
  const mimo = auth.mimo;
  if (isRecord(mimo)) {
    const cookie = mimo.cookie ?? mimo.sessionCookie;
    if (typeof cookie === "string" && cookie.trim().length > 0) {
      return cookie.trim();
    }
  }

  return null;
}

export async function resolveXiaomiCookie(): Promise<XiaomiCookieResult | null> {
  // 1. Check environment variable
  const envCookie = process.env.XIAOMI_COOKIE?.trim();
  if (envCookie && envCookie.length > 0) {
    return { cookie: envCookie, source: "env:XIAOMI_COOKIE" };
  }

  // 2. Check opencode.json/opencode.jsonc
  const configCandidates = getOpencodeConfigCandidatePaths();
  for (const candidate of configCandidates) {
    const result = await readOpencodeConfig(candidate.path, candidate.isJsonc);
    if (!result) continue;

    const cookie = extractCookieFromConfig(result.config);
    if (cookie) {
      return {
        cookie,
        source: result.isJsonc ? "opencode.jsonc" : "opencode.json",
      };
    }
  }

  // 3. Check xiaomi.json config files
  const xiaomiConfigCandidates = getConfigCandidatePaths();
  for (const candidate of xiaomiConfigCandidates) {
    try {
      const content = await readFile(candidate.path, "utf-8");
      const config = JSON.parse(content);
      const cookie = extractCookieFromXiaomiConfig(config);
      if (cookie) {
        return { cookie, source: "xiaomi.json" };
      }
    } catch {
      // File doesn't exist or is invalid, continue
    }
  }

  // 4. Check auth.json
  const auth = await readAuthFile();
  const cookie = extractCookieFromAuth(auth);
  if (cookie) {
    return { cookie, source: "auth.json" };
  }

  return null;
}

export async function hasXiaomiCookie(): Promise<boolean> {
  return (await resolveXiaomiCookie()) !== null;
}

export async function getXiaomiCookieDiagnostics(): Promise<{
  configured: boolean;
  source: XiaomiCookieSource | null;
  checkedPaths: string[];
}> {
  const checkedPaths: string[] = [];

  if (process.env.XIAOMI_COOKIE !== undefined) {
    checkedPaths.push("env:XIAOMI_COOKIE");
  }

  const configCandidates = getOpencodeConfigCandidatePaths();
  for (const candidate of configCandidates) {
    checkedPaths.push(candidate.path);
  }

  const xiaomiConfigCandidates = getConfigCandidatePaths();
  for (const candidate of xiaomiConfigCandidates) {
    checkedPaths.push(candidate.path);
  }

  checkedPaths.push("auth.json");

  const result = await resolveXiaomiCookie();

  return {
    configured: result !== null,
    source: result?.source ?? null,
    checkedPaths,
  };
}
