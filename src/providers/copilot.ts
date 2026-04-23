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
          ? [
              style === "grouped"
                ? {
                  kind: "value",
                  name: "Copilot",
                  group: getCopilotGroup(result.mode),
                  label: "Usage:",
                  value: formatManagedUsageValue(result),
                  resetTimeIso: result.resetTimeIso,
                }
                : {
                  kind: "value",
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
                },
            ]
          : [
              result.unlimited
                ? style === "grouped"
                  ? {
                      kind: "value",
                      name: "Copilot",
                      group: getCopilotGroup(result.mode),
                      label: "Quota:",
                      value: "Unlimited",
                      resetTimeIso: result.resetTimeIso,
                    }
                  : {
                      kind: "value",
                      name: "Copilot",
                      value: "Unlimited",
                      resetTimeIso: result.resetTimeIso,
                    }
                : style === "grouped"
                  ? {
                      name: "Copilot",
                      group: getCopilotGroup(result.mode),
                      label: "Quota:",
                      right: `${result.used}/${result.total}`,
                      percentRemaining: result.percentRemaining,
                      resetTimeIso: result.resetTimeIso,
                    }
                  : {
                      name: "Copilot",
                      percentRemaining: result.percentRemaining,
                      resetTimeIso: result.resetTimeIso,
                    },
            ],
      errors: [],
    };
  },
};
