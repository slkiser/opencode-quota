import { sanitizeSingleLineDisplaySnippet } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const KILO_USAGE_URL = "https://app.kilo.ai/usage";
const KILO_USAGE_SUMMARY_URL = "https://app.kilo.ai/api/trpc/usageAnalytics.getSummary";
const KILO_REQUEST_TIMEOUT_MS = 10_000;
const KILO_RESPONSE_MAX_BYTES = 512 * 1024;
const KILO_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export interface KiloUsageResult {
  usedMicrodollars: number | null;
  limitMicrodollars: number | null;
  balanceMicrodollars: number | null;
  resetTimeIso: string | null;
  planName: string | null;
  requestCount: number | null;
  totalTokens: number | null;
  freeRequestCount: number | null;
  byokRequestCount: number | null;
  /** Subscription tier from kiloPass.getState (e.g. "tier_19") */
  subscriptionTier: string | null;
  /** Subscription cadence (e.g. "monthly") */
  subscriptionCadence: string | null;
  /** Paid credits for this period in microdollars */
  periodBaseCreditsUsd: number | null;
  /** Bonus credits for this period in microdollars */
  periodBonusCreditsUsd: number | null;
  /** Hosting cost for this period in microdollars */
  periodHostingCostUsd: number | null;
  /** Total credit balance from credit blocks in microdollars */
  creditBalanceMicrodollars: number | null;
}

export type KiloDashboardResult =
  | { success: true; data: KiloUsageResult }
  | { success: false; error: string };

function emptyKiloUsageResult(): KiloUsageResult {
  return {
    usedMicrodollars: null,
    limitMicrodollars: null,
    balanceMicrodollars: null,
    resetTimeIso: null,
    planName: null,
    requestCount: null,
    totalTokens: null,
    freeRequestCount: null,
    byokRequestCount: null,
    subscriptionTier: null,
    subscriptionCadence: null,
    periodBaseCreditsUsd: null,
    periodBonusCreditsUsd: null,
    periodHostingCostUsd: null,
    creditBalanceMicrodollars: null,
  };
}

function parseNonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;

  const normalized = value.trim().replace(/,/gu, "");
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseMoneyToMicrodollars(value: unknown): number | null {
  const number = parseNonNegativeNumber(value);
  if (number === null) return null;
  return Number.isInteger(number) && number > 10_000 ? number : Math.round(number * 1_000_000);
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const parsed = parseMoneyToMicrodollars(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || !value.trim()) continue;
    return sanitizeSingleLineDisplaySnippet(value, 60) || null;
  }
  return null;
}

function mergeResult(target: KiloUsageResult, source: KiloUsageResult): void {
  target.usedMicrodollars ??= source.usedMicrodollars;
  target.limitMicrodollars ??= source.limitMicrodollars;
  target.balanceMicrodollars ??= source.balanceMicrodollars;
  target.resetTimeIso ??= source.resetTimeIso;
  target.planName ??= source.planName;
  target.requestCount ??= source.requestCount;
  target.totalTokens ??= source.totalTokens;
  target.freeRequestCount ??= source.freeRequestCount;
  target.byokRequestCount ??= source.byokRequestCount;
  target.subscriptionTier ??= source.subscriptionTier;
  target.subscriptionCadence ??= source.subscriptionCadence;
  target.periodBaseCreditsUsd ??= source.periodBaseCreditsUsd;
  target.periodBonusCreditsUsd ??= source.periodBonusCreditsUsd;
  target.periodHostingCostUsd ??= source.periodHostingCostUsd;
  target.creditBalanceMicrodollars ??= source.creditBalanceMicrodollars;
}

function parseKiloRecord(record: Record<string, unknown>): KiloUsageResult {
  const usedMicrodollars = pickNumber(record, [
    "usedMicrodollars",
    "used_microdollars",
    "usageMicrodollars",
    "usage_microdollars",
    "spentMicrodollars",
    "spent_microdollars",
    "used",
    "usage",
    "spent",
  ]);
  const limitMicrodollars = pickNumber(record, [
    "limitMicrodollars",
    "limit_microdollars",
    "monthlyLimitMicrodollars",
    "monthly_limit_microdollars",
    "creditLimitMicrodollars",
    "credit_limit_microdollars",
    "limit",
  ]);
  const balanceMicrodollars = pickNumber(record, [
    "balanceMicrodollars",
    "balance_microdollars",
    "creditBalanceMicrodollars",
    "credit_balance_microdollars",
    "remainingMicrodollars",
    "remaining_microdollars",
    "balance",
    "remaining",
  ]);
  const resetTimeIso = pickString(record, [
    "resetTimeIso",
    "reset_time_iso",
    "resetAt",
    "reset_at",
    "renewsAt",
    "renews_at",
    "currentPeriodEnd",
    "current_period_end",
  ]);
  const planName = pickString(record, [
    "planName",
    "plan_name",
    "plan",
    "tier",
    "subscriptionPlan",
    "subscription_plan",
  ]);

  return {
    ...emptyKiloUsageResult(),
    usedMicrodollars,
    limitMicrodollars,
    balanceMicrodollars,
    resetTimeIso,
    planName,
  };
}

function parseJsonValue(value: unknown, depth = 0): KiloUsageResult {
  const result = emptyKiloUsageResult();
  if (depth > 10 || value === null || value === undefined) return result;

  if (Array.isArray(value)) {
    for (const item of value) mergeResult(result, parseJsonValue(item, depth + 1));
    return result;
  }

  if (typeof value !== "object") return result;

  const record = value as Record<string, unknown>;
  mergeResult(result, parseKiloRecord(record));
  for (const child of Object.values(record)) mergeResult(result, parseJsonValue(child, depth + 1));
  return result;
}

function hasUsageData(result: KiloUsageResult): boolean {
  return (
    result.balanceMicrodollars !== null ||
    result.creditBalanceMicrodollars !== null ||
    result.usedMicrodollars !== null ||
    result.requestCount !== null ||
    result.totalTokens !== null ||
    (result.usedMicrodollars !== null && result.limitMicrodollars !== null && result.limitMicrodollars > 0)
  );
}

function extractJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = [];
  const scriptRe = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/giu;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(text)) !== null) {
    try {
      candidates.push(JSON.parse(match[1] ?? ""));
    } catch {
      // Ignore unrelated script payloads.
    }
  }

  const objectRe = /\{[^{}]*(?:credit|balance|usage|limit|subscription|plan)[^{}]*\}/giu;
  while ((match = objectRe.exec(text)) !== null) {
    try {
      candidates.push(JSON.parse(match[0]));
    } catch {
      // Next.js RSC lines are not always valid JSON objects.
    }
  }

  return candidates;
}

function parseTextFallback(text: string): KiloUsageResult {
  const result = emptyKiloUsageResult();

  const money = "\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)";
  const patterns = [
    { key: "balanceMicrodollars", re: new RegExp(`(?:balance|remaining credits?)\\D{0,40}${money}`, "iu") },
    { key: "usedMicrodollars", re: new RegExp(`(?:used|usage|spent)\\D{0,40}${money}`, "iu") },
    { key: "limitMicrodollars", re: new RegExp(`(?:limit|monthly credits?)\\D{0,40}${money}`, "iu") },
  ] as const;

  for (const { key, re } of patterns) {
    const match = text.match(re);
    if (!match?.[1]) continue;
    result[key] = parseMoneyToMicrodollars(match[1]);
  }

  const resetMatch = text.match(/(?:reset|renew|renews)[^0-9]{0,40}(\d{4}-\d{2}-\d{2}(?:T[0-9:.Z+-]+)?)/iu);
  if (resetMatch?.[1]) result.resetTimeIso = resetMatch[1];

  const planMatch = text.match(/(?:plan|tier)[^A-Za-z0-9]{0,20}([A-Za-z][A-Za-z0-9 _-]{1,40})/iu);
  if (planMatch?.[1]) result.planName = sanitizeSingleLineDisplaySnippet(planMatch[1], 60) || null;

  return result;
}

export function parseKiloUsagePage(text: string): KiloUsageResult | null {
  const combined = emptyKiloUsageResult();

  for (const candidate of extractJsonCandidates(text)) {
    mergeResult(combined, parseJsonValue(candidate));
  }
  mergeResult(combined, parseTextFallback(text));

  return hasUsageData(combined) ? combined : null;
}

function buildUsageSummaryUrl(now = new Date()): string {
  const endDate = now.toISOString();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - 30);
  const input = {
    startDate: start.toISOString(),
    endDate,
    granularity: "day",
    personalScope: "personal-only",
    viewAs: "self",
  };
  const url = new URL(KILO_USAGE_SUMMARY_URL);
  url.searchParams.set("input", JSON.stringify(input));
  return url.toString();
}

function parseInteger(value: unknown): number | null {
  const parsed = parseNonNegativeNumber(value);
  return parsed === null ? null : Math.floor(parsed);
}

export function parseKiloUsageSummaryResponse(text: string): KiloUsageResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const data = (parsed as { result?: { data?: unknown } }).result?.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const result = {
    ...emptyKiloUsageResult(),
    usedMicrodollars: parseMoneyToMicrodollars(record.costMicrodollars),
    planName: "Last 30 days",
    requestCount: parseInteger(record.requestCount),
    totalTokens: parseInteger(record.totalTokens),
    freeRequestCount: parseInteger(record.freeRequestCount),
    byokRequestCount: parseInteger(record.byokRequestCount),
  };

  return hasUsageData(result) ? result : null;
}

const KILO_PROFILE_BALANCE_URL = "https://app.kilo.ai/api/profile/balance";
const KILO_TRPC_BASE = "https://app.kilo.ai/api/trpc";

function buildTrpcUrl(procedure: string, input?: unknown): string {
  const url = new URL(`${KILO_TRPC_BASE}/${procedure}`);
  if (input !== undefined) url.searchParams.set("input", JSON.stringify(input));
  return url.toString();
}

function parseProfileBalanceResponse(text: string): number | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.balance === "number" && Number.isFinite(record.balance)) {
      return Math.round(record.balance * 1_000_000);
    }
    return null;
  } catch {
    return null;
  }
}

interface KiloPassStateData {
  subscription?: {
    subscriptionId?: string;
    tier?: string;
    cadence?: string;
    status?: string;
    currentPeriodBaseCreditsUsd?: number;
    currentPeriodUsageUsd?: number;
    currentPeriodBonusCreditsUsd?: number;
    currentPeriodHostingCostUsd?: number;
    nextBonusCreditsUsd?: number;
    nextBillingAt?: string;
    refillAt?: string;
    currentStreakMonths?: number;
    isFirstTimeSubscriberEver?: boolean;
  };
}

function parseKiloPassStateResponse(text: string): {
  tier: string | null;
  cadence: string | null;
  used: number | null;
  limit: number | null;
  bonus: number | null;
  hosting: number | null;
  refillAt: string | null;
} | null {
  try {
    const parsed = JSON.parse(text) as {
      result?: { data?: KiloPassStateData };
    };
    const sub = parsed?.result?.data?.subscription;
    if (!sub) return null;
    const used =
      typeof sub.currentPeriodUsageUsd === "number" && Number.isFinite(sub.currentPeriodUsageUsd)
        ? Math.round(sub.currentPeriodUsageUsd * 1_000_000)
        : null;
    const base =
      typeof sub.currentPeriodBaseCreditsUsd === "number" && Number.isFinite(sub.currentPeriodBaseCreditsUsd)
        ? Math.round(sub.currentPeriodBaseCreditsUsd * 1_000_000)
        : null;
    const bonus =
      typeof sub.currentPeriodBonusCreditsUsd === "number" && Number.isFinite(sub.currentPeriodBonusCreditsUsd)
        ? Math.round(sub.currentPeriodBonusCreditsUsd * 1_000_000)
        : null;
    const hosting =
      typeof sub.currentPeriodHostingCostUsd === "number" && Number.isFinite(sub.currentPeriodHostingCostUsd)
        ? Math.round(sub.currentPeriodHostingCostUsd * 1_000_000)
        : null;
    const limit = base !== null && bonus !== null ? base + bonus : base;
    return {
      tier: sub.tier ?? null,
      cadence: sub.cadence ?? null,
      used,
      limit,
      bonus,
      hosting,
      refillAt: sub.refillAt ?? null,
    };
  } catch {
    return null;
  }
}

interface CreditBlocksData {
  creditBlocks?: Array<{
    balance_mUsd?: number;
    expiry_date?: string | null;
    is_free?: boolean;
  }>;
  totalBalance_mUsd?: number;
}

function parseCreditBlocksResponse(text: string): {
  totalBalance_mUsd: number | null;
} | null {
  try {
    const parsed = JSON.parse(text) as {
      result?: { data?: CreditBlocksData };
    };
    const data = parsed?.result?.data;
    if (!data) return null;
    const totalBalance =
      typeof data.totalBalance_mUsd === "number" && Number.isFinite(data.totalBalance_mUsd)
        ? data.totalBalance_mUsd
        : null;
    return { totalBalance_mUsd: totalBalance };
  } catch {
    return null;
  }
}

async function queryKiloProfile(
  cookie: string,
  timeoutMs: number,
): Promise<KiloUsageResult | null> {
  const result = emptyKiloUsageResult();

  const balancePromise = fetchWithTimeout(KILO_PROFILE_BALANCE_URL, {
    request: {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Referer: "https://app.kilo.ai/profile",
        "User-Agent": KILO_USER_AGENT,
      },
    },
    timeoutMs,
    consume: async (response) => {
      if (!response.ok) return null;
      const text = await readBoundedText(response);
      return parseProfileBalanceResponse(text);
    },
  });

  const statePromise = fetchWithTimeout(buildTrpcUrl("kiloPass.getState"), {
    request: {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Referer: "https://app.kilo.ai/profile",
        "User-Agent": KILO_USER_AGENT,
      },
    },
    timeoutMs,
    consume: async (response) => {
      if (!response.ok) return null;
      const text = await readBoundedText(response);
      return parseKiloPassStateResponse(text);
    },
  });

  const creditBlocksPromise = fetchWithTimeout(buildTrpcUrl("user.getCreditBlocks", {}), {
    request: {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
        Referer: "https://app.kilo.ai/profile",
        "User-Agent": KILO_USER_AGENT,
      },
    },
    timeoutMs,
    consume: async (response) => {
      if (!response.ok) return null;
      const text = await readBoundedText(response);
      return parseCreditBlocksResponse(text);
    },
  });

  const [balance, state, creditBlocks] = await Promise.allSettled([
    balancePromise,
    statePromise,
    creditBlocksPromise,
  ]);

  if (balance.status === "fulfilled" && balance.value !== null) {
    result.balanceMicrodollars = balance.value;
  }
  if (state.status === "fulfilled" && state.value !== null) {
    result.usedMicrodollars ??= state.value.used;
    result.limitMicrodollars ??= state.value.limit;
    result.subscriptionTier = state.value.tier;
    result.subscriptionCadence = state.value.cadence;
    result.periodBaseCreditsUsd =
      state.value.limit !== null && state.value.bonus !== null ? state.value.limit - state.value.bonus : null;
    result.periodBonusCreditsUsd = state.value.bonus;
    result.periodHostingCostUsd = state.value.hosting;
    result.resetTimeIso ??= state.value.refillAt;
    result.planName ??= derivePlanName(state.value.tier, state.value.cadence);
  }
  if (creditBlocks.status === "fulfilled" && creditBlocks.value !== null) {
    result.creditBalanceMicrodollars = creditBlocks.value.totalBalance_mUsd;
  }

  return hasUsageData(result) ? result : null;
}

function mergedRequestCounts(target: KiloUsageResult, source: KiloUsageResult): void {
  target.requestCount ??= source.requestCount;
  target.totalTokens ??= source.totalTokens;
  target.freeRequestCount ??= source.freeRequestCount;
  target.byokRequestCount ??= source.byokRequestCount;
  target.usedMicrodollars ??= source.usedMicrodollars;
}

function derivePlanName(tier: string | null, cadence: string | null): string | null {
  if (!tier && !cadence) return null;
  const parts: string[] = [];
  if (tier) {
    if (tier === "tier_19") parts.push("Starter");
    else if (tier === "tier_49") parts.push("Pro");
    else if (tier === "tier_99") parts.push("Expert");
    else parts.push(tier.replace(/^tier_/iu, "Tier "));
  }
  return parts.join(" • ") || null;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error("empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > KILO_RESPONSE_MAX_BYTES) {
      throw new Error("response too large");
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > KILO_RESPONSE_MAX_BYTES) throw new Error("response too large");
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve original read error.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function getCookieValues(cookie: string): string[] {
  return cookie
    .split(";")
    .map((part) => part.slice(part.indexOf("=") + 1).trim())
    .filter(Boolean);
}

function sanitizeRequestError(error: unknown, cookie: string): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [cookie, ...getCookieValues(cookie)]) {
    message = message.split(secret).join("[redacted]");
  }
  return sanitizeSingleLineDisplaySnippet(message, 120) || "request failed";
}

export async function queryKiloDashboard(
  cookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<KiloDashboardResult> {
  try {
    const timeoutMs = options.requestTimeoutMs ?? KILO_REQUEST_TIMEOUT_MS;
    const summary = await fetchWithTimeout(buildUsageSummaryUrl(), {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Cookie: cookie,
          Referer: "https://app.kilo.ai/usage",
          "User-Agent": KILO_USER_AGENT,
        },
      },
      timeoutMs,
      consume: async (response, timeoutSignal): Promise<KiloDashboardResult> => {
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: "Kilo Gateway usage request requires login" };
        }
        if (!response.ok) {
          return { success: false, error: `Kilo Gateway usage summary request failed (HTTP ${response.status})` };
        }

        let text: string;
        try {
          text = await readBoundedText(response);
        } catch (error) {
          if (timeoutSignal.aborted) throw error;
          return { success: false, error: "Kilo Gateway usage summary response could not be read" };
        }

        const parsed = parseKiloUsageSummaryResponse(text);
        if (!parsed) {
          return {
            success: false,
            error: "Kilo Gateway usage summary did not contain recognized usage data",
          };
        }

        return { success: true, data: parsed };
      },
    });
    if (!summary.success && summary.error === "Kilo Gateway usage request requires login") return summary;

    const combined = emptyKiloUsageResult();

    const profileResult = await queryKiloProfile(cookie, timeoutMs);
    if (profileResult) mergeResult(combined, profileResult);

    if (summary.success && summary.data) {
      mergedRequestCounts(combined, summary.data);
      combined.planName ??= "Last 30 days";
    } else {
      const pageResult = await fetchWithTimeout(KILO_USAGE_URL, {
        request: {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            Cookie: cookie,
            Referer: "https://app.kilo.ai/usage",
            "User-Agent": KILO_USER_AGENT,
          },
        },
        timeoutMs,
        consume: async (response, timeoutSignal): Promise<KiloDashboardResult> => {
          if (response.status >= 300 && response.status < 400) {
            return { success: false, error: "Kilo Gateway usage request requires login" };
          }
          if (!response.ok) {
            return { success: false, error: `Kilo Gateway usage request failed (HTTP ${response.status})` };
          }

          let text: string;
          try {
            text = await readBoundedText(response);
          } catch (error) {
            if (timeoutSignal.aborted) throw error;
            return { success: false, error: "Kilo Gateway usage response could not be read" };
          }

          const parsed = parseKiloUsagePage(text);
          if (!parsed) {
            return {
              success: false,
              error: "Kilo Gateway usage response did not contain recognized quota or balance data",
            };
          }

          return { success: true, data: parsed };
        },
      });
      if (pageResult.success && pageResult.data) {
        mergeResult(combined, pageResult.data);
      }
    }

    if (!hasUsageData(combined)) {
      return {
        success: false,
        error: "No usage data found in Kilo Gateway usage API or page",
      };
    }

    return { success: true, data: combined };
  } catch (error) {
    return {
      success: false,
      error: `Kilo Gateway usage request failed: ${sanitizeRequestError(error, cookie)}`,
    };
  }
}
