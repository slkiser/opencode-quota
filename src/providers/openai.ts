/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
} from "../lib/openai.js";
import { isAnyProviderIdAvailable } from "../lib/provider-availability.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isAnyProviderIdAvailable({
      ctx,
      candidateIds: ["openai", "chatgpt", "codex", "opencode"],
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    return hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS });
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return (
      provider.includes("openai") || provider.includes("chatgpt") || provider.includes("codex")
    );
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryOpenAIQuota();

    if (!result) {
      return { attempted: false, entries: [], errors: [] };
    }

    if (!result.success) {
      return {
        attempted: true,
        entries: [],
        errors: [{ label: "OpenAI", message: result.error }],
      };
    }

    const style = _ctx.config.toastStyle ?? "classic";

    // Keep the classic toast behavior: show a single entry based on the worst remaining window.
    if (style === "classic") {
      const windows = [
        result.windows.hourly && { name: "Hourly", ...result.windows.hourly },
        result.windows.weekly && { name: "Weekly", ...result.windows.weekly },
        result.windows.codeReview && { name: "Code Review", ...result.windows.codeReview },
      ].filter(Boolean) as Array<{ name: string; percentRemaining: number; resetTimeIso?: string }>;

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

    // Grouped style: expose all windows.
    const entries: QuotaToastEntry[] = [];
    const group = result.label;

    const hourly = result.windows.hourly;
    if (hourly) {
      entries.push({
        name: `${group} Hourly`,
        group,
        label: "Hourly:",
        percentRemaining: hourly.percentRemaining,
        resetTimeIso: hourly.resetTimeIso,
      });
    }

    const weekly = result.windows.weekly;
    if (weekly) {
      entries.push({
        name: `${group} Weekly`,
        group,
        label: "Weekly:",
        percentRemaining: weekly.percentRemaining,
        resetTimeIso: weekly.resetTimeIso,
      });
    }

    const codeReview = result.windows.codeReview;
    if (codeReview) {
      entries.push({
        name: `${group} Code Review`,
        group,
        label: "Code Review:",
        percentRemaining: codeReview.percentRemaining,
        resetTimeIso: codeReview.resetTimeIso,
      });
    }

    return {
      attempted: true,
      entries,
      errors: [],
    };
  },
};
