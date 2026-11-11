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
 * Where the monthly limit and usage come from: the budgets the Console reports for the
 * signed-in account (policies/current-budgets), or the credit limit (billing/account)
 * plus this month's usage costs (usage/cost-by-day).
 */
type OpenCodeZenBudgetSource = "member_budget" | "credit_limit";

/** The /quota_status note when the Console has budgets but none can be the monthly cap. */
export const MEMBER_BUDGET_NOTE =
  "member budgets found, but none can be used as the monthly cap (model filters, per-model limits, or missing amounts); using the credit limit";

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
   * Member-budget reset ISO timestamp: the start of the next UTC month, because Console
   * monthly budgets run per UTC calendar month. Null for the credit limit.
   */
  budgetResetIso: string | null;
  budgetSource: OpenCodeZenBudgetSource;
  /**
   * True when the Console reports budgets but none of them can be used as the monthly
   * cap (a model filter, a per-model limit, a missing amount). The credit-limit
   * fallback applies then.
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
  /** True when the Console reported at least one budget. */
  hasBudgets: boolean;
  /** When the selected budget resets, as an ISO instant; null when the Console gave none. */
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

/** An ISO instant, or null when the Console gave none that can be read. */
function parseIsoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The monthly cap that binds the account: the budget with the least USD left among the
 * caps that cover every model for the whole month.
 *
 * `policies/current-budgets` resolves the policies itself: every row is a budget that
 * applies now, with the amounts and the reset time already worked out. `coverage` says
 * whether the cap covers every model or only the ones it names, and `per` says whether the
 * limit is one for the whole set or one for each model.
 *
 * A cap that covers only some models, or that caps each model on its own, does not
 * bound the whole month's spend, so it does not compete for the limit; a $0 per-model
 * cap does block every model, so it counts. A cap whose amounts the Console left out
 * cannot be evaluated, and it could be the binding one, so then no budget is used.
 */
function selectMonthlyBudget(json: unknown): MemberBudget {
  if (!Array.isArray(json)) return invalidResponse();
  let selected: {
    limit: number;
    spent: number;
    remaining: number;
    resetsAtIso: string | null;
  } | null = null;
  let skipped = false;
  for (const item of json) {
    const budget = asRecord(item);
    if (!budget) return invalidResponse();
    const limit = parseBudgetDollars(budget.limitDollars);
    const spent = parseBudgetDollars(budget.spentDollars);
    if (budget.coverage !== "all") continue;
    if (budget.per !== "set" && limit !== 0) continue;
    if (limit === null || spent === null) {
      skipped = true;
      continue;
    }
    const remaining = limit - spent;
    if (selected === null || remaining < selected.remaining) {
      selected = { limit, spent, remaining, resetsAtIso: parseIsoInstant(budget.resetsAt) };
    }
  }

  if (skipped || selected === null) {
    return {
      limitMicroCents: null,
      spentMicroCents: null,
      hasBudgets: json.length > 0,
      resetsAtIso: null,
    };
  }
  return {
    limitMicroCents: toMicroCents(selected.limit),
    spentMicroCents: toMicroCents(selected.spent),
    hasBudgets: true,
    resetsAtIso: selected.resetsAtIso,
  };
}

/** 00:00 UTC on the 1st of the month after `now`. */
function nextUtcMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The token, the org id and the account id; none of them may show up in error text.
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
  /** The route after `/api/`; it names the route in error text too. */
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

/** The budgets the Console reports as current for the signed-in account. */
async function fetchCurrentBudgets(request: {
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
}): Promise<ConsoleRouteResult<MemberBudget>> {
  return fetchConsoleRoute({
    ...request,
    route: "policies/current-budgets",
    parse: selectMonthlyBudget,
  });
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
  const [balance, creditLimit, autoRecharge, budgets, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchCurrentBudgets(request),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  const optional = [creditLimit, autoRecharge, budgets, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.success && result.error === SESSION_ERROR)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!balance.success) return balance;

  // Prefer a member budget ($0 included: it blocks). Otherwise (no member budgets, budgets
  // that cannot all be evaluated, or a failed member route) fall back to the credit limit
  // plus this month's usage costs.
  let monthlyLimit = creditLimit.success ? creditLimit.data : null;
  let usage = monthlyUsage.success ? monthlyUsage.data : null;
  let budgetResetIso: string | null = null;
  let budgetSource: OpenCodeZenBudgetSource = "credit_limit";
  let memberBudgetsSkipped = false;
  if (budgets.success) {
    const { limitMicroCents, spentMicroCents, hasBudgets, resetsAtIso } = budgets.data;
    if (limitMicroCents !== null && spentMicroCents !== null) {
      monthlyLimit = limitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
      usage = spentMicroCents;
      budgetResetIso = resetsAtIso ?? nextUtcMonthStartIso(now);
      budgetSource = "member_budget";
    } else if (hasBudgets) {
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
