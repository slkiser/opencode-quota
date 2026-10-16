import type { Amount } from "../core/types.js";
import {
  CURSOR_CANONICAL_PLUGIN_PACKAGE,
  inspectCursorAuthPresence,
  inspectCursorOpenCodeIntegration,
} from "../lib/cursor-detection.js";
import {
  getCursorPlanDisplayName,
  getEffectiveCursorIncludedApiUsd,
  isCursorModelId,
  isCursorProviderId,
} from "../lib/cursor-pricing.js";
import { getCurrentCursorUsageSummary } from "../lib/cursor-usage.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { accountingDecimalFromNumber } from "./accounting-decimal.js";
import {
  type AccountResult,
  failedAccount,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

function usd(amount: number): Amount {
  return { decimal: accountingDecimalFromNumber(amount), unit: { kind: "currency", code: "USD" } };
}

/** A month of Cursor spend estimated from local history: API or Auto+Composer. */
function spendRow(
  key: "api" | "auto_composer",
  label: string,
  costUsd: number,
  resetsAt: string,
  prominence: ProviderRow["prominence"],
): ProviderRow {
  return {
    key,
    label,
    type: "usage",
    method: "local_estimation",
    authority: "locally_derived",
    window: "month",
    prominence,
    amount: usd(costUsd),
    resetsAt,
  };
}

function formatUsage(bucket: { costUsd: number; messageCount: number }): string {
  return `${fmtUsdAmount(bucket.costUsd)} across ${bucket.messageCount.toLocaleString("en-US")} messages`;
}

export const cursorProvider: QuotaProvider = {
  id: "cursor",
  cachePolicy: { kind: "uncached" },

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

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const planLabel = getCursorPlanDisplayName(ctx.config.cursorPlan);
    const includedApiUsd = getEffectiveCursorIncludedApiUsd({
      plan: ctx.config.cursorPlan,
      overrideUsd: ctx.config.cursorIncludedApiUsd,
    });
    const [usage, auth, integration] = await Promise.all([
      getCurrentCursorUsageSummary({
        billingCycleStartDay: ctx.config.cursorBillingCycleStartDay,
      }),
      inspectCursorAuthPresence(),
      inspectCursorOpenCodeIntegration(),
    ]);
    const debug = statusDetailsFromRecord({
      plan: planLabel ?? "none",
      included_api_usd:
        typeof includedApiUsd === "number" ? fmtUsdAmount(includedApiUsd) : "(none)",
      billing_cycle_start_day:
        typeof ctx.config.cursorBillingCycleStartDay === "number"
          ? String(ctx.config.cursorBillingCycleStartDay)
          : "(calendar month)",
      auth_state: auth.state,
      auth_selected_path: auth.selectedPath ?? "(none)",
      auth_present_paths: auth.presentPaths.join(" | ") || "(none)",
      auth_candidate_paths: auth.candidatePaths.join(" | ") || "(none)",
      auth_error: auth.error,
      plugin_enabled: integration.pluginEnabled ? "true" : "false",
      canonical_plugin_package: CURSOR_CANONICAL_PLUGIN_PACKAGE,
      provider_configured: integration.providerConfigured ? "true" : "false",
      config_matches: integration.matchedPaths.join(" | ") || "(none)",
      config_checked_paths: integration.checkedPaths.join(" | ") || "(none)",
      cycle_source: usage.window.source,
      cycle_reset_at: usage.window.resetTimeIso,
      api_usage: formatUsage(usage.api),
      auto_composer_usage: formatUsage(usage.autoComposer),
      total_cursor_usage: formatUsage(usage.total),
      unknown_cursor_models: usage.unknownModels.length.toLocaleString("en-US"),
    });

    if (usage.total.messageCount === 0 && includedApiUsd === undefined) {
      return { attempted: false, accounts: [], debug };
    }

    const hasPartialApiCoverage = usage.unknownModels.length > 0;
    const hasPositiveAllowance = includedApiUsd !== undefined && includedApiUsd > 0;
    const resetsAt = usage.window.resetTimeIso;
    const rows: ProviderRow[] = [];
    if (hasPositiveAllowance && !hasPartialApiCoverage) {
      // A billing cycle from the configured start day is a fixed window.
      const fixedWindow =
        usage.window.source === "configured_day" &&
        usage.window.sinceMs < usage.observedAtMs &&
        usage.observedAtMs < usage.window.untilMs;
      rows.push({
        key: "api",
        label: "API",
        type: "budget",
        method: "local_estimation",
        authority: "locally_derived",
        window: "month",
        prominence: "primary",
        percentRemaining: 100 - (usage.api.costUsd / includedApiUsd) * 100,
        used: usd(usage.api.costUsd),
        limit: usd(includedApiUsd),
        remaining: usd(Math.max(0, includedApiUsd - usage.api.costUsd)),
        resetsAt,
        ...(fixedWindow ? { windowStartedAt: new Date(usage.window.sinceMs).toISOString() } : {}),
      });
    } else {
      const label = hasPartialApiCoverage ? "Known API" : "API";
      rows.push(spendRow("api", label, usage.api.costUsd, resetsAt, "primary"));
    }
    if (usage.autoComposer.messageCount > 0 || includedApiUsd !== undefined) {
      rows.push(
        spendRow(
          "auto_composer",
          "Auto+Composer",
          usage.autoComposer.costUsd,
          resetsAt,
          "supplementary",
        ),
      );
    }

    const accounts: AccountResult[] = [
      { name: planLabel ? `Cursor (${planLabel})` : "Cursor", rows, errors: [] },
    ];
    if (hasPartialApiCoverage) {
      accounts.push(
        failedAccount(
          "Cursor",
          "Unknown Cursor model ids present in local history (see /quota_status)",
        ),
      );
    }
    return { attempted: true, accounts, debug };
  },
};
