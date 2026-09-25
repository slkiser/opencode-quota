import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import type { OpenCodeZenConsoleAccount } from "./opencode-zen-config.js";

const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console session expired or invalid — run `opencode console login` to sign in again";

/**
 * The OpenCode Console reports amounts in micro-cents:
 * one US dollar is 100,000,000 micro-cents (billing units).
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

export interface OpenCodeZenBillingData {
  balance: number;
  /** Credit limit in USD; null when the account has no limit or billing/account failed. */
  monthlyLimit: number | null;
  /** Current-month usage in billing units; null when usage/cost-by-day failed. */
  monthlyUsage: number | null;
  lastPayment: number | null;
  /** Auto-reload state; null (unknown) when billing/auto-recharge failed. */
  reload: boolean | null;
  reloadAmount: number | null;
  reloadTrigger: number | null;
  /** Org-budget reset ISO timestamp; only set when budgets/org supplies the monthly budget. */
  budgetResetIso: string | null;
}

/**
 * billing/status (balance) is required. The other routes are optional: when one fails,
 * its fields are null and its error is listed in `errors`.
 */
export type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData; errors: string[] }
  | { success: false; error: string };

type ConsoleRoute =
  | "billing/status"
  | "billing/account"
  | "billing/auto-recharge"
  | "budgets/org"
  | "usage/cost-by-day";

type ConsoleRouteResult<T> = { success: true; data: T } | { success: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Console micro-cent amounts arrive as decimal strings; numbers are accepted too. */
function parseMicroCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function invalidResponse(): never {
  throw new Error("Unexpected OpenCode Console response");
}

function parseDollars(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return invalidResponse();
}

function parseBalance(json: unknown): number {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  return balance === null ? invalidResponse() : Math.max(0, balance);
}

/** Returns the credit limit in USD, or null when the account has no limit. */
function parseCreditLimit(json: unknown): number | null {
  const value = asRecord(json)?.creditLimitMicroCents;
  if (value === null) return null;

  const limit = parseMicroCents(value);
  return limit === null ? invalidResponse() : limit / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
}

function parseAutoRecharge(
  json: unknown,
): Pick<OpenCodeZenBillingData, "reload" | "reloadAmount" | "reloadTrigger"> {
  const autoRecharge = asRecord(json);
  if (!autoRecharge || typeof autoRecharge.enabled !== "boolean") return invalidResponse();

  return {
    reload: autoRecharge.enabled,
    reloadAmount: parseDollars(autoRecharge.rechargeAmountDollars),
    reloadTrigger: parseDollars(autoRecharge.thresholdDollars),
  };
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Sums the current UTC month's daily costs in micro-cents; an empty list means no usage. */
function parseMonthlyUsage(json: unknown, now: Date): number {
  if (!Array.isArray(json)) return invalidResponse();

  const month = currentUtcMonth(now);
  let total = 0;
  for (const item of json) {
    const day = asRecord(item);
    const cost = parseMicroCents(day?.totalCostMicroCents);
    if (typeof day?.date !== "string" || cost === null) return invalidResponse();
    if (day.date.slice(0, 7) === month) total += cost;
  }
  return Number.isFinite(total) ? total : invalidResponse();
}

/** Parses the org budget; a null limit means the org has no budget configured. */
function parseOrgBudget(json: unknown): {
  limitMicroCents: number | null;
  spentMicroCents: number | null;
  resetsAt: string | null;
} {
  const budget = asRecord(json);
  if (!budget) return invalidResponse();

  const limitValue = budget.limitMicroCents;
  if (limitValue === undefined) return invalidResponse();
  const limit = limitValue === null ? null : parseMicroCents(limitValue);
  if (limitValue !== null && limit === null) return invalidResponse();

  const spentValue = budget.spentMicroCents;
  if (spentValue === undefined) return invalidResponse();
  const spent = spentValue === null ? null : parseMicroCents(spentValue);
  if (spentValue !== null && spent === null) return invalidResponse();

  const resetsAt = budget.resetsAt;
  if (resetsAt !== null && resetsAt !== undefined && typeof resetsAt !== "string") {
    return invalidResponse();
  }

  return {
    limitMicroCents: limit,
    spentMicroCents: spent,
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}

function sanitizeMessage(text: string, secrets: string[] = [], maxLength = 120): string {
  let sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return (sanitized || "unknown").slice(0, maxLength);
}

async function fetchConsoleRoute<T>(params: {
  route: ConsoleRoute;
  account: OpenCodeZenConsoleAccount;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  try {
    return await fetchWithTimeout(`${params.account.baseUrl}/api/${params.route}`, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${params.account.accessToken}`,
          "x-org-id": params.account.activeOrgId,
        },
      },
      timeoutMs: params.timeoutMs,
      consume: async (response): Promise<ConsoleRouteResult<T>> => {
        if (
          (response.status >= 300 && response.status < 400) ||
          response.status === 401 ||
          response.status === 403
        ) {
          return { success: false, error: SESSION_ERROR };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `OpenCode Console ${params.route} error ${response.status}`,
          };
        }
        if (response.headers.get("content-type")?.includes("text/html")) {
          return { success: false, error: SESSION_ERROR };
        }

        const text = await response.text();
        try {
          return { success: true, data: params.parse(JSON.parse(text)) };
        } catch {
          return {
            success: false,
            error: `Could not parse OpenCode Console ${params.route} response`,
          };
        }
      },
    });
  } catch (error) {
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error), [
      params.account.accessToken,
      params.account.activeOrgId,
    ]);
    return { success: false, error: `OpenCode Console ${params.route} request failed: ${message}` };
  }
}

export async function queryOpenCodeZenQuota(
  account: OpenCodeZenConsoleAccount,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const request = {
    account,
    timeoutMs: options.requestTimeoutMs ?? CONSOLE_TIMEOUT_MS,
  };
  const now = new Date();
  const [balance, creditLimit, autoRecharge, orgBudget, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchConsoleRoute({ ...request, route: "budgets/org", parse: parseOrgBudget }),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  const optional = [creditLimit, autoRecharge, orgBudget, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.success && result.error === SESSION_ERROR)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!balance.success) return balance;

  // Prefer the org budget when it supplies a positive limit and usable spend;
  // otherwise fall back to the credit limit plus this month's usage costs.
  const orgBudgetUsable = ((): boolean => {
    if (!orgBudget.success) return false;
    const { limitMicroCents, spentMicroCents } = orgBudget.data;
    return limitMicroCents !== null && limitMicroCents > 0 && spentMicroCents !== null;
  })();
  const orgBudgetData = orgBudget.success ? orgBudget.data : null;
  const monthlyLimit = orgBudgetUsable
    ? (orgBudgetData?.limitMicroCents ?? 0) / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR
    : creditLimit.success
      ? creditLimit.data
      : null;
  const usage = orgBudgetUsable
    ? (orgBudgetData?.spentMicroCents ?? null)
    : monthlyUsage.success
      ? monthlyUsage.data
      : null;

  return {
    success: true,
    data: {
      balance: balance.data,
      monthlyLimit,
      monthlyUsage: usage,
      lastPayment: null,
      ...(autoRecharge.success
        ? autoRecharge.data
        : { reload: null, reloadAmount: null, reloadTrigger: null }),
      budgetResetIso: orgBudgetUsable ? (orgBudgetData?.resetsAt ?? null) : null,
    },
    errors: optional.flatMap((result) => (result.success ? [] : [result.error])),
  };
}
