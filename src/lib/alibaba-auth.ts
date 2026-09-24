import {
  extractProviderOptionsApiKey,
  getApiKeyCheckedPaths,
  getGlobalOpencodeConfigCandidatePaths,
  resolveApiKeyFromEnvAndConfig,
} from "./api-key-resolver.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { getCredentialDatabasePaths, readAuthFileCached } from "./opencode-auth.js";
import type { AlibabaAuthData, AlibabaCodingPlanTier, AuthData } from "./types.js";

export const DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS = 5_000;
const ALIBABA_AUTH_KEYS = ["alibaba-coding-plan", "alibaba"] as const;
const ALIBABA_PROVIDER_KEYS = ["alibaba-coding-plan", "alibaba"] as const;
const ALLOWED_ALIBABA_ENV_VARS = ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_API_KEY"] as const;
const DEFAULT_ALIBABA_CODING_PLAN_TIER: AlibabaCodingPlanTier = "lite";

export type AlibabaCodingPlanKeySource =
  | "env:ALIBABA_CODING_PLAN_API_KEY"
  | "env:ALIBABA_API_KEY"
  | "opencode.json"
  | "opencode.jsonc"
  | "opencode.db";

export type ResolvedAlibabaCodingPlanAuth =
  | { state: "none" }
  | { state: "configured"; apiKey: string; tier: AlibabaCodingPlanTier }
  | { state: "invalid"; error: string; rawTier?: string };

export type AlibabaCodingPlanAuthDiagnostics =
  | {
      state: "none";
      source: null;
      checkedPaths: string[];
      credentialDatabasePaths: string[];
    }
  | {
      state: "configured";
      source: AlibabaCodingPlanKeySource;
      checkedPaths: string[];
      credentialDatabasePaths: string[];
      tier: AlibabaCodingPlanTier;
    }
  | {
      state: "invalid";
      source: "opencode.db";
      checkedPaths: string[];
      credentialDatabasePaths: string[];
      error: string;
      rawTier?: string;
    };

export { getGlobalOpencodeConfigCandidatePaths as getOpencodeConfigCandidatePaths } from "./api-key-resolver.js";

function getFirstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeAlibabaTier(value: string | undefined): AlibabaCodingPlanTier | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "lite") return "lite";
  if (normalized === "pro" || normalized === "professional") return "pro";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getAlibabaAuthEntry(auth: AuthData | null | undefined): unknown {
  const root = asRecord(auth);
  if (!root) return undefined;

  for (const key of ALIBABA_AUTH_KEYS) {
    if (Object.hasOwn(root, key)) {
      return root[key];
    }
  }

  return undefined;
}

function isAlibabaAuthData(value: unknown): value is AlibabaAuthData {
  return value !== null && typeof value === "object";
}

function sanitizeAlibabaAuthValue(value: string): string {
  const sanitized = sanitizeDisplayText(value).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, 120);
}

export function resolveAlibabaCodingPlanAuth(
  auth: AuthData | null | undefined,
  fallbackTier: AlibabaCodingPlanTier = DEFAULT_ALIBABA_CODING_PLAN_TIER,
): ResolvedAlibabaCodingPlanAuth {
  const alibaba = getAlibabaAuthEntry(auth);
  if (alibaba === undefined) {
    return { state: "none" };
  }

  if (!isAlibabaAuthData(alibaba)) {
    return { state: "invalid", error: "Alibaba Coding Plan auth entry has invalid shape" };
  }

  if (typeof alibaba.type !== "string") {
    return {
      state: "invalid",
      error: "Alibaba Coding Plan auth entry present but type is missing or invalid",
    };
  }

  if (alibaba.type !== "api") {
    return {
      state: "invalid",
      error: `Unsupported Alibaba Coding Plan auth type: "${sanitizeAlibabaAuthValue(alibaba.type)}"`,
    };
  }

  const apiKey = typeof alibaba.key === "string" ? alibaba.key.trim() : "";
  if (!apiKey) {
    return { state: "invalid", error: "Alibaba Coding Plan auth entry present but key is empty" };
  }

  const rawTier = getFirstString(alibaba as Record<string, unknown>, [
    "tier",
    "planTier",
    "plan_tier",
    "subscriptionTier",
  ]);
  const tier = normalizeAlibabaTier(rawTier);
  if (!rawTier) {
    return {
      state: "configured",
      apiKey,
      tier: fallbackTier,
    };
  }

  if (!tier) {
    return {
      state: "invalid",
      error: `Unsupported Alibaba Coding Plan tier: ${sanitizeAlibabaAuthValue(rawTier)}`,
      rawTier,
    };
  }

  return {
    state: "configured",
    apiKey,
    tier,
  };
}

async function resolveAlibabaCodingPlanAuthWithSource(params?: {
  maxAgeMs?: number;
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<{
  auth: ResolvedAlibabaCodingPlanAuth;
  source: AlibabaCodingPlanKeySource | null;
}> {
  const fallbackTier = params?.fallbackTier ?? DEFAULT_ALIBABA_CODING_PLAN_TIER;
  const resolvedFromEnvOrConfig = await resolveApiKeyFromEnvAndConfig<AlibabaCodingPlanKeySource>({
    envVars: [
      {
        name: "ALIBABA_CODING_PLAN_API_KEY",
        source: "env:ALIBABA_CODING_PLAN_API_KEY",
      },
      { name: "ALIBABA_API_KEY", source: "env:ALIBABA_API_KEY" },
    ],
    extractFromConfig: (config) =>
      extractProviderOptionsApiKey(config, {
        providerKeys: ALIBABA_PROVIDER_KEYS,
        allowedEnvVars: ALLOWED_ALIBABA_ENV_VARS,
      }),
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });

  if (resolvedFromEnvOrConfig) {
    return {
      auth: {
        state: "configured",
        apiKey: resolvedFromEnvOrConfig.key,
        tier: fallbackTier,
      },
      source: resolvedFromEnvOrConfig.source,
    };
  }

  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS);
  const authData = await readAuthFileCached({
    maxAgeMs,
  });
  const auth = resolveAlibabaCodingPlanAuth(authData, fallbackTier);

  return {
    auth,
    source: auth.state === "none" ? null : "opencode.db",
  };
}

export async function resolveAlibabaCodingPlanAuthCached(params?: {
  maxAgeMs?: number;
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<ResolvedAlibabaCodingPlanAuth> {
  return (await resolveAlibabaCodingPlanAuthWithSource(params)).auth;
}

export async function getAlibabaCodingPlanAuthDiagnostics(params?: {
  maxAgeMs?: number;
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<AlibabaCodingPlanAuthDiagnostics> {
  const { auth, source } = await resolveAlibabaCodingPlanAuthWithSource(params);
  const checkedPaths = getApiKeyCheckedPaths({
    envVarNames: [...ALLOWED_ALIBABA_ENV_VARS],
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
  const credentialDatabasePaths = getCredentialDatabasePaths();

  if (auth.state === "none") {
    return {
      state: "none",
      source: null,
      checkedPaths,
      credentialDatabasePaths,
    };
  }

  if (auth.state === "invalid") {
    return {
      state: "invalid",
      source: "opencode.db",
      checkedPaths,
      credentialDatabasePaths,
      error: auth.error,
      rawTier: auth.rawTier,
    };
  }

  return {
    state: "configured",
    source: source ?? "opencode.db",
    checkedPaths,
    credentialDatabasePaths,
    tier: auth.tier,
  };
}

export function hasAlibabaAuth(auth: AuthData | null | undefined): boolean {
  return resolveAlibabaCodingPlanAuth(auth).state === "configured";
}

export function isAlibabaModelId(model?: string): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return normalized.startsWith("alibaba/") || normalized.startsWith("alibaba-cn/");
}
