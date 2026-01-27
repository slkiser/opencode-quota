/**
 * Chutes API key configuration resolver
 *
 * Resolution priority (first wins):
 * 1. Environment variable: CHUTES_API_KEY
 * 2. opencode.json/opencode.jsonc: provider.chutes.options.apiKey
 *    - Supports {env:VAR_NAME} syntax for environment variable references
 * 3. auth.json: chutes.key (legacy/fallback)
 */

import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readAuthFile } from "./opencode-auth.js";

/** Result of Chutes API key resolution */
export interface ChutesApiKeyResult {
  key: string;
  source: ChutesKeySource;
}

/** Source of the resolved API key */
export type ChutesKeySource =
  | "env:CHUTES_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

/**
 * Strip JSONC comments (// and /* ... *​/) from a string.
 */
function stripJsonComments(content: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";

  while (i < content.length) {
    const char = content[i];
    const nextChar = content[i + 1];

    if ((char === '"' || char === "'") && (i === 0 || content[i - 1] !== "\\")) {
      if (!inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar) {
        inString = false;
      }
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      if (char === "/" && nextChar === "/") {
        while (i < content.length && content[i] !== "\n") {
          i++;
        }
        continue;
      }

      if (char === "/" && nextChar === "*") {
        i += 2;
        while (i < content.length - 1 && !(content[i] === "*" && content[i + 1] === "/")) {
          i++;
        }
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Parse JSON or JSONC content
 */
function parseJsonOrJsonc(content: string, isJsonc: boolean): unknown {
  const toParse = isJsonc ? stripJsonComments(content) : content;
  return JSON.parse(toParse);
}

/**
 * Resolve {env:VAR_NAME} syntax in a string value
 */
function resolveEnvTemplate(value: string): string | null {
  const match = value.match(/^\{env:([^}]+)\}$/);
  if (!match) return value;

  const envVar = match[1];
  const envValue = process.env[envVar];
  return envValue && envValue.trim().length > 0 ? envValue.trim() : null;
}

/**
 * Extract Chutes API key from opencode config object
 */
function extractChutesKeyFromConfig(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const provider = root.provider;
  if (!provider || typeof provider !== "object") return null;

  const chutes = (provider as Record<string, unknown>).chutes;
  if (!chutes || typeof chutes !== "object") return null;

  const options = (chutes as Record<string, unknown>).options;
  if (!options || typeof options !== "object") return null;

  const apiKey = (options as Record<string, unknown>).apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) return null;

  return resolveEnvTemplate(apiKey.trim());
}

/**
 * Get candidate paths for opencode.json/opencode.jsonc files
 */
export function getOpencodeConfigCandidatePaths(): Array<{ path: string; isJsonc: boolean }> {
  const cwd = process.cwd();
  const configBaseDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  return [
    { path: join(configBaseDir, "opencode", "opencode.jsonc"), isJsonc: true },
    { path: join(configBaseDir, "opencode", "opencode.json"), isJsonc: false },
    { path: join(cwd, "opencode.jsonc"), isJsonc: true },
    { path: join(cwd, "opencode.json"), isJsonc: false },
  ];
}

/**
 * Read and parse opencode config file
 */
async function readOpencodeConfig(
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

/**
 * Resolve Chutes API key from all available sources.
 */
export async function resolveChutesApiKey(): Promise<ChutesApiKeyResult | null> {
  const envKey = process.env.CHUTES_API_KEY?.trim();
  if (envKey && envKey.length > 0) {
    return { key: envKey, source: "env:CHUTES_API_KEY" };
  }

  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    const result = await readOpencodeConfig(candidate.path, candidate.isJsonc);
    if (!result) continue;

    const key = extractChutesKeyFromConfig(result.config);
    if (key) {
      return {
        key,
        source: result.isJsonc ? "opencode.jsonc" : "opencode.json",
      };
    }
  }

  const auth = await readAuthFile();
  const chutes = auth?.chutes;
  if (chutes && chutes.type === "api" && chutes.key && chutes.key.trim().length > 0) {
    return { key: chutes.key.trim(), source: "auth.json" };
  }

  return null;
}

/**
 * Check if a Chutes API key is configured
 */
export async function hasChutesApiKey(): Promise<boolean> {
  const result = await resolveChutesApiKey();
  return result !== null;
}

/**
 * Get diagnostic info about Chutes API key configuration
 */
export async function getChutesKeyDiagnostics(): Promise<{
  configured: boolean;
  source: ChutesKeySource | null;
  checkedPaths: string[];
}> {
  const checkedPaths: string[] = [];

  if (process.env.CHUTES_API_KEY !== undefined) {
    checkedPaths.push("env:CHUTES_API_KEY");
  }

  const candidates = getOpencodeConfigCandidatePaths();
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      checkedPaths.push(candidate.path);
    }
  }

  const result = await resolveChutesApiKey();

  return {
    configured: result !== null,
    source: result?.source ?? null,
    checkedPaths,
  };
}
