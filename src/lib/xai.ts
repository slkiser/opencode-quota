/**
 * xAI SuperGrok subscription quota fetcher.
 *
 * Uses OpenCode's read-only `xai` OAuth entry and queries the same shared
 * period meter exposed by Grok Build:
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * After quota succeeds, subscription metadata may refine the display label via:
 * GET https://grok.com/rest/subscriptions
 *
 * OpenCode remains the sole owner of OAuth refresh and opencode.db persistence.
 */

import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData, QuotaError } from "./types.js";

export const DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS = 5_000;

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const SUBSCRIPTIONS_TIMEOUT_MS = 2_000;
const HEAVY_OFFER_ID_RE = /^heavy-p\d+m-\d{1,2}-[a-z]{3}\d{4}$/i;
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

export type XaiPeriodKind = "weekly" | "monthly" | "daily" | "period";
export type XaiSubscriptionTier = "Lite" | "SuperGrok" | "Heavy";
export type XaiLabel = "xAI Lite" | "xAI SuperGrok" | "xAI Heavy";

export interface XaiWindowValue {
  percentRemaining: number;
  resetTimeIso?: string;
  kind: XaiPeriodKind;
}

export type XaiResult =
  | {
      success: true;
      label: XaiLabel;
      window: XaiWindowValue;
    }
  | QuotaError
  | null;

export type ResolvedXaiOAuth =
  | { state: "none" }
  | {
      state: "configured";
      accessToken: string;
      expiresAt?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isoOrUndefined(value: unknown): string | undefined {
  const raw = getNonEmptyString(value);
  if (!raw) return undefined;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function periodKindFromType(value: unknown): XaiPeriodKind {
  const raw = getNonEmptyString(value)?.toUpperCase() ?? "";
  if (raw.includes("WEEK")) return "weekly";
  if (raw.includes("MONTH")) return "monthly";
  if (raw.includes("DAY")) return "daily";
  return "period";
}

export function periodKindLabel(kind: XaiPeriodKind): string {
  switch (kind) {
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "daily":
      return "Daily";
    default:
      return "Period";
  }
}

export function resolveXaiOAuth(auth: AuthData | null | undefined): ResolvedXaiOAuth {
  const entry = auth?.xai;
  if (!entry || entry.type !== "oauth") return { state: "none" };

  const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
  if (!accessToken) return { state: "none" };

  return {
    state: "configured",
    accessToken,
    expiresAt:
      typeof entry.expires === "number" && Number.isFinite(entry.expires)
        ? entry.expires
        : undefined,
  };
}

export function hasXaiOAuth(auth: AuthData | null | undefined): boolean {
  return resolveXaiOAuth(auth).state === "configured";
}

export async function hasXaiOAuthCached(params?: { maxAgeMs?: number }): Promise<boolean> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS),
  });
  return hasXaiOAuth(auth);
}

function parseCreditsWindow(payload: unknown): XaiWindowValue | null {
  if (!isRecord(payload) || !isRecord(payload.config)) {
    throw new Error("xAI credits response returned an unexpected response shape");
  }

  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  const hasUsage = Object.hasOwn(config, "creditUsagePercent");
  const hasPeriod = Boolean(
    getNonEmptyString(period?.type) ||
      getNonEmptyString(period?.start) ||
      getNonEmptyString(period?.end),
  );
  if (!hasPeriod && !hasUsage) return null;

  if (
    hasUsage &&
    (typeof config.creditUsagePercent !== "number" || !Number.isFinite(config.creditUsagePercent))
  ) {
    throw new Error("xAI credits response returned an invalid usage percentage");
  }

  // Protobuf JSON omits zero-valued fields, so an absent percentage with a
  // current period means 0% used rather than missing quota.
  const usedPercent = hasUsage ? (config.creditUsagePercent as number) : 0;

  return {
    percentRemaining: clampPercent(100 - usedPercent),
    resetTimeIso: isoOrUndefined(period?.end) ?? isoOrUndefined(config.billingPeriodEnd),
    kind: periodKindFromType(period?.type),
  };
}

function xaiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-grok-client-surface": "grok-build",
    "x-grok-client-version": "1.0.0",
  };
}

function parseXaiSubscriptionTier(payload: unknown): XaiSubscriptionTier | null {
  if (!isRecord(payload) || !Array.isArray(payload.subscriptions)) return null;

  const active = payload.subscriptions.find(
    (subscription) =>
      isRecord(subscription) && subscription.status === "SUBSCRIPTION_STATUS_ACTIVE",
  );
  if (!isRecord(active)) return null;

  const tier = getNonEmptyString(active.tier);
  const activeOffer = isRecord(active.activeOffer) ? active.activeOffer : null;
  const providerOfferId = getNonEmptyString(activeOffer?.providerOfferId);

  if (providerOfferId && HEAVY_OFFER_ID_RE.test(providerOfferId)) return "Heavy";

  switch (tier) {
    case "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY":
      return "Heavy";
    case "SUBSCRIPTION_TIER_SUPER_GROK_LITE":
      return "Lite";
    case "SUBSCRIPTION_TIER_SUPER_GROK":
    case "SUBSCRIPTION_TIER_SUPER_GROK_PRO":
      return "SuperGrok";
    default:
      return null;
  }
}

function xaiLabelForTier(tier: XaiSubscriptionTier | null): XaiLabel {
  switch (tier) {
    case "Lite":
      return "xAI Lite";
    case "Heavy":
      return "xAI Heavy";
    default:
      return "xAI SuperGrok";
  }
}

async function queryXaiSubscriptionTier(
  accessToken: string,
  requestTimeoutMs?: number,
): Promise<XaiSubscriptionTier | null> {
  try {
    return await fetchWithTimeout(SUBSCRIPTIONS_URL, {
      request: {
        method: "GET",
        headers: xaiHeaders(accessToken),
      },
      timeoutMs: Math.min(requestTimeoutMs ?? SUBSCRIPTIONS_TIMEOUT_MS, SUBSCRIPTIONS_TIMEOUT_MS),
      consume: async (response) => {
        if (!response.ok) return null;
        return parseXaiSubscriptionTier(await response.json());
      },
    });
  } catch {
    return null;
  }
}

function safeErrorText(message: string, accessToken: string): string {
  const redacted = accessToken ? message.split(accessToken).join("[redacted]") : message;
  return sanitizeSingleLineDisplaySnippet(redacted, 160);
}

export async function queryXaiQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<XaiResult> {
  // OpenCode can replace this OAuth entry while servicing a model request.
  // Read the file directly so a post-request quota fetch cannot reuse the
  // token snapshot from before that refresh.
  const resolvedAuth = resolveXaiOAuth(await readAuthFile());
  if (resolvedAuth.state !== "configured") return null;

  if (resolvedAuth.expiresAt !== undefined && resolvedAuth.expiresAt <= Date.now()) {
    return {
      success: false,
      error: "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    };
  }

  try {
    const creditsResult = await fetchWithTimeout<
      { success: true; window: XaiWindowValue } | QuotaError
    >(CREDITS_URL, {
      request: {
        method: "GET",
        headers: xaiHeaders(resolvedAuth.accessToken),
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const body = await response.text();
          return {
            success: false,
            error: `xAI API error ${response.status}: ${safeErrorText(body, resolvedAuth.accessToken)}`,
          };
        }

        const window = parseCreditsWindow(await response.json());
        if (!window) return { success: false, error: "No weekly quota data" };

        return { success: true, window };
      },
    });
    if (!creditsResult.success) return creditsResult;

    const tier = await queryXaiSubscriptionTier(resolvedAuth.accessToken, options.requestTimeoutMs);
    return { success: true, label: xaiLabelForTier(tier), window: creditsResult.window };
  } catch (error) {
    return {
      success: false,
      error: safeErrorText(
        error instanceof Error ? error.message : String(error),
        resolvedAuth.accessToken,
      ),
    };
  }
}
