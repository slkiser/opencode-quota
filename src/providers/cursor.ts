import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { clampPercent, fmtUsdAmount } from "../lib/format-utils.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import {
  getEffectiveCursorIncludedApiUsd,
  getCursorPlanDisplayName,
  isCursorModelId,
  isCursorProviderId,
} from "../lib/cursor-pricing.js";
import { inspectCursorOpenCodeIntegration } from "../lib/cursor-detection.js";
import { getCurrentCursorUsageSummary } from "../lib/cursor-usage.js";

function buildCursorGroup(plan: string | null): string {
  return plan ? `Cursor (${plan})` : "Cursor";
}

function buildCursorApiUsageValue(params: {
  costUsd: number;
  includedApiUsd: number;
  partial: boolean;
}): string {
  const value = `${fmtUsdAmount(params.costUsd)}/${fmtUsdAmount(params.includedApiUsd)} used`;
  return params.partial ? `${value} (partial)` : value;
}

export const cursorProvider: QuotaProvider = {
  id: "cursor",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const availableViaProviderConfig = await isCanonicalProviderAvailable({
      ctx,
      providerId: "cursor",
      fallbackOnError: false,
    });
    if (availableViaProviderConfig) return true;
    if (isCursorProviderId(ctx.config.currentProviderID)) return true;
    if (isCursorModelId(ctx.config.currentModel)) return true;

    const integration = await inspectCursorOpenCodeIntegration();
    return integration.pluginEnabled || integration.providerConfigured;
  },

  matchesCurrentModel(model: string): boolean {
    return isCursorModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const planLabel = getCursorPlanDisplayName(ctx.config.cursorPlan);
    const group = buildCursorGroup(planLabel);
    const includedApiUsd = getEffectiveCursorIncludedApiUsd({
      plan: ctx.config.cursorPlan,
      overrideUsd: ctx.config.cursorIncludedApiUsd,
    });
    const usage = await getCurrentCursorUsageSummary({
      billingCycleStartDay: ctx.config.cursorBillingCycleStartDay,
    });

    if (usage.total.messageCount === 0 && includedApiUsd === undefined) {
      return { attempted: false, entries: [], errors: [] };
    }

    const errors =
      usage.unknownModels.length > 0
        ? [{ label: "Cursor", message: "Unknown Cursor model ids present in local history (see /quota_status)" }]
        : [];
    const hasPartialApiCoverage = usage.unknownModels.length > 0;

    if ((ctx.config.formatStyle ?? "classic") === "grouped") {
      const entries: QuotaToastEntry[] = [];

      if (includedApiUsd !== undefined) {
        if (hasPartialApiCoverage) {
          entries.push({
            kind: "value",
            name: planLabel ? `Cursor API (${planLabel})` : "Cursor API",
            group,
            label: "API:",
            value: buildCursorApiUsageValue({
              costUsd: usage.api.costUsd,
              includedApiUsd,
              partial: true,
            }),
            resetTimeIso: usage.window.resetTimeIso,
          });
        } else {
          entries.push({
            name: planLabel ? `Cursor API (${planLabel})` : "Cursor API",
            group,
            label: "API:",
            right: `${fmtUsdAmount(usage.api.costUsd)}/${fmtUsdAmount(includedApiUsd)}`,
            percentRemaining: clampPercent(100 - (usage.api.costUsd / includedApiUsd) * 100),
            resetTimeIso: usage.window.resetTimeIso,
          });
        }
      } else {
        entries.push({
          kind: "value",
          name: "Cursor API",
          group,
          label: "API:",
          value: `${fmtUsdAmount(usage.api.costUsd)} used`,
          resetTimeIso: usage.window.resetTimeIso,
        });
      }

      if (usage.autoComposer.messageCount > 0 || includedApiUsd !== undefined) {
        entries.push({
          kind: "value",
          name: "Cursor Auto+Composer",
          group,
          label: "Auto+Composer:",
          value: `${fmtUsdAmount(usage.autoComposer.costUsd)} used`,
          resetTimeIso: usage.window.resetTimeIso,
        });
      }

      return { attempted: true, entries, errors };
    }

    if (includedApiUsd !== undefined) {
      return {
        attempted: true,
        entries: [
          hasPartialApiCoverage
            ? {
                kind: "value",
                name: planLabel ? `Cursor API (${planLabel})` : "Cursor API",
                value: buildCursorApiUsageValue({
                  costUsd: usage.api.costUsd,
                  includedApiUsd,
                  partial: true,
                }),
                resetTimeIso: usage.window.resetTimeIso,
              }
            : {
                name: planLabel ? `Cursor API (${planLabel})` : "Cursor API",
                percentRemaining: clampPercent(100 - (usage.api.costUsd / includedApiUsd) * 100),
                resetTimeIso: usage.window.resetTimeIso,
              },
        ],
        errors,
      };
    }

    return {
      attempted: true,
      entries: [
        {
          kind: "value",
          name: "Cursor",
          value: `${fmtUsdAmount(usage.total.costUsd)} used this cycle`,
          resetTimeIso: usage.window.resetTimeIso,
        },
      ],
      errors,
    };
  },
};
