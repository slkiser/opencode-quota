/**
 * Copilot provider wrapper.
 *
 * Normalizes Copilot quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryCopilotQuota } from "../lib/copilot.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  modelIncludesAny,
  modelProviderIncludesAny,
} from "../lib/provider-model-matching.js";
import type { CopilotEnterpriseUsageResult, CopilotOrganizationUsageResult } from "../lib/types.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

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
    // Check provider prefix (part before "/")
    if (modelProviderIncludesAny(model, ["copilot", "github"])) {
      return true;
    }
    // Also match if the full model string contains "copilot" or "github-copilot"
    // to handle models like "github-copilot/claude-sonnet-4.5"
    return modelIncludesAny(model, ["copilot", "github-copilot"]);
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryCopilotQuota();

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Copilot", result.error);
    }

    if (result.mode === "organization_usage" || result.mode === "enterprise_usage") {
      return attemptedResult(
        [
          {
            kind: "value",
            name: "Copilot",
            group: getCopilotGroup(result.mode),
            label: "Usage:",
            value: formatManagedUsageValue(result),
            resetTimeIso: result.resetTimeIso,
          },
        ],
        [],
        {
          singleWindowDisplayName:
            result.mode === "enterprise_usage"
              ? `Copilot Enterprise (${result.enterprise})`
              : `Copilot Org (${result.organization})`,
        },
      );
    }

    if (result.unlimited) {
      return attemptedResult(
        [
          {
            kind: "value",
            name: "Copilot",
            group: getCopilotGroup(result.mode),
            label: "Quota:",
            value: "Unlimited",
            resetTimeIso: result.resetTimeIso,
          },
        ],
        [],
      );
    }

    return attemptedResult(
      [
        {
          name: "Copilot",
          group: getCopilotGroup(result.mode),
          label: "Quota:",
          right: `${result.used}/${result.total}`,
          percentRemaining: result.percentRemaining,
          resetTimeIso: result.resetTimeIso,
        },
      ],
      [],
    );
  },
};
