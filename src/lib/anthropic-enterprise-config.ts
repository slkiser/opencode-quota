/**
 * Anthropic Enterprise configuration resolver.
 *
 * Supports Enterprise usage-based plans with monthly dollar spend limits.
 * Config is resolved from environment variables first, then from a JSON
 * config file at `opencode-quota/anthropic-enterprise.json`.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface AnthropicEnterpriseConfig {
  orgId: string;
  sessionKey: string;
  accountId?: string;
}

export type ResolvedAnthropicEnterpriseConfig =
  | { state: "none" }
  | { state: "configured"; config: AnthropicEnterpriseConfig; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

export interface AnthropicEnterpriseConfigDiagnostics {
  state: ResolvedAnthropicEnterpriseConfig["state"];
  source: string | null;
  missing: string | null;
  error: string | null;
  checkedPaths: string[];
}

export const DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS = 30_000;

type CacheEntry = {
  timestamp: number;
  value: ResolvedAnthropicEnterpriseConfig;
};

let configCache: CacheEntry | null = null;

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "anthropic-enterprise.json"));
}

export async function resolveAnthropicEnterpriseConfig(): Promise<ResolvedAnthropicEnterpriseConfig> {
  // Environment variables take precedence
  const envOrgId = process.env["ANTHROPIC_ENTERPRISE_ORG_ID"]?.trim();
  const envSessionKey = process.env["ANTHROPIC_ENTERPRISE_SESSION_KEY"]?.trim();
  const envAccountId = process.env["ANTHROPIC_ENTERPRISE_ACCOUNT_ID"]?.trim();

  if (envOrgId || envSessionKey) {
    if (!envOrgId) {
      return { state: "incomplete", source: "environment", missing: "ANTHROPIC_ENTERPRISE_ORG_ID" };
    }
    if (!envSessionKey) {
      return {
        state: "incomplete",
        source: "environment",
        missing: "ANTHROPIC_ENTERPRISE_SESSION_KEY",
      };
    }
    return {
      state: "configured",
      config: {
        orgId: envOrgId,
        sessionKey: envSessionKey,
        accountId: envAccountId || undefined,
      },
      source: "environment",
    };
  }

  // Try config file candidates
  const paths = getConfigCandidatePaths();
  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { state: "invalid", source: path, error: "Config file must contain a JSON object" };
      }

      const orgId = typeof parsed["orgId"] === "string" ? parsed["orgId"].trim() : "";
      const sessionKey =
        typeof parsed["sessionKey"] === "string" ? parsed["sessionKey"].trim() : "";
      const accountId =
        typeof parsed["accountId"] === "string" ? parsed["accountId"].trim() : "";

      if (!orgId && !sessionKey) {
        continue;
      }

      if (!orgId) {
        return { state: "incomplete", source: path, missing: "orgId" };
      }
      if (!sessionKey) {
        return { state: "incomplete", source: path, missing: "sessionKey" };
      }

      return {
        state: "configured",
        config: { orgId, sessionKey, accountId: accountId || undefined },
        source: path,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        continue;
      }
      const message =
        error instanceof SyntaxError
          ? `Failed to parse JSON: ${error.message}`
          : `Failed to read: ${(error as Error).message}`;
      return { state: "invalid", source: path, error: message };
    }
  }

  return { state: "none" };
}

export async function resolveAnthropicEnterpriseConfigCached(options?: {
  maxAgeMs?: number;
}): Promise<ResolvedAnthropicEnterpriseConfig> {
  const maxAge = options?.maxAgeMs ?? DEFAULT_ANTHROPIC_ENTERPRISE_CONFIG_CACHE_MAX_AGE_MS;
  const now = Date.now();

  if (configCache && now - configCache.timestamp < maxAge) {
    return configCache.value;
  }

  const value = await resolveAnthropicEnterpriseConfig();
  configCache = { timestamp: now, value };
  return value;
}

export function getAnthropicEnterpriseConfigDiagnostics(
  resolved: ResolvedAnthropicEnterpriseConfig,
): AnthropicEnterpriseConfigDiagnostics {
  const paths = getConfigCandidatePaths();

  return {
    state: resolved.state,
    source:
      resolved.state === "configured"
        ? resolved.source
        : resolved.state === "incomplete"
          ? resolved.source
          : resolved.state === "invalid"
            ? resolved.source
            : null,
    missing: resolved.state === "incomplete" ? resolved.missing : null,
    error: resolved.state === "invalid" ? resolved.error : null,
    checkedPaths: paths,
  };
}
