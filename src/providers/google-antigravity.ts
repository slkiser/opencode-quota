/**
 * Google Antigravity provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastError,
} from "../lib/entries.js";
import type { GoogleModelId, GoogleResult } from "../lib/types.js";
import { hasAntigravityQuotaRuntimeAvailable, queryGoogleQuota } from "../lib/google.js";

function truncateEmail(email?: string): string {
  if (!email) return "Unknown";
  const prefix = email.slice(0, 3);
  return `${prefix}..gmail`;
}

function normalizeGoogleErrors(result: GoogleResult): QuotaToastError[] {
  if (!result || !result.success || !result.errors || result.errors.length === 0) return [];
  return result.errors.map((e) => ({ label: truncateEmail(e.email), message: e.error }));
}

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
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return (
      provider.includes("google") ||
      provider.includes("antigravity") ||
      provider.includes("opencode")
    );
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const modelIds = ctx.config.googleModels as GoogleModelId[];
    const result = await queryGoogleQuota(modelIds);

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "Antigravity", message: result.error }],
      };
    }

    const entries = result.models.map((m) => {
      const emailLabel = truncateEmail(m.accountEmail) || "Antigravity";
      return {
        name: `${m.displayName} (${emailLabel})`,
        percentRemaining: m.percentRemaining,
        resetTimeIso: m.resetTimeIso,
      };
    });

    return {
      attempted: true,
      entries,
      errors: normalizeGoogleErrors(result),
    };
  },
};
