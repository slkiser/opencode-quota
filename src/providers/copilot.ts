/**
 * Copilot provider wrapper.
 *
 * Normalizes Copilot quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryCopilotQuota } from "../lib/copilot.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import type { CopilotEnterpriseUsageResult, CopilotOrganizationUsageResult } from "../lib/types.js";
import { notAttemptedResult } from "./result-helpers.js";

function formatBillingPeriod(period: { year: number; month: number }): string {
  return `${period.year}-${String(period.month).padStart(2, "0")}`;
}

function getCopilotGroup(mode: "user_quota" | "organization_usage" | "enterprise_usage"): string {
  return mode === "user_quota" ? "Copilot (personal)" : "Copilot (business)";
}

function formatManagedUsageValue(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult,
): string {
  const parts = [`${result.used} used`, formatBillingPeriod(result.period)];

  if (result.mode === "organization_usage") {
    parts.push(`org=${result.organization}`);
  } else {
    parts.push(`enterprise=${result.enterprise}`);
    if (result.organization) parts.push(`org=${result.organization}`);
  }

  if (result.username) parts.push(`user=${result.username}`);
  return parts.join(" | ");
}

function buildManagedUsageEntry(
  result: CopilotOrganizationUsageResult | CopilotEnterpriseUsageResult,
  style: "classic" | "grouped",
) {
  if (style === "grouped") {
    return {
      kind: "value" as const,
      name: "Copilot",
      group: getCopilotGroup(result.mode),
      label: "Usage:",
      value: formatManagedUsageValue(result),
      resetTimeIso: result.resetTimeIso,
    };
  }

  return {
    kind: "value" as const,
    name:
      result.mode === "enterprise_usage"
        ? `Copilot Enterprise (${result.enterprise})`
        : `Copilot Org (${result.organization})`,
    value:
      result.mode === "enterprise_usage"
        ? [
            `${result.used} used`,
            formatBillingPeriod(result.period),
            ...(result.organization ? [`org=${result.organization}`] : []),
            ...(result.username ? [`user=${result.username}`] : []),
          ].join(" | ")
        : [
            `${result.used} used`,
            formatBillingPeriod(result.period),
            ...(result.username ? [`user=${result.username}`] : []),
          ].join(" | "),
    resetTimeIso: result.resetTimeIso,
  };
}

function buildUserQuotaEntry(
  result: Extract<Awaited<ReturnType<typeof queryCopilotQuota>>, { success: true; mode: "user_quota" }>,
  style: "classic" | "grouped",
) {
  if (result.unlimited) {
    if (style === "grouped") {
      return {
        kind: "value" as const,
        name: "Copilot",
        group: getCopilotGroup(result.mode),
        label: "Quota:",
        value: "Unlimited",
        resetTimeIso: result.resetTimeIso,
      };
    }

    return {
      kind: "value" as const,
      name: "Copilot",
      value: "Unlimited",
      resetTimeIso: result.resetTimeIso,
    };
  }

  if (style === "grouped") {
    return {
      name: "Copilot",
      group: getCopilotGroup(result.mode),
      label: "Quota:",
      right: `${result.used}/${result.total}`,
      percentRemaining: result.percentRemaining,
      resetTimeIso: result.resetTimeIso,
    };
  }

  return {
    name: "Copilot",
    percentRemaining: result.percentRemaining,
    resetTimeIso: result.resetTimeIso,
  };
}

export const copilotProvider: QuotaProvider = {
  id: "copilot",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return isCanonicalProviderAvailable({
      ctx,
      providerId: "copilot",
      fallbackOnError: false,
    });
  },

  matchesCurrentModel(model: string): boolean {
    const lower = model.toLowerCase();
    // Check provider prefix (part before "/")
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("copilot") || provider.includes("github"))) {
      return true;
    }
    // Also match if the full model string contains "copilot" or "github-copilot"
    // to handle models like "github-copilot/claude-sonnet-4.5"
    return lower.includes("copilot") || lower.includes("github-copilot");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryCopilotQuota();
    const style = _ctx.config?.formatStyle ?? "classic";

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Copilot", message: result.error }],
      };
    }

    return {
      attempted: true,
      entries:
        result.mode === "organization_usage" || result.mode === "enterprise_usage"
          ? [buildManagedUsageEntry(result, style)]
          : [buildUserQuotaEntry(result, style)],
      errors: [],
    };
  },
};
