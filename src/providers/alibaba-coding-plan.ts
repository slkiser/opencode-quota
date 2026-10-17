/**
 * Alibaba Coding Plan: a local estimate of the 5h, weekly and monthly request windows, counted
 * from this machine's requests against the plan tier's limits (or the configured ones).
 */

import type { Amount } from "../core/types.js";
import {
  getAlibabaCodingPlanAuthDiagnostics,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import {
  countRequestWindows,
  type ReadCompletedMessages,
  type WindowCount,
} from "../lib/quota-providers-local.js";
import { findQuotaProviderDefinition, type LocalEstimateWindow } from "../lib/quota-providers.js";
import type { AlibabaCodingPlanTier } from "../lib/types.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import {
  FIVE_HOUR,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  WEEKLY,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Alibaba Coding Plan";

/** OpenCode's provider ids for Alibaba models; requests to either count against the plan. */
const ALIBABA_PROVIDER_IDS = ["alibaba-coding-plan", "alibaba"];

type PlanLimits = { fiveHour: number; weekly: number; monthly: number };

const PLAN_LIMITS: Readonly<Record<AlibabaCodingPlanTier, PlanLimits>> = {
  lite: { fiveHour: 1200, weekly: 9000, monthly: 18000 },
  pro: { fiveHour: 6000, weekly: 45000, monthly: 90000 },
};

/**
 * The plan as a built-in local estimate: rolling 5-hour, 7-day and 30-day request windows,
 * in the order and with the ids a tuning in settings must use.
 */
function planWindows(limits: PlanLimits): LocalEstimateWindow[] {
  return [
    {
      id: "five-hour",
      label: "5h",
      type: "rolling",
      durationMinutes: 300,
      requestLimit: limits.fiveHour,
    },
    {
      id: "weekly",
      label: "Weekly",
      type: "rolling",
      durationMinutes: 10_080,
      requestLimit: limits.weekly,
    },
    {
      id: "monthly",
      label: "Monthly",
      type: "rolling",
      durationMinutes: 43_200,
      requestLimit: limits.monthly,
    },
  ];
}

/** The limits a switched-on tuning in settings sets, else the tier's own. */
function planLimits(ctx: QuotaProviderContext, tier: AlibabaCodingPlanTier): PlanLimits {
  const tuning = findQuotaProviderDefinition(
    ctx.config.quotaProviders ?? [],
    "alibaba-coding-plan",
  );
  if (tuning?.mode !== "local-estimate" || tuning.enabled === false) return PLAN_LIMITS[tier];
  const limit = (id: string) => tuning.windows.find((window) => window.id === id)!.requestLimit;
  return { fiveHour: limit("five-hour"), weekly: limit("weekly"), monthly: limit("monthly") };
}

/** A whole request count as an amount; none for anything else. */
function requests(count: number): Amount | undefined {
  return Number.isSafeInteger(count) && count >= 0
    ? { decimal: String(count), unit: { kind: "count", unit: "request" } }
    : undefined;
}

function estimateRow(
  slot: typeof FIVE_HOUR | typeof WEEKLY | typeof MONTHLY,
  { window, requests: counted, resetsAt }: WindowCount,
): ProviderRow {
  const used = requests(counted.length);
  const limit = requests(window.requestLimit);
  return {
    ...slot,
    type: "quota",
    method: "local_estimation",
    authority: "locally_derived",
    prominence: "primary",
    percentRemaining: clampPercent(
      ((window.requestLimit - counted.length) / window.requestLimit) * 100,
    ),
    ...(resetsAt ? { resetsAt } : {}),
    ...(used && limit ? { used, limit } : {}),
  };
}

/** The plan's three windows as rows, counted from this machine's requests. */
export async function alibabaCodingPlanRows(params: {
  limits: PlanLimits;
  nowMs?: number;
  readMessages?: ReadCompletedMessages;
}): Promise<ProviderRow[]> {
  const [fiveHour, weekly, monthly] = await countRequestWindows({
    providerIds: ALIBABA_PROVIDER_IDS,
    windows: planWindows(params.limits),
    nowMs: params.nowMs ?? Date.now(),
    readMessages: params.readMessages,
  });
  return [
    estimateRow(FIVE_HOUR, fiveHour!),
    estimateRow(WEEKLY, weekly!),
    estimateRow(MONTHLY, monthly!),
  ];
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",
  cachePolicy: resolvedCredentialPolicy("alibaba-coding-plan", async () => {
    const resolved = await resolveAlibabaCodingPlanAuthCached();
    return resolved.state === "configured"
      ? { credential: resolved.apiKey, qualifiers: [resolved.tier] }
      : null;
  }),

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const plan = await resolveAlibabaCodingPlanAuthCached();
    return plan.state === "configured" || plan.state === "invalid";
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "alibaba-coding-plan" ||
          context.currentProviderID === "alibaba"
      : isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const plan = await getAlibabaCodingPlanAuthDiagnostics();
    const authError = plan.state === "invalid" ? plan.error : undefined;
    const debug = statusDetailsFromRecord({
      "alibaba auth configured": plan.state === "none" ? "false" : "true",
      alibaba_api_key_source: plan.source ?? "(none)",
      alibaba_api_key_checked_paths: plan.checkedPaths.join(" | ") || "(none)",
      alibaba_api_key_credential_database_paths:
        plan.credentialDatabasePaths.join(" | ") || "(none)",
      alibaba_coding_plan:
        plan.state === "configured" ? plan.tier : plan.state === "invalid" ? "invalid" : "(none)",
      alibaba_auth_error: authError,
      "alibaba coding plan error": authError,
    });
    if (plan.state === "none") return { attempted: false, accounts: [], debug };
    if (plan.state === "invalid") {
      return { attempted: true, accounts: [failedAccount(LABEL, plan.error)], debug };
    }

    const rows = await alibabaCodingPlanRows({ limits: planLimits(ctx, plan.tier) });
    const tier = plan.tier === "pro" ? "Pro" : "Lite";
    return { attempted: true, accounts: [{ name: `${LABEL} (${tier})`, rows, errors: [] }], debug };
  },
};
