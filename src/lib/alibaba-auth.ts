import type { AlibabaAuthData, AlibabaCodingPlanTier, AuthData } from "./types.js";
import { readAuthFileCached } from "./opencode-auth.js";

export const DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS = 5_000;

export type ResolvedAlibabaCodingPlanAuth =
  | { state: "none" }
  | { state: "configured"; apiKey: string; tier: AlibabaCodingPlanTier }
  | { state: "invalid"; error: string; rawTier?: string };

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

const DEFAULT_ALIBABA_CODING_PLAN_TIER: AlibabaCodingPlanTier = "lite";

function getAlibabaAuth(auth: AuthData | null | undefined): AlibabaAuthData | null {
  for (const key of ["alibaba-coding-plan", "alibaba"] as const) {
    const alibaba = auth?.[key];
    if (!alibaba) continue;

    const credential =
      typeof alibaba.key === "string" && alibaba.key.trim()
        ? alibaba.key.trim()
        : typeof alibaba.access === "string" && alibaba.access.trim()
          ? alibaba.access.trim()
          : "";

    if (!credential) {
      continue;
    }

    return alibaba;
  }
  return null;
}

function getAlibabaCredential(auth: AlibabaAuthData): string {
  return (auth.key?.trim() || auth.access?.trim() || "") as string;
}

export function resolveAlibabaCodingPlanAuth(
  auth: AuthData | null | undefined,
  fallbackTier: AlibabaCodingPlanTier = DEFAULT_ALIBABA_CODING_PLAN_TIER,
): ResolvedAlibabaCodingPlanAuth {
  const alibaba = getAlibabaAuth(auth);
  if (!alibaba) {
    return { state: "none" };
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
      apiKey: getAlibabaCredential(alibaba),
      tier: fallbackTier,
    };
  }

  if (!tier) {
    return {
      state: "invalid",
      error: `Unsupported Alibaba Coding Plan tier: ${rawTier}`,
      rawTier,
    };
  }

  return {
    state: "configured",
    apiKey: getAlibabaCredential(alibaba),
    tier,
  };
}

export async function resolveAlibabaCodingPlanAuthCached(params?: {
  maxAgeMs?: number;
  fallbackTier?: AlibabaCodingPlanTier;
}): Promise<ResolvedAlibabaCodingPlanAuth> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS),
  });
  return resolveAlibabaCodingPlanAuth(auth, params?.fallbackTier);
}

export function hasAlibabaAuth(auth: AuthData | null | undefined): boolean {
  return getAlibabaAuth(auth) !== null;
}

export function isAlibabaModelId(model?: string): boolean {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return normalized.startsWith("alibaba/") || normalized.startsWith("alibaba-cn/");
}
