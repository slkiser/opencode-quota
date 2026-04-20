import {
  extractProviderOptionsApiKey,
  getApiKeyCheckedPaths,
  getFirstAuthEntryValue,
  getGlobalOpencodeConfigCandidatePaths,
  resolveApiKeyFromEnvAndConfig,
} from "./api-key-resolver.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { getAuthPaths, readAuthFileCached } from "./opencode-auth.js";

import type { AuthData, KimiAuthData } from "./types.js";

export const DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS = 5_000;
const KIMI_AUTH_KEYS = ["kimi-for-coding", "kimi-code", "kimi"] as const;
const KIMI_PROVIDER_KEYS = ["kimi-for-coding", "kimi-code", "kimi"] as const;
const ALLOWED_KIMI_ENV_VARS = ["KIMI_API_KEY", "KIMI_CODE_API_KEY"] as const;

export type KimiKeySource =
  | "env:KIMI_API_KEY"
  | "env:KIMI_CODE_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "auth.json";

export type ResolvedKimiAuth =
  | { state: "none" }
  | { state: "configured"; apiKey: string }
  | { state: "invalid"; error: string };

export type KimiAuthDiagnostics =
  | {
      state: "none";
      source: null;
      checkedPaths: string[];
      authPaths: string[];
    }
  | {
      state: "configured";
      source: KimiKeySource;
      checkedPaths: string[];
      authPaths: string[];
    }
  | {
      state: "invalid";
      source: "auth.json";
      checkedPaths: string[];
      authPaths: string[];
      error: string;
    };

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

function getKimiAuthEntry(auth: AuthData | null | undefined): unknown {
  return getFirstAuthEntryValue(auth, KIMI_AUTH_KEYS);
}

function isKimiAuthData(value: unknown): value is KimiAuthData {
  return value !== null && typeof value === "object";
}

function sanitizeKimiAuthValue(value: string): string {
  const sanitized = sanitizeDisplayText(value).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

export function resolveKimiAuth(auth: AuthData | null | undefined): ResolvedKimiAuth {
  const kimi = getKimiAuthEntry(auth);
  if (kimi === null || kimi === undefined) {
    return { state: "none" };
  }

  if (!isKimiAuthData(kimi)) {
    return { state: "invalid", error: "Kimi auth entry has invalid shape" };
  }

  if (typeof kimi.type !== "string") {
    return { state: "invalid", error: "Kimi auth entry present but type is missing or invalid" };
  }

  if (kimi.type !== "api") {
    return {
      state: "invalid",
      error: `Unsupported Kimi auth type: "${sanitizeKimiAuthValue(kimi.type)}"`,
    };
  }

  const key = typeof kimi.key === "string" ? kimi.key.trim() : "";
  if (!key) {
    return { state: "invalid", error: "Kimi auth entry present but key is empty" };
  }

  return { state: "configured", apiKey: key };
}

async function resolveKimiAuthWithSource(params?: {
  maxAgeMs?: number;
}): Promise<{ auth: ResolvedKimiAuth; source: KimiKeySource | null }> {
  const resolvedFromEnvOrConfig = await resolveApiKeyFromEnvAndConfig<KimiKeySource>({
    envVars: [
      { name: "KIMI_API_KEY", source: "env:KIMI_API_KEY" },
      { name: "KIMI_CODE_API_KEY", source: "env:KIMI_CODE_API_KEY" },
    ],
    extractFromConfig: (config) =>
      extractProviderOptionsApiKey(config, {
        providerKeys: KIMI_PROVIDER_KEYS,
        allowedEnvVars: ALLOWED_KIMI_ENV_VARS,
      }),
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });

  if (resolvedFromEnvOrConfig) {
    return {
      auth: { state: "configured", apiKey: resolvedFromEnvOrConfig.key },
      source: resolvedFromEnvOrConfig.source,
    };
  }

  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS);
  const authData = await readAuthFileCached({ maxAgeMs });
  const auth = resolveKimiAuth(authData);

  return {
    auth,
    source: auth.state === "none" ? null : "auth.json",
  };
}

export async function resolveKimiAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedKimiAuth> {
  return (await resolveKimiAuthWithSource(params)).auth;
}

export async function getKimiAuthDiagnostics(params?: {
  maxAgeMs?: number;
}): Promise<KimiAuthDiagnostics> {
  const { auth, source } = await resolveKimiAuthWithSource(params);
  const checkedPaths = getApiKeyCheckedPaths({
    envVarNames: [...ALLOWED_KIMI_ENV_VARS],
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
  const authPaths = getAuthPaths();

  if (auth.state === "none") {
    return {
      state: "none",
      source: null,
      checkedPaths,
      authPaths,
    };
  }

  if (auth.state === "invalid") {
    return {
      state: "invalid",
      source: "auth.json",
      checkedPaths,
      authPaths,
      error: auth.error,
    };
  }

  return {
    state: "configured",
    source: source ?? "auth.json",
    checkedPaths,
    authPaths,
  };
}
