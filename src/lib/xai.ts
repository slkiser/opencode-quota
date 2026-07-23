/**
 * xAI SuperGrok subscription quota fetcher.
 *
 * Uses OpenCode's `xai` OAuth entry and queries the shared period meter
 * exposed by Grok Build:
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * Expired OAuth credentials are refreshed and then atomically saved back to
 * the matching xAI entry without changing unrelated auth.json credentials.
 */

import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  hasOpenCodeAuthContentOverride,
  isCurrentXaiOAuth,
  readAuthFile,
  readAuthFileCached,
  updateCurrentXaiOAuth,
} from "./opencode-auth.js";
import type { AuthData, QuotaError } from "./types.js";

export const DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";
const XAI_CONCURRENT_REFRESH_READ_ATTEMPTS = 3;
const XAI_CONCURRENT_REFRESH_READ_DELAY_MS = 50;

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
      refreshToken?: string;
      expiresAt?: number;
    };

type ConfiguredXaiOAuth = Extract<ResolvedXaiOAuth, { state: "configured" }>;
type XaiOAuthRefreshResult = ConfiguredXaiOAuth | QuotaError;

export interface QueryXaiQuotaOptions {
  requestTimeoutMs?: number;
}

const xaiOAuthRefreshInFlight = new Map<string, Promise<XaiOAuthRefreshResult>>();

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
    refreshToken: getNonEmptyString(entry.refresh),
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

function accessTokenIsExpiring(accessToken: string): boolean {
  const payload = accessToken.split(".")[1];
  if (!payload) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return (
      typeof claims.exp === "number" &&
      Number.isFinite(claims.exp) &&
      claims.exp * 1_000 <= Date.now() + XAI_ACCESS_TOKEN_REFRESH_SKEW_MS
    );
  } catch {
    return false;
  }
}

function needsXaiOAuthRefresh(auth: ConfiguredXaiOAuth): boolean {
  // Preserve access-only credentials from older OpenCode/companion auth
  // formats. Without a refresh token, querying the current bearer is safer
  // than treating an absent stored expiry as an unrecoverable auth failure.
  if (!auth.expiresAt && !auth.refreshToken) return false;

  return (
    !auth.expiresAt ||
    auth.expiresAt - Date.now() <= XAI_ACCESS_TOKEN_REFRESH_SKEW_MS ||
    accessTokenIsExpiring(auth.accessToken)
  );
}

async function readUpdatedXaiOAuth(
  auth: ConfiguredXaiOAuth,
): Promise<ConfiguredXaiOAuth | undefined> {
  for (let attempt = 0; attempt < XAI_CONCURRENT_REFRESH_READ_ATTEMPTS; attempt++) {
    const updated = resolveXaiOAuth(await readAuthFile());
    if (updated.state === "configured" && !needsXaiOAuthRefresh(updated)) {
      const changed =
        updated.accessToken !== auth.accessToken ||
        updated.refreshToken !== auth.refreshToken ||
        updated.expiresAt !== auth.expiresAt;
      if (changed) return updated;
    }

    if (attempt + 1 < XAI_CONCURRENT_REFRESH_READ_ATTEMPTS) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, XAI_CONCURRENT_REFRESH_READ_DELAY_MS),
      );
    }
  }

  return undefined;
}

function refreshError(error: string): QuotaError {
  return { success: false, error };
}

function isQuotaError(result: XaiOAuthRefreshResult): result is QuotaError {
  return "success" in result && result.success === false;
}

async function refreshXaiOAuth(params: {
  auth: ConfiguredXaiOAuth;
  requestTimeoutMs?: number;
}): Promise<XaiOAuthRefreshResult> {
  const { auth, requestTimeoutMs } = params;
  const refreshToken = auth.refreshToken;
  if (!refreshToken) {
    return refreshError("xAI OAuth token expired; reconnect xAI");
  }
  if (hasOpenCodeAuthContentOverride()) {
    return refreshError("xAI OAuth token expired; update OPENCODE_AUTH_CONTENT or reconnect xAI");
  }
  const refreshKey = `${auth.accessToken}\u0000${refreshToken}`;
  const existing = xaiOAuthRefreshInFlight.get(refreshKey);
  if (existing) return existing;

  const refreshPromise = (async (): Promise<XaiOAuthRefreshResult> => {
    try {
      if (!(await isCurrentXaiOAuth({ access: auth.accessToken, refresh: refreshToken }))) {
        return (
          (await readUpdatedXaiOAuth(auth)) ??
          refreshError("xAI OAuth changed; retry or reconnect xAI")
        );
      }

      const response = await fetchWithTimeout(
        TOKEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: XAI_CLIENT_ID,
          }).toString(),
        },
        requestTimeoutMs,
      );
      if (!response.ok) {
        return (
          (await readUpdatedXaiOAuth(auth)) ??
          refreshError(`xAI OAuth refresh failed (${response.status}); reconnect xAI`)
        );
      }

      const payload = await response.json();
      if (!isRecord(payload)) {
        return refreshError("xAI OAuth refresh returned invalid credentials; reconnect xAI");
      }

      const access = getNonEmptyString(payload.access_token);
      if (!access) {
        return refreshError("xAI OAuth refresh returned invalid credentials; reconnect xAI");
      }

      const refresh = getNonEmptyString(payload.refresh_token) ?? refreshToken;
      const expiresIn = payload.expires_in;
      const expiresSeconds =
        typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn
          : 3_600;
      const credentials = {
        access,
        refresh,
        expires: Date.now() + expiresSeconds * 1_000,
      };

      const persisted = await updateCurrentXaiOAuth({
        expectedAccess: auth.accessToken,
        expectedRefresh: refreshToken,
        ...credentials,
      });
      if (!persisted) {
        return (
          (await readUpdatedXaiOAuth(auth)) ??
          refreshError("xAI OAuth changed during refresh; retry or reconnect xAI")
        );
      }

      return {
        state: "configured",
        accessToken: credentials.access,
        refreshToken: credentials.refresh,
        expiresAt: credentials.expires,
      };
    } catch {
      return (
        (await readUpdatedXaiOAuth(auth)) ?? refreshError("xAI OAuth refresh failed; reconnect xAI")
      );
    }
  })();

  xaiOAuthRefreshInFlight.set(refreshKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    if (xaiOAuthRefreshInFlight.get(refreshKey) === refreshPromise) {
      xaiOAuthRefreshInFlight.delete(refreshKey);
    }
  }
}

/** Test helper to clear an in-flight xAI OAuth refresh between test cases. */
export function clearXaiOAuthRefreshForTests(): void {
  xaiOAuthRefreshInFlight.clear();
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

export async function queryXaiQuota(options: QueryXaiQuotaOptions = {}): Promise<XaiResult> {
  // OpenCode can replace this OAuth entry while servicing a model request.
  // Read the file directly so a post-request quota fetch cannot reuse the
  // token snapshot from before that refresh.
  let resolvedAuth = resolveXaiOAuth(await readAuthFile());
  if (resolvedAuth.state !== "configured") return null;

  if (needsXaiOAuthRefresh(resolvedAuth)) {
    const refreshed = await refreshXaiOAuth({
      auth: resolvedAuth,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    if (isQuotaError(refreshed)) return refreshed;
    resolvedAuth = refreshed;
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
