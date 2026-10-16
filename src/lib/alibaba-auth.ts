import {
  API_KEY_VENDORS,
  type ApiKeySource,
  getApiKeyCheckedPaths,
  getFirstAuthEntryValue,
  parseApiKeyLogin,
  readApiKeyLoginAuth,
  resolveApiKeyFromEnvAndConfig,
} from "./api-key-resolver.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { asRecord, nonEmptyString } from "./json-guards.js";
import { getCredentialDatabasePaths } from "./opencode-auth.js";
import type { AlibabaCodingPlanTier, AuthData } from "./types.js";

const DEFAULT_ALIBABA_CODING_PLAN_TIER: AlibabaCodingPlanTier = "lite";
const ALIBABA = API_KEY_VENDORS["alibaba-coding-plan"];
const TIER_KEYS = ["tier", "planTier", "plan_tier", "subscriptionTier"] as const;

type ResolvedAlibabaCodingPlanAuth =
  | { state: "none" }
  | { state: "configured"; apiKey: string; tier: AlibabaCodingPlanTier }
  | { state: "invalid"; error: string; rawTier?: string };

type DiagnosticPaths = { checkedPaths: string[]; credentialDatabasePaths: string[] };

type AlibabaCodingPlanAuthDiagnostics =
  | ({ state: "none"; source: null } & DiagnosticPaths)
  | ({ state: "configured"; source: ApiKeySource; tier: AlibabaCodingPlanTier } & DiagnosticPaths)
  | ({
      state: "invalid";
      source: "opencode.db";
      error: string;
      rawTier?: string;
    } & DiagnosticPaths);

function normalizeAlibabaTier(value: string): AlibabaCodingPlanTier | null {
  const normalized = value.toLowerCase();
  if (normalized === "lite") return "lite";
  if (normalized === "pro" || normalized === "professional") return "pro";
  return null;
}

/** A stored API-key login; its tier field (if any) must name a known plan. */
export function resolveAlibabaCodingPlanAuth(
  auth: AuthData | null | undefined,
  fallbackTier: AlibabaCodingPlanTier = DEFAULT_ALIBABA_CODING_PLAN_TIER,
): ResolvedAlibabaCodingPlanAuth {
  // Unlike the other vendors, an explicit null Alibaba entry is a broken login, not "none".
  if (getFirstAuthEntryValue(auth, ALIBABA.authKeys) === null) {
    return { state: "invalid", error: "Alibaba Coding Plan auth entry has invalid shape" };
  }
  const login = parseApiKeyLogin(ALIBABA, auth);
  if (login.state !== "configured") return login;

  const entry = asRecord(getFirstAuthEntryValue(auth, ALIBABA.authKeys)) ?? {};
  const rawTier = TIER_KEYS.map((key) => nonEmptyString(entry[key])).find(Boolean);
  if (!rawTier) return { state: "configured", apiKey: login.apiKey, tier: fallbackTier };

  const tier = normalizeAlibabaTier(rawTier);
  if (!tier) {
    const sanitized = sanitizeDisplayText(rawTier).replace(/\s+/g, " ").trim();
    return {
      state: "invalid",
      error: `Unsupported Alibaba Coding Plan tier: ${(sanitized || "unknown").slice(0, 120)}`,
      rawTier,
    };
  }
  return { state: "configured", apiKey: login.apiKey, tier };
}

async function resolveAlibabaCodingPlanAuthWithSource(params?: {
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<{ auth: ResolvedAlibabaCodingPlanAuth; source: ApiKeySource | null }> {
  const fallbackTier = params?.fallbackTier ?? DEFAULT_ALIBABA_CODING_PLAN_TIER;
  const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(ALIBABA);
  if (fromEnvOrConfig) {
    return {
      auth: { state: "configured", apiKey: fromEnvOrConfig.key, tier: fallbackTier },
      source: fromEnvOrConfig.source,
    };
  }

  const auth = resolveAlibabaCodingPlanAuth(
    (await readApiKeyLoginAuth(ALIBABA)) as AuthData | null,
    fallbackTier,
  );
  return { auth, source: auth.state === "none" ? null : "opencode.db" };
}

export async function resolveAlibabaCodingPlanAuthCached(params?: {
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<ResolvedAlibabaCodingPlanAuth> {
  return (await resolveAlibabaCodingPlanAuthWithSource(params)).auth;
}

export async function getAlibabaCodingPlanAuthDiagnostics(): Promise<AlibabaCodingPlanAuthDiagnostics> {
  const { auth, source } = await resolveAlibabaCodingPlanAuthWithSource();
  const paths = {
    checkedPaths: getApiKeyCheckedPaths(ALIBABA),
    credentialDatabasePaths: getCredentialDatabasePaths(),
  };
  if (auth.state === "none") return { state: "none", source: null, ...paths };
  if (auth.state === "invalid") {
    return {
      state: "invalid",
      source: "opencode.db",
      error: auth.error,
      ...paths,
      ...(auth.rawTier !== undefined ? { rawTier: auth.rawTier } : {}),
    };
  }
  return { state: "configured", source: source ?? "opencode.db", tier: auth.tier, ...paths };
}

export function isAlibabaModelId(model?: string): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return normalized.startsWith("alibaba/") || normalized.startsWith("alibaba-cn/");
}
