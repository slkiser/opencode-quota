/**
 * Google Antigravity provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import type { GoogleModelId } from "../lib/types.js";
import { hasAntigravityQuotaRuntimeAvailable, queryGoogleQuota } from "../lib/google.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import {
  formatGoogleAccountErrors,
  formatGoogleAccountLabel,
} from "./google-account-format.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

async function isAccountsConfigured(): Promise<boolean> {
  try {
    return await hasAntigravityQuotaRuntimeAvailable();
  } catch {
    return false;
  }
}

export const googleAntigravityProvider: QuotaProvider = {
  id: "google-antigravity",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    // Google quota depends on both the accounts file and the separately
    // installed companion auth plugin.
    return await isAccountsConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["google", "antigravity", "opencode"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const modelIds = ctx.config.googleModels as GoogleModelId[];
    const result = await queryGoogleQuota(modelIds, {
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Antigravity", result.error);
    }

    const entries = result.models.map((m) => {
      const emailLabel = formatGoogleAccountLabel(m.accountEmail, "fixedGmailHint") || "Antigravity";
      return {
        name: `${m.displayName} (${emailLabel})`,
        group: m.displayName,
        label: `${m.displayName}:`,
        percentRemaining: m.percentRemaining,
        resetTimeIso: m.resetTimeIso,
      };
    });

    return attemptedResult(
      entries,
      formatGoogleAccountErrors(result.errors, "fixedGmailHint"),
      { classicStrategy: "preserve" },
    );
  },
};
