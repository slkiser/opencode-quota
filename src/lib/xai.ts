/**
 * xAI SuperGrok subscription quota fetcher.
 *
 * Uses OpenCode auth.json OAuth entry for `xai` and queries Grok Build billing:
 * - GET https://cli-chat-proxy.grok.com/v1/billing?format=credits  (period primary)
 * - GET https://cli-chat-proxy.grok.com/v1/billing               (monthly $ secondary)
 * - GET https://grok.com/rest/subscriptions                      (plan label)
 *
 * Management API prepaid balance is intentionally not used: OAuth tokens are
 * rejected there with oauth2-auth-forbidden.
 */

import { readFile } from "fs/promises";

import type { AuthData, QuotaError, XaiOAuthData } from "./types.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import {
  clearReadAuthFileCacheForTests,
  getAuthPaths,
  readAuthFileCached,
} from "./opencode-auth.js";

export const DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
export const XAI_ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

const XAI_AUTH_SOURCE_KEYS = ["xai"] as const;
type XaiAuthSourceKey = (typeof XAI_AUTH_SOURCE_KEYS)[number];

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Same public Grok-CLI OAuth client used by OpenCode's xAI auth plugin.
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

export type XaiPeriodKind = "weekly" | "monthly" | "daily" | "period";

export interface XaiWindowValue {
  percentRemaining: number;
  resetTimeIso?: string;
  kind: XaiPeriodKind;
}

export interface XaiMonthlyAllowance {
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number;
  percentRemaining: number;
  resetTimeIso?: string;
}

export type XaiResult =
  | {
      success: true;
      label: string;
      /** True when Api/GrokChat share one weekly credit pool. */
      unifiedBilling: boolean;
      windows: {
        primary?: XaiWindowValue;
        products: Array<{ product: string; window: XaiWindowValue }>;
      };
      monthly?: XaiMonthlyAllowance;
    }
  | QuotaError
  | null;

export type ResolvedXaiOAuth =
  | { state: "none" }
  | {
      state: "configured";
      sourceKey: XaiAuthSourceKey;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseUsdCents(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const raw = value.val;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

function centsToUsd(cents: number): number {
  return Math.round(cents) / 100;
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

function accessTokenIsExpiring(
  token: string | undefined,
  skewMs = XAI_ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    let payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return false;
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

function getXaiOAuthEntry(
  auth: AuthData | null | undefined,
): { sourceKey: XaiAuthSourceKey; entry: XaiOAuthData; accessToken: string } | null {
  for (const sourceKey of XAI_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== "oauth") continue;
    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    if (accessToken) {
      return { sourceKey, entry, accessToken };
    }
  }
  return null;
}

export function resolveXaiOAuth(auth: AuthData | null | undefined): ResolvedXaiOAuth {
  const resolved = getXaiOAuthEntry(auth);
  if (!resolved) return { state: "none" };
  return {
    state: "configured",
    sourceKey: resolved.sourceKey,
    accessToken: resolved.accessToken,
    refreshToken:
      typeof resolved.entry.refresh === "string" && resolved.entry.refresh.trim()
        ? resolved.entry.refresh.trim()
        : undefined,
    expiresAt: typeof resolved.entry.expires === "number" ? resolved.entry.expires : undefined,
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

async function findAuthFilePathWithXai(): Promise<string | null> {
  for (const path of getAuthPaths()) {
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as AuthData;
      if (resolveXaiOAuth(parsed).state === "configured") return path;
    } catch {
      // try next path
    }
  }
  return null;
}

async function persistXaiOAuth(params: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): Promise<void> {
  const path = await findAuthFilePathWithXai();
  if (!path) return;

  try {
    const content = await readFile(path, "utf-8");
    const parsed = JSON.parse(content) as AuthData;
    const existing = parsed.xai;
    if (!existing || existing.type !== "oauth") return;

    parsed.xai = {
      ...existing,
      type: "oauth",
      access: params.accessToken,
      refresh: params.refreshToken,
      expires: params.expiresAt,
    };
    await writeJsonAtomic(path, parsed, { trailingNewline: true });
    clearReadAuthFileCacheForTests();
  } catch {
    // Best-effort: in-memory refreshed token still works for this query.
  }
}

async function refreshXaiAccessToken(
  refreshToken: string,
  requestTimeoutMs?: number,
): Promise<
  | { success: true; accessToken: string; refreshToken: string; expiresAt: number }
  | { success: false; error: string }
> {
  try {
    const resp = await fetchWithTimeout(
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
          client_id: XAI_OAUTH_CLIENT_ID,
        }).toString(),
      },
      requestTimeoutMs,
    );

    if (!resp.ok) {
      const text = await resp.text();
      return {
        success: false,
        error: `xAI token refresh failed (${resp.status}): ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    const data = (await resp.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };
    const accessToken = getNonEmptyString(data.access_token);
    if (!accessToken) {
      return { success: false, error: "xAI token refresh returned no access token" };
    }

    const nextRefresh = getNonEmptyString(data.refresh_token) ?? refreshToken;
    const expiresIn =
      typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0
        ? data.expires_in
        : 3600;

    return {
      success: true,
      accessToken,
      refreshToken: nextRefresh,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function ensureFreshXaiAccess(
  resolved: Extract<ResolvedXaiOAuth, { state: "configured" }>,
  requestTimeoutMs?: number,
): Promise<{ success: true; accessToken: string } | { success: false; error: string }> {
  const expiresSoon =
    !resolved.expiresAt ||
    resolved.expiresAt - Date.now() <= XAI_ACCESS_TOKEN_REFRESH_SKEW_MS ||
    accessTokenIsExpiring(resolved.accessToken);

  if (!expiresSoon) {
    return { success: true, accessToken: resolved.accessToken };
  }

  if (!resolved.refreshToken) {
    if (resolved.expiresAt && resolved.expiresAt < Date.now()) {
      return { success: false, error: "Token expired" };
    }
    return { success: true, accessToken: resolved.accessToken };
  }

  const refreshed = await refreshXaiAccessToken(resolved.refreshToken, requestTimeoutMs);
  if (!refreshed.success) {
    if (resolved.expiresAt && resolved.expiresAt < Date.now()) {
      return { success: false, error: refreshed.error };
    }
    // Prefer a still-valid access token over a refresh failure.
    if (!accessTokenIsExpiring(resolved.accessToken, 0)) {
      return { success: true, accessToken: resolved.accessToken };
    }
    return { success: false, error: refreshed.error };
  }

  await persistXaiOAuth({
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  });

  return { success: true, accessToken: refreshed.accessToken };
}

function billingHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-grok-client-surface": "grok-build",
    "x-grok-client-version": "1.0.0",
  };
}

function deriveLabel(params: { tier?: string; productId?: string }): string {
  const tier = params.tier ?? "";
  const productId = params.productId ?? "";
  if (productId === "grok.ultra" || /SUPER_GROK_PRO|HEAVY|ULTRA/i.test(tier)) {
    return "xAI SuperGrok";
  }
  if (/SUPER_GROK/i.test(tier)) {
    return "xAI SuperGrok";
  }
  return "xAI";
}

function percentFromUsed(usedPercent: number): number {
  return clampPercent(100 - usedPercent);
}

function parseCreditsConfig(payload: unknown): {
  primary?: XaiWindowValue;
  products: Array<{ product: string; window: XaiWindowValue }>;
  unifiedBilling: boolean;
} {
  if (!isRecord(payload) || !isRecord(payload.config)) {
    throw new Error("xAI credits response returned an unexpected response shape");
  }

  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  const kind = periodKindFromType(period?.type);
  const resetTimeIso = isoOrUndefined(period?.end) ?? isoOrUndefined(config.billingPeriodEnd);
  const products: Array<{ product: string; window: XaiWindowValue }> = [];
  const unifiedBilling = config.isUnifiedBillingUser === true;

  // Protobuf JSON omits zero-valued fields. Presence of a period/product row
  // without usagePercent means 0% used, not "missing quota".
  let primary: XaiWindowValue | undefined;
  const hasPeriodContext = Boolean(period) || typeof config.creditUsagePercent === "number";
  if (hasPeriodContext) {
    const used =
      typeof config.creditUsagePercent === "number" && Number.isFinite(config.creditUsagePercent)
        ? config.creditUsagePercent
        : 0;
    primary = {
      percentRemaining: percentFromUsed(used),
      resetTimeIso,
      kind,
    };
  }

  // Product rows (Api/GrokChat) are breakdowns of the same weekly pool under
  // unified billing. Still parse them for diagnostics, but the provider UI
  // suppresses them when unifiedBilling is true.
  if (Array.isArray(config.productUsage)) {
    for (const row of config.productUsage) {
      if (!isRecord(row)) continue;
      const product = getNonEmptyString(row.product);
      if (!product) continue;
      const used =
        typeof row.usagePercent === "number" && Number.isFinite(row.usagePercent)
          ? row.usagePercent
          : 0;
      products.push({
        product,
        window: {
          percentRemaining: percentFromUsed(used),
          resetTimeIso,
          kind,
        },
      });
    }
  }

  return { primary, products, unifiedBilling };
}

function parseMonthlyConfig(payload: unknown): XaiMonthlyAllowance | undefined {
  if (!isRecord(payload) || !isRecord(payload.config)) return undefined;
  const config = payload.config;
  const limitCents = parseUsdCents(config.monthlyLimit);
  const usedCents = parseUsdCents(config.used);
  if (limitCents === null || usedCents === null || limitCents <= 0) return undefined;

  const remainingCents = Math.max(0, limitCents - usedCents);
  const percentRemaining = clampPercent((remainingCents / limitCents) * 100);
  return {
    limitUsd: centsToUsd(limitCents),
    usedUsd: centsToUsd(usedCents),
    remainingUsd: centsToUsd(remainingCents),
    percentRemaining,
    resetTimeIso: isoOrUndefined(config.billingPeriodEnd),
  };
}

function parseSubscriptionLabel(payload: unknown): string {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.subscriptions) ||
    payload.subscriptions.length === 0
  ) {
    return "xAI";
  }

  const active =
    payload.subscriptions.find((item) => {
      if (!isRecord(item)) return false;
      const status = getNonEmptyString(item.status)?.toUpperCase() ?? "";
      return status.includes("ACTIVE") || status.includes("TRIAL");
    }) ?? payload.subscriptions[0];

  if (!isRecord(active)) return "xAI";

  const tier = getNonEmptyString(active.tier);
  let productId: string | undefined;
  for (const key of ["google", "apple", "stripe", "web"] as const) {
    const provider = active[key];
    if (isRecord(provider)) {
      productId = getNonEmptyString(provider.productId) ?? productId;
    }
  }

  return deriveLabel({ tier, productId });
}

async function fetchJson(
  url: string,
  accessToken: string,
  requestTimeoutMs?: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const resp = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: billingHeaders(accessToken),
      },
      requestTimeoutMs,
    );

    if (!resp.ok) {
      const text = await resp.text();
      return {
        ok: false,
        error: `xAI API error ${resp.status}: ${sanitizeDisplaySnippet(text, 120)}`,
      };
    }

    return { ok: true, data: await resp.json() };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}

export function formatXaiMonthlyValue(monthly: XaiMonthlyAllowance): string {
  const remaining = monthly.remainingUsd.toFixed(2);
  const used = monthly.usedUsd.toFixed(2);
  const limit = monthly.limitUsd.toFixed(2);
  return `$${remaining} left ($${used}/$${limit})`;
}

export async function queryXaiQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<XaiResult> {
  const auth = await readAuthFileCached({
    maxAgeMs: DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS,
  });
  const resolvedAuth = resolveXaiOAuth(auth);
  if (resolvedAuth.state !== "configured") return null;

  const fresh = await ensureFreshXaiAccess(resolvedAuth, options.requestTimeoutMs);
  if (!fresh.success) {
    return { success: false, error: fresh.error };
  }

  try {
    // Keep the primary credits request independent of optional endpoints so a
    // subscription/label timeout cannot discard valid weekly quota data.
    const creditsResult = await fetchJson(CREDITS_URL, fresh.accessToken, options.requestTimeoutMs);
    if (!creditsResult.ok) {
      return { success: false, error: creditsResult.error };
    }

    const [billingResult, subsResult] = await Promise.all([
      fetchJson(BILLING_URL, fresh.accessToken, options.requestTimeoutMs),
      fetchJson(SUBSCRIPTIONS_URL, fresh.accessToken, options.requestTimeoutMs),
    ]);

    const credits = parseCreditsConfig(creditsResult.data);
    const monthly = billingResult.ok ? parseMonthlyConfig(billingResult.data) : undefined;
    const label = subsResult.ok ? parseSubscriptionLabel(subsResult.data) : "xAI";

    if (!credits.primary && credits.products.length === 0 && !monthly) {
      return { success: false, error: "No quota data" };
    }

    return {
      success: true,
      label,
      unifiedBilling: credits.unifiedBilling,
      windows: {
        primary: credits.primary,
        products: credits.products,
      },
      monthly,
    };
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
