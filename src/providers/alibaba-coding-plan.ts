import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaCodingPlanAuthDiagnostics,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { findQuotaProviderDefinition } from "../lib/quota-providers.js";
import {
  ALIBABA_CODING_PLAN_STATE_VERSION,
  computeAlibabaCodingPlanQuota,
  getAlibabaCodingPlanQuotaPath,
  readAlibabaCodingPlanQuotaState,
} from "../lib/qwen-local-quota.js";
import {
  attemptedErrorResult,
  attemptedResult,
  inspectGeneratedCounterFile,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

function tierLabel(tier: "lite" | "pro"): string {
  return tier === "pro" ? "Pro" : "Lite";
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: "lite",
    });
    return plan.state === "configured" || plan.state === "invalid";
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "alibaba-coding-plan" ||
          context.currentProviderID === "alibaba"
      : isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getAlibabaCodingPlanAuthDiagnostics({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: "lite",
    });
    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: "lite",
    });
    const statePath = getAlibabaCodingPlanQuotaPath();
    const state = await inspectGeneratedCounterFile(statePath, ALIBABA_CODING_PLAN_STATE_VERSION);
    const lastUpdate =
      state.lastUpdatedAt === null ? "(none)" : new Date(state.lastUpdatedAt).toISOString();
    const authError = diagnostics.state === "invalid" ? diagnostics.error : undefined;
    const statusDetails = statusDetailsFromRecord({
      "alibaba auth configured": diagnostics.state === "none" ? "false" : "true",
      alibaba_api_key_source: diagnostics.source ?? "(none)",
      alibaba_api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
      alibaba_api_key_credential_database_paths:
        diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
      alibaba_coding_plan:
        diagnostics.state === "configured"
          ? diagnostics.tier
          : diagnostics.state === "invalid"
            ? "invalid"
            : "(none)",
      alibaba_auth_error: authError,
      "alibaba coding plan error": authError,
      "alibaba coding plan local quota": `path=${statePath} exists=${state.exists ? "true" : "false"} health=${state.health} version=${state.version ?? "(none)"} last_update=${lastUpdate}`,
      local_state_path: statePath,
      local_state_exists: state.exists ? "true" : "false",
      local_state_health: state.health,
      local_state_version: String(state.version ?? "(none)"),
      local_state_last_update: lastUpdate,
    });
    if (plan.state === "none") {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (plan.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult("Alibaba Coding Plan", plan.error),
        statusDetails,
      );
    }

    const tuning = findQuotaProviderDefinition(
      ctx.config.quotaProviders ?? [],
      "alibaba-coding-plan",
    );
    const limits =
      tuning?.mode === "local-estimate"
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
    const label = `Alibaba Coding Plan (${tierLabel(plan.tier)})`;

    const entries: QuotaToastEntry[] = [
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "local_estimation",
          ownership: "maintained",
          authority: "locally_derived",
        },
        name: `${label} 5h`,
        group: label,
        label: "5h:",
        right: `${quota.fiveHour.used}/${quota.fiveHour.limit}`,
        percentRemaining: quota.fiveHour.percentRemaining,
        resetTimeIso: quota.fiveHour.resetTimeIso,
      },
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "local_estimation",
          ownership: "maintained",
          authority: "locally_derived",
        },
        name: `${label} Weekly`,
        group: label,
        label: "Weekly:",
        right: `${quota.weekly.used}/${quota.weekly.limit}`,
        percentRemaining: quota.weekly.percentRemaining,
        resetTimeIso: quota.weekly.resetTimeIso,
      },
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "local_estimation",
          ownership: "maintained",
          authority: "locally_derived",
        },
        name: `${label} Monthly`,
        group: label,
        label: "Monthly:",
        right: `${quota.monthly.used}/${quota.monthly.limit}`,
        percentRemaining: quota.monthly.percentRemaining,
        resetTimeIso: quota.monthly.resetTimeIso,
      },
    ];

    return withStatusDetails(attemptedResult(entries), statusDetails);
  },
};
