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
 * (policies/members/{account id}), or the credit limit (billing/account) plus this
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
   * Member-budget reset ISO timestamp: the start of the next UTC month, because Console
   * monthly budgets run per UTC calendar month. Null for the credit limit.
   */
  budgetResetIso: string | null;
  budgetSource: OpenCodeZenBudgetSource;
  /**
   * True when the member has budgets but not all of them can be safely evaluated (model
   * filter, per-model limit, unmatched rule, missing amount). No member budget is used
   * then, and the credit-limit fallback applies.
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
  | "policies/members"
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
 * True only for no selector, or a selector made only of known Console keys that does not
 * restrict models: `models`/`vendors` must be string arrays (empty = no filter),
 * `inputPriceAtLeast` filters as soon as it is present, and `includeUnknownPrice` alone
 * does not. Anything else (null, wrong types, unknown keys) counts as a filter.
 */
function ruleSelectorUnfiltered(selector: unknown): boolean {
  if (selector === undefined) return true;
  const spec = asRecord(selector);
  if (!spec) return false;
  const known = new Set(["models", "vendors", "inputPriceAtLeast", "includeUnknownPrice"]);
  if (Object.keys(spec).some((key) => !known.has(key))) return false;
  for (const key of ["models", "vendors"] as const) {
    const filter = spec[key];
    if (filter === undefined) continue;
    if (!Array.isArray(filter) || filter.some((entry) => typeof entry !== "string")) return false;
    if (filter.length > 0) return false;
  }
  if (spec.inputPriceAtLeast !== undefined) return false;
  return spec.includeUnknownPrice === undefined || typeof spec.includeUnknownPrice === "boolean";
}

/**
 * The binding monthly budget from the member detail that `policies/members/{account id}`
 * returns for the signed-in account: the smallest remaining USD among the budgets that
 * provably apply. The reply must name the same account.
 *
 * A budget counts only when its `policyID` matches a policy and its `ruleID` matches a
 * `kind: "budget"`, `period: "month"` rule in it with the same `scope` (`each` per member,
 * `combined` shared over the rule's audience) and `per` (default `set`), whose selector
 * does not restrict models. A `per: "model"` budget has no per-model spend here, so only a
 * $0 limit counts (it blocks every model). One budget that cannot be evaluated could be
 * the binding one, so then none is used; `budgetCount` still tells a member without
 * budgets from one with budgets Zen cannot evaluate.
 */
function parseMemberBudgets(json: unknown, accountId: string): MemberBudget {
  const member = asRecord(json);
  if (!member || member.userID !== accountId) return invalidResponse();
  if (!Array.isArray(member.budgets) || !Array.isArray(member.policies)) {
    return invalidResponse();
  }

  let selected: { limit: number; spent: number } | null = null;
  let skipped = false;
  let budgetCount = 0;
  for (const item of member.budgets) {
    const budget = asRecord(item);
    if (!budget) return invalidResponse();
    const { policyID, ruleID, scope } = budget;
    if (typeof policyID !== "string" || typeof ruleID !== "string") return invalidResponse();
    if (scope !== "each" && scope !== "combined") return invalidResponse();
    const per = budget.per ?? "set";
    if (per !== "set" && per !== "model") return invalidResponse();
    budgetCount += 1;

    const limit = parseBudgetDollars(budget.limitDollars);
    const spent = parseBudgetDollars(budget.spentDollars);
    if (limit === null || spent === null) {
      skipped = true;
      continue;
    }

    const policy = member.policies.map(asRecord).find((candidate) => candidate?.id === policyID);
    const rule = Array.isArray(policy?.rules)
      ? policy.rules.map(asRecord).find((candidate) => candidate?.id === ruleID)
      : undefined;
    const applies =
      rule?.kind === "budget" &&
      rule.period === "month" &&
      rule.scope === scope &&
      (rule.per ?? "set") === per &&
      ruleSelectorUnfiltered(rule.selector) &&
      (per === "set" || limit === 0);
    if (!applies) {
      skipped = true;
      continue;
    }

    if (selected === null || limit - spent < selected.limit - selected.spent) {
      selected = { limit, spent };
    }
  }

  if (skipped || selected === null) {
    return { limitMicroCents: null, spentMicroCents: null, budgetCount };
  }
  return {
    limitMicroCents: toMicroCents(selected.limit),
    spentMicroCents: toMicroCents(selected.spent),
    budgetCount,
  };
}

/** 00:00 UTC on the 1st of the month after `now`. */
function nextUtcMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * The token, org id and account id. The member route puts the trimmed, URL-encoded account id
 * in its path, so both forms are secrets.
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
  /** Names the route in error text. */
  route: ConsoleRoute;
  /** The URL path after `/api/` when it adds an id to `route`; the id stays out of error text. */
  path?: string;
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  const path = params.path ?? params.route;
  const reply = await requestJson(`${consoleBaseUrl(params.credential)}/api/${path}`, {
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

/** The signed-in account's member budgets; a sign-in without an account id has none to ask for. */
async function fetchMemberBudget(request: {
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
}): Promise<ConsoleRouteResult<MemberBudget>> {
  const accountId = request.credential.accountId?.trim();
  if (!accountId) {
    return {
      success: false,
      error: "OpenCode Console member budgets unavailable: the Console sign-in has no account id",
    };
  }
  return fetchConsoleRoute({
    ...request,
    route: "policies/members",
    path: `policies/members/${encodeURIComponent(accountId)}`,
    parse: (json) => parseMemberBudgets(json, accountId),
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
  const [balance, creditLimit, autoRecharge, member, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchMemberBudget(request),
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
  // that cannot all be evaluated, or a failed member route) fall back to the credit limit
  // plus this month's usage costs.
  let monthlyLimit = creditLimit.success ? creditLimit.data : null;
  let usage = monthlyUsage.success ? monthlyUsage.data : null;
  let budgetResetIso: string | null = null;
  let budgetSource: OpenCodeZenBudgetSource = "credit_limit";
  let memberBudgetsSkipped = false;
  if (member.success) {
    const { limitMicroCents, spentMicroCents, budgetCount } = member.data;
    if (limitMicroCents !== null && spentMicroCents !== null) {
      monthlyLimit = limitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
      usage = spentMicroCents;
      budgetResetIso = nextUtcMonthStartIso(now);
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
