/**
 * NanoGPT provider wrapper.
 *
 * Supports both daily and monthly quota windows.
 * - Classic style: shows the worse (lower) remaining percentage
 * - Grouped style: shows both daily and monthly as separate entries
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryNanoGptQuota, hasNanoGptApiKeyConfigured } from "../lib/nanogpt.js";

type GroupedToastEntry = {
  name: string;
  percentRemaining: number;
  resetTimeIso?: string;
  group?: string;
  label?: string;
};

export const nanogptProvider: QuotaProvider = {
  id: "nano-gpt",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    try {
      const resp = await ctx.client.config.providers();
      const ids = new Set((resp.data?.providers ?? []).map((p) => p.id));
      if (ids.has("nano-gpt") || ids.has("nanogpt")) return true;
    } catch {
      // ignore
    }

    return await hasNanoGptApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return provider.includes("nano-gpt") || provider.includes("nanogpt");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
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

    const style = _ctx.config.toastStyle ?? "classic";

    if (style === "classic") {
      const daily = result.daily;
      const monthly = result.monthly;
      const worse = daily.percentRemaining <= monthly.percentRemaining ? daily : monthly;

      return {
        attempted: true,
        entries: [
          {
            name: "NanoGPT",
            percentRemaining: worse.percentRemaining,
            resetTimeIso: worse.resetTimeIso,
          },
        ],
        errors: [],
      };
    }

    const entries: GroupedToastEntry[] = [];
    const group = "NanoGPT";

    entries.push({
      name: `${group} Daily`,
      group,
      label: "Daily:",
      percentRemaining: result.daily.percentRemaining,
      resetTimeIso: result.daily.resetTimeIso,
    });

    entries.push({
      name: `${group} Monthly`,
      group,
      label: "Monthly:",
      percentRemaining: result.monthly.percentRemaining,
      resetTimeIso: result.monthly.resetTimeIso,
    });

    return {
      attempted: true,
      entries,
      errors: [],
    };
  },
};
