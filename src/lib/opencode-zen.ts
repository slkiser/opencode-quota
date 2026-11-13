import type { ErrorFacts } from "../core/errors.js";
import { failureFacts, requestJson } from "./http.js";
import { asRecord } from "./json-guards.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  type OpenCodeConsoleCredential,
} from "./opencode-console-auth.js";

const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";

/**
 * The OpenCode Console reports amounts in micro-cents:
 * one US dollar is 100,000,000 micro-cents (billing units).
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

/**
 * Where the monthly limit and usage come from: a member budget
 * (policies/current-budgets), or the credit limit (billing/account) plus this
 * month's usage costs (usage/cost-by-day).
 */
type OpenCodeZenBudgetSource = "member_budget" | "credit_limit";

/** The /quota_status note when the member has budgets Zen cannot all evaluate. */
export const MEMBER_BUDGET_NOTE =
  "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit";

interface OpenCodeZenBillingData {
  balance: number;
  /**
   * Monthly limit in USD from `budgetSource`: null when there is no limit or its route
   * failed. A member budget of $0 is a real blocking limit, not an absence.
   */
  monthlyLimit: number | null;
  /** Current-month usage in billing units from `budgetSource`; null when its route failed. */
  monthlyUsage: number | null;
  lastPayment: number | null;
  /** Auto-reload state; null (unknown) when billing/auto-recharge failed. */
  reload: boolean | null;
  reloadAmount: number | null;
  reloadTrigger: number | null;
  /**
   * Member-budget reset ISO timestamp from the Console, else the start of the next UTC
   * month. Null for the credit limit.
   */
  budgetResetIso: string | null;
  budgetSource: OpenCodeZenBudgetSource;
  /**
   * True when the member has budgets but none can be used, or an applicable budget has
   * missing amounts. The credit-limit fallback applies.
   */
  memberBudgetsSkipped: boolean;
}

/**
 * billing/status (balance) is required. The other routes are optional: when one fails,
 * its fields are null and its error is listed in `errors`.
 */
type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData; errors: string[] }
  | { success: false; error: string; facts?: ErrorFacts };

type ConsoleRoute =
  | "billing/status"
  | "billing/account"
  | "billing/auto-recharge"
  | "policies/current-budgets"
  | "usage/cost-by-day";

type ConsoleRouteResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; facts?: ErrorFacts };

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

/** A nullable micro-cent field: null stays null; a missing or malformed value is invalid. */
function parseNullableMicroCents(value: unknown): number | null {
  if (value === null) return null;
  const parsed = parseMicroCents(value);
  return parsed === null ? invalidResponse() : parsed;
}

function parseBalance(json: unknown): number {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  return balance === null ? invalidResponse() : Math.max(0, balance);
}

/** Returns the credit limit in USD, or null when the account has no limit. */
function parseCreditLimit(json: unknown): number | null {
  const limit = parseNullableMicroCents(asRecord(json)?.creditLimitMicroCents);
  return limit === null ? null : limit / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
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

/** The selected member budget in billing units; both null when none is used. */
type MemberBudget = {
  limitMicroCents: number | null;
  spentMicroCents: number | null;
  /** Budget candidates seen; 0 for a member with no budgets. */
  budgetCount: number;
  /** The selected cap's reset, or null when absent or unreadable. */
  resetsAtIso: string | null;
};

/** Caps dollar amounts so the ×100,000,000 conversion cannot lose Number precision. */
const MAX_BUDGET_DOLLARS = 90_000_000;

/** A member budget dollar field: absent or null, else a non-negative finite number. */
function parseBudgetDollars(value: unknown): number | null {
  if (value === undefined) return null;
  const dollars = parseDollars(value);
  if (dollars === null) return null;
  if (dollars < 0 || dollars > MAX_BUDGET_DOLLARS) return invalidResponse();
  return dollars;
}

function toMicroCents(dollars: number): number {
  return Math.round(dollars * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR);
}

/**
 * Current budgets already have their policies resolved by the Console. Select the least
 * USD left among whole-set caps covering all models; a $0 per-model cap also blocks all
 * models. Filtered and nonzero per-model caps do not compete. Missing amounts on an
 * applicable cap make the binding budget unknown, so the credit-limit fallback applies.
 */
function parseMemberBudgets(json: unknown): MemberBudget {
  if (!Array.isArray(json)) return invalidResponse();

  let selected: { limit: number; spent: number; resetsAtIso: string | null } | null = null;
  let skipped = false;
  for (const item of json) {
    const budget = asRecord(item);
    if (!budget) return invalidResponse();
    const { per } = budget;
    if (per !== "set" && per !== "model") return invalidResponse();
    const limit = parseBudgetDollars(budget.limitDollars);
    const spent = parseBudgetDollars(budget.spentDollars);
    if (budget.coverage !== "all" || (per === "model" && limit !== 0)) continue;
    if (limit === null || spent === null) {
      skipped = true;
      continue;
    }
    if (selected === null || limit - spent < selected.limit - selected.spent) {
      const resetMs = typeof budget.resetsAt === "string" ? Date.parse(budget.resetsAt) : NaN;
      selected = {
        limit,
        spent,
        resetsAtIso: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
      };
    }
  }

  if (skipped || selected === null) {
    return {
      limitMicroCents: null,
      spentMicroCents: null,
      budgetCount: json.length,
      resetsAtIso: null,
    };
  }
  return {
    limitMicroCents: toMicroCents(selected.limit),
    spentMicroCents: toMicroCents(selected.spent),
    budgetCount: json.length,
    resetsAtIso: selected.resetsAtIso,
  };
}

/** 00:00 UTC on the 1st of the month after `now`. */
function nextUtcMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The token, org id and account id are kept out of error text in raw and encoded forms.
 */
function consoleSecrets(credential: OpenCodeConsoleCredential): Array<string | undefined> {
  const accountId = credential.accountId?.trim();
  return [
    credential.accessToken,
    credential.orgId,
    accountId,
    accountId && encodeURIComponent(accountId),
  ];
}

async function fetchConsoleRoute<T>(params: {
  /** The URL path after `/api/`, also used in error text. */
  route: ConsoleRoute;
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  const reply = await requestJson(`${consoleBaseUrl(params.credential)}/api/${params.route}`, {
    method: "GET",
    redirect: "manual",
    headers: consoleHeaders(params.credential),
    secrets: consoleSecrets(params.credential),
    timeoutMs: params.timeoutMs,
    // An empty body carries no value, so the route parser sees it as JSON null.
    blankAsNull: true,
  });
  const status = reply.ok ? reply.status : reply.failure.status;
  const headers = reply.ok ? reply.headers : reply.failure.headers;
  // Redirects and 401 mean the whole session is gone; a 403 is treated as
  // a per-route failure so optional routes can fall back gracefully.
  if (status !== undefined && ((status >= 300 && status < 400) || status === 401)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!reply.ok && reply.failure.kind === "http") {
    return {
      success: false,
      error: `OpenCode Console ${params.route} error ${status}`,
      facts: failureFacts(reply.failure),
    };
  }
  if (headers?.get("content-type")?.includes("text/html")) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!reply.ok && (reply.failure.kind === "timeout" || reply.failure.kind === "network")) {
    const detail = reply.failure.detail.replace(/\s+/g, " ").trim();
    return {
      success: false,
      error: `OpenCode Console ${params.route} request failed: ${(detail || "unknown").slice(0, 120)}`,
      facts: failureFacts(reply.failure),
    };
  }
  const notParsed = {
    success: false as const,
    error: `Could not parse OpenCode Console ${params.route} response`,
  };
  if (!reply.ok) return notParsed;
  try {
    return { success: true, data: params.parse(reply.json) };
  } catch {
    return notParsed;
  }
}

export async function queryOpenCodeZenQuota(
  credential: OpenCodeConsoleCredential,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const request = {
    credential,
    timeoutMs: options.requestTimeoutMs ?? CONSOLE_TIMEOUT_MS,
  };
  const now = new Date();
  const [balance, creditLimit, autoRecharge, member, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchConsoleRoute({ ...request, route: "policies/current-budgets", parse: parseMemberBudgets }),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  const optional = [creditLimit, autoRecharge, member, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.success && result.error === SESSION_ERROR)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!balance.success) return balance;

  // Prefer a member budget ($0 included: it blocks). Otherwise (no member budgets, budgets
  // that cannot be evaluated, or a failed budget route) fall back to the credit limit
  // plus this month's usage costs.
  let monthlyLimit = creditLimit.success ? creditLimit.data : null;
  let usage = monthlyUsage.success ? monthlyUsage.data : null;
  let budgetResetIso: string | null = null;
  let budgetSource: OpenCodeZenBudgetSource = "credit_limit";
  let memberBudgetsSkipped = false;
  if (member.success) {
    const { limitMicroCents, spentMicroCents, budgetCount, resetsAtIso } = member.data;
    if (limitMicroCents !== null && spentMicroCents !== null) {
      monthlyLimit = limitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
      usage = spentMicroCents;
      budgetResetIso = resetsAtIso ?? nextUtcMonthStartIso(now);
      budgetSource = "member_budget";
    } else if (budgetCount > 0) {
      memberBudgetsSkipped = true;
    }
  }

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
      budgetResetIso,
      budgetSource,
      memberBudgetsSkipped,
    },
    errors: optional.flatMap((result) => (result.success ? [] : [result.error])),
  };
}
