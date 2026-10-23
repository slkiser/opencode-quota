import {
  API_KEY_VENDORS,
  type ApiKeySource,
  getApiKeyCheckedPaths,
  parseApiKeyLogin,
  readApiKeyLoginRow,
  resolveApiKeyFromEnvAndConfig,
} from "./api-key-resolver.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import { nonEmptyString } from "./json-guards.js";
import { type CredentialRow, getCredentialDatabasePaths } from "./opencode-auth.js";
import type { AlibabaCodingPlanTier } from "./types.js";

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
  row: CredentialRow | undefined,
  fallbackTier: AlibabaCodingPlanTier = DEFAULT_ALIBABA_CODING_PLAN_TIER,
): ResolvedAlibabaCodingPlanAuth {
  if (!row) return { state: "none" };
  const login = parseApiKeyLogin(ALIBABA, row);
  if (login.state !== "configured") return login;

  const rawTier = TIER_KEYS.map((key) => nonEmptyString(row.value[key])).find(Boolean);
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

async function resolveAlibabaCodingPlanAuthWithSource(
  directory: string,
  params?: { fallbackTier?: AlibabaCodingPlanTier },
): Promise<{ auth: ResolvedAlibabaCodingPlanAuth; source: ApiKeySource | null }> {
  const fallbackTier = params?.fallbackTier ?? DEFAULT_ALIBABA_CODING_PLAN_TIER;
  const fromEnvOrConfig = await resolveApiKeyFromEnvAndConfig(ALIBABA, directory);
  if (fromEnvOrConfig) {
    return {
      auth: { state: "configured", apiKey: fromEnvOrConfig.key, tier: fallbackTier },
      source: fromEnvOrConfig.source,
    };
  }

  const auth = resolveAlibabaCodingPlanAuth(await readApiKeyLoginRow(ALIBABA), fallbackTier);
  return { auth, source: auth.state === "none" ? null : "opencode.db" };
}

export async function resolveAlibabaCodingPlanAuthCached(
  directory: string,
  params?: { fallbackTier?: AlibabaCodingPlanTier },
): Promise<ResolvedAlibabaCodingPlanAuth> {
  return (await resolveAlibabaCodingPlanAuthWithSource(directory, params)).auth;
}

export async function getAlibabaCodingPlanAuthDiagnostics(
  directory: string,
): Promise<AlibabaCodingPlanAuthDiagnostics> {
  const { auth, source } = await resolveAlibabaCodingPlanAuthWithSource(directory);
  const paths = {
    checkedPaths: getApiKeyCheckedPaths(ALIBABA, directory),
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
