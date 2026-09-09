import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  getAlibabaCodingPlanAuthDiagnostics,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import {
  type AlibabaCliDiagnostics,
  type AlibabaCliWindow,
  probeAlibabaCliUsage,
} from "../lib/alibaba-cli.js";
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

const ALIBABA_TOKEN_PLAN_GROUP = "Alibaba Token Plan";

function tierLabel(tier: "lite" | "pro"): string {
  return tier === "pro" ? "Pro" : "Lite";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function tokenPlanWindowEntry(window: AlibabaCliWindow, suffix: "5h" | "Weekly"): QuotaToastEntry {
  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "local_cli",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: `${ALIBABA_TOKEN_PLAN_GROUP} ${suffix}`,
    group: ALIBABA_TOKEN_PLAN_GROUP,
    label: `${suffix}:`,
    percentRemaining: clampPercent((1 - window.percentUsed) * 100),
    resetTimeIso:
      window.resetTimeMs !== undefined ? new Date(window.resetTimeMs).toISOString() : undefined,
  };
}

async function safeProbeAlibabaCli(ctx: QuotaProviderContext): Promise<AlibabaCliDiagnostics> {
  try {
    return await probeAlibabaCliUsage({
      binaryPath: ctx.config.alibabaBinaryPath,
      consoleRegion: ctx.config.alibabaConsoleRegion,
      consoleSite: ctx.config.alibabaConsoleSite,
    });
  } catch {
    return {
      installed: false,
      checkedCommands: [],
      failureReason: "error",
      message: "Could not run Alibaba Cloud CLI.",
    };
  }
}

function cliStatusDetails(cli: AlibabaCliDiagnostics): Record<string, string | undefined> {
  return {
    alibaba_cli_installed: cli.installed ? "true" : "false",
    alibaba_cli_version: cli.version,
    alibaba_cli_authenticated:
      cli.authenticated === undefined ? undefined : cli.authenticated ? "true" : "false",
    alibaba_console_region: cli.consoleRegion ?? "(cli default)",
    alibaba_console_site: cli.consoleSite ?? "(cli default)",
    alibaba_cli_checked_commands: cli.checkedCommands.join(" | ") || "(none)",
    alibaba_cli_message: cli.message,
  };
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const cli = await safeProbeAlibabaCli(ctx);
    if (cli.installed && cli.authenticated === true) return true;

    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: "lite",
    });
    if (plan.state === "configured" || plan.state === "invalid") {
      return true;
    }

    return false;
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "alibaba-coding-plan" ||
          context.currentProviderID === "alibaba-token-plan" ||
          context.currentProviderID === "alibaba"
      : model.toLowerCase().startsWith("alibaba-token-plan/") || isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const cli = await safeProbeAlibabaCli(ctx);
    const cliWindows = cli.usage;
    if (cliWindows && (cliWindows.per5Hour || cliWindows.per1Week)) {
      const entries: QuotaToastEntry[] = [];
      if (cliWindows.per5Hour) {
        entries.push(tokenPlanWindowEntry(cliWindows.per5Hour, "5h"));
      }
      if (cliWindows.per1Week) {
        entries.push(tokenPlanWindowEntry(cliWindows.per1Week, "Weekly"));
      }
      return withStatusDetails(
        attemptedResult(entries),
        statusDetailsFromRecord({
          ...cliStatusDetails(cli),
          alibaba_quota_source: "alibaba-cli",
        }),
      );
    }

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
    const details: Record<string, string | undefined> = {
      "alibaba auth configured": diagnostics.state === "none" ? "false" : "true",
      alibaba_api_key_source: diagnostics.source ?? "(none)",
      alibaba_api_key_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
      alibaba_api_key_auth_paths: diagnostics.authPaths.join(" | ") || "(none)",
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
      ...cliStatusDetails(cli),
    };

    details["alibaba_quota_source"] = plan.state === "none" ? "(none)" : "local-estimate";
    const statusDetails = statusDetailsFromRecord(details);

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
