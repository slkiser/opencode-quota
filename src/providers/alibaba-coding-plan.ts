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
import {
  ALIBABA_CODING_PLAN_STATE_VERSION,
  type AlibabaCodingPlanComputedQuota,
  computeAlibabaCodingPlanQuota,
  getAlibabaCodingPlanQuotaPath,
  readAlibabaCodingPlanQuotaState,
} from "../lib/alibaba-coding-plan-local-quota.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { findQuotaProviderDefinition } from "../lib/quota-providers.js";
import { resolvedCredentialPolicy } from "./cache-policies.js";
import {
  FIVE_HOUR,
  failedAccount,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  WEEKLY,
} from "./contract.js";
import { inspectGeneratedCounterFile, statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "Alibaba Coding Plan";

type EstimatedWindow = AlibabaCodingPlanComputedQuota["fiveHour"];

/** A whole request count as an amount; none for anything else. */
function requests(count: number): Amount | undefined {
  return Number.isSafeInteger(count) && count >= 0
    ? { decimal: String(count), unit: { kind: "count", unit: "request" } }
    : undefined;
}

function estimateRow(
  slot: typeof FIVE_HOUR | typeof WEEKLY | typeof MONTHLY,
  window: EstimatedWindow,
): ProviderRow {
  const used = requests(window.used);
  const limit = requests(window.limit);
  return {
    ...slot,
    type: "quota",
    method: "local_estimation",
    authority: "locally_derived",
    prominence: "primary",
    percentRemaining: window.percentRemaining,
    ...(window.resetTimeIso ? { resetsAt: window.resetTimeIso } : {}),
    ...(used && limit ? { used, limit } : {}),
  };
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
    const statePath = getAlibabaCodingPlanQuotaPath();
    const state = await inspectGeneratedCounterFile(statePath, ALIBABA_CODING_PLAN_STATE_VERSION);
    const lastUpdate =
      state.lastUpdatedAt === null ? "(none)" : new Date(state.lastUpdatedAt).toISOString();
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
      "alibaba coding plan local quota": `path=${statePath} exists=${state.exists ? "true" : "false"} health=${state.health} version=${state.version ?? "(none)"} last_update=${lastUpdate}`,
      local_state_path: statePath,
      local_state_exists: state.exists ? "true" : "false",
      local_state_health: state.health,
      local_state_version: String(state.version ?? "(none)"),
      local_state_last_update: lastUpdate,
    });
    if (plan.state === "none") return { attempted: false, accounts: [], debug };
    if (plan.state === "invalid") {
      return { attempted: true, accounts: [failedAccount(LABEL, plan.error)], debug };
    }

    const tuning = findQuotaProviderDefinition(
      ctx.config.quotaProviders ?? [],
      "alibaba-coding-plan",
    );
    // A switched-off tuning is not applied; the tier's own limits count.
    const limits =
      tuning?.mode === "local-estimate" && tuning.enabled !== false
        ? {
            fiveHour: tuning.windows.find((window) => window.id === "five-hour")!.requestLimit,
            weekly: tuning.windows.find((window) => window.id === "weekly")!.requestLimit,
            monthly: tuning.windows.find((window) => window.id === "monthly")!.requestLimit,
          }
        : undefined;
    const quota = computeAlibabaCodingPlanQuota({
      state: await readAlibabaCodingPlanQuotaState(),
      tier: plan.tier,
      ...(limits ? { limits } : {}),
    });
    const rows = [
      estimateRow(FIVE_HOUR, quota.fiveHour),
      estimateRow(WEEKLY, quota.weekly),
      estimateRow(MONTHLY, quota.monthly),
    ];
    const tier = plan.tier === "pro" ? "Pro" : "Lite";
    return { attempted: true, accounts: [{ name: `${LABEL} (${tier})`, rows, errors: [] }], debug };
  },
};
