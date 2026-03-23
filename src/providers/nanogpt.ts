/**
 * NanoGPT provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { hasNanoGptApiKeyConfigured, queryNanoGptQuota } from "../lib/nanogpt.js";

function formatUsageAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(Math.trunc(value));
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatUsageRight(window: { used: number; limit: number }): string {
  return `${formatUsageAmount(window.used)}/${formatUsageAmount(window.limit)}`;
}

function createUsageEntry(
  style: "classic" | "grouped",
  params: {
    name: string;
    label: string;
    window: {
      used: number;
      limit: number;
      percentRemaining: number;
      resetTimeIso?: string;
    };
  },
): QuotaToastEntry {
  if (style === "grouped") {
    return {
      name: params.name,
      group: "NanoGPT",
      label: params.label,
      right: formatUsageRight(params.window),
      percentRemaining: params.window.percentRemaining,
      resetTimeIso: params.window.resetTimeIso,
    };
  }

  return {
    name: params.name,
    percentRemaining: params.window.percentRemaining,
    resetTimeIso: params.window.resetTimeIso,
  };
}

export const nanoGptProvider: QuotaProvider = {
  id: "nanogpt",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const hasApiKey = await hasNanoGptApiKeyConfigured();
    try {
      const resp = await ctx.client.config.providers();
      const ids = new Set((resp.data?.providers ?? []).map((provider) => provider.id));
      if (ids.has("nanogpt") || ids.has("nano-gpt")) {
        return hasApiKey;
      }
    } catch {
      // Ignore provider lookup failures and fall back to key presence.
    }

    return hasApiKey;
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    return provider === "nanogpt" || provider === "nano-gpt";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryNanoGptQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "NanoGPT", message: result.error }],
      };
    }

    const style = ctx.config.toastStyle ?? "classic";
    const entries: QuotaToastEntry[] = [];
    const errors: Array<{ label: string; message: string }> = [];
    const subscription = result.subscription;

    if (subscription.weeklyInputTokens) {
      entries.push(
        createUsageEntry(style, {
          name: "NanoGPT Weekly Tokens",
          label: "Weekly:",
          window: subscription.weeklyInputTokens,
        }),
      );
    }

    if (subscription.dailyImages) {
      entries.push(
        createUsageEntry(style, {
          name: "NanoGPT Daily Images",
          label: "Images:",
          window: subscription.dailyImages,
        }),
      );
    }

    if (subscription.dailyInputTokens) {
      entries.push(
        createUsageEntry(style, {
          name: "NanoGPT Daily Tokens",
          label: "Daily Tokens:",
          window: subscription.dailyInputTokens,
        }),
      );
    }

    if (
      !subscription.weeklyInputTokens &&
      (subscription.dailyImages || subscription.dailyInputTokens)
    ) {
      errors.push({
        label: "NanoGPT",
        message: "Weekly input token usage unavailable from NanoGPT subscription API",
      });
    }

    if (subscription.state && subscription.state.toLowerCase() !== "active") {
      errors.push({
        label: "NanoGPT",
        message: `Subscription state: ${subscription.state}`,
      });
    }

    if (entries.length === 0) {
      errors.push({
        label: "NanoGPT",
        message: "No usable NanoGPT subscription usage data",
      });
    }

    return {
      attempted: true,
      entries,
      errors,
    };
  },
};
