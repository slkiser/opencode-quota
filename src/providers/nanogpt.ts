/**
 * NanoGPT provider wrapper.
 *
 * Normalizes NanoGPT subscription usage into generic toast entries.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryNanoGptQuota, hasNanoGptApiKey } from "../lib/nanogpt.js";
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";

export const nanogptProvider: QuotaProvider = {
  id: "nanogpt",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const hasProvider = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: ["nanogpt", "nanogpt-custom", "nano-gpt"],
      fallbackOnError: false,
    });

    if (hasProvider) return true;

    return await hasNanoGptApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return provider === "nanogpt" || provider === "nano-gpt" || provider === "nanogpt-custom";
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

    if (style === "classic") {
      const windows: Array<{ name: string; percentRemaining: number; resetTimeIso?: string }> = [];

      if (result.windows.weeklyTokens) {
        windows.push({ name: "Weekly Tokens", ...result.windows.weeklyTokens });
      }
      if (result.windows.dailyTokens) {
        windows.push({ name: "Daily Tokens", ...result.windows.dailyTokens });
      }
      if (result.windows.dailyImages) {
        windows.push({ name: "Daily Images", ...result.windows.dailyImages });
      }

      if (windows.length === 0) {
        return {
          attempted: true,
          entries: [{ name: result.label, percentRemaining: 0 }],
          errors: [],
        };
      }

      windows.sort((a, b) => a.percentRemaining - b.percentRemaining);
      const worst = windows[0]!;

      return {
        attempted: true,
        entries: [
          {
            name: result.label,
            percentRemaining: worst.percentRemaining,
            resetTimeIso: worst.resetTimeIso,
          },
        ],
        errors: [],
      };
    }

    const entries: QuotaToastEntry[] = [];
    const group = result.label;

    const weeklyTokens = result.windows.weeklyTokens;
    if (weeklyTokens) {
      entries.push({
        name: `${group} Weekly Tokens`,
        group,
        label: "Weekly:",
        percentRemaining: weeklyTokens.percentRemaining,
        resetTimeIso: weeklyTokens.resetTimeIso,
      });
    }

    const dailyTokens = result.windows.dailyTokens;
    if (dailyTokens) {
      entries.push({
        name: `${group} Daily Tokens`,
        group,
        label: "Daily:",
        percentRemaining: dailyTokens.percentRemaining,
        resetTimeIso: dailyTokens.resetTimeIso,
      });
    }

    const dailyImages = result.windows.dailyImages;
    if (dailyImages) {
      entries.push({
        name: `${group} Daily Images`,
        group,
        label: "Images:",
        percentRemaining: dailyImages.percentRemaining,
        resetTimeIso: dailyImages.resetTimeIso,
      });
    }

    return {
      attempted: true,
      entries,
      errors: [],
    };
  },
};
