/**
 * xAI SuperGrok subscription quota fetcher.
 *
 * Uses OpenCode's read-only `xai` OAuth entry and queries the same shared
 * period meter exposed by Grok Build:
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * OpenCode remains the sole owner of OAuth refresh and auth.json persistence.
 */

import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFile, readAuthFileCached } from "./opencode-auth.js";
import type { AuthData, QuotaError } from "./types.js";

export const DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS = 5_000;

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

export type XaiPeriodKind = "weekly" | "monthly" | "daily" | "period";

export interface XaiWindowValue {
  percentRemaining: number;
  resetTimeIso?: string;
  kind: XaiPeriodKind;
}

export type XaiResult =
  | {
      success: true;
      label: "xAI SuperGrok";
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
  const hasUsage = Object.prototype.hasOwnProperty.call(config, "creditUsagePercent");
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
    const response = await fetchWithTimeout(
      CREDITS_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${resolvedAuth.accessToken}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          "x-grok-client-surface": "grok-build",
          "x-grok-client-version": "1.0.0",
        },
      },
      options.requestTimeoutMs,
    );

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        error: `xAI API error ${response.status}: ${safeErrorText(body, resolvedAuth.accessToken)}`,
      };
    }

    const window = parseCreditsWindow(await response.json());
    if (!window) return { success: false, error: "No weekly quota data" };

    return { success: true, label: "xAI SuperGrok", window };
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
