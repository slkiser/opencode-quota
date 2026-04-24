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
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
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
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("OpenAI", result.error);
    }

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

    if (entries.length === 0) {
      entries.push({ name: result.label, percentRemaining: 0 });
    }

    return attemptedResult(entries, [], {
      singleWindowDisplayName: result.label,
    });
  },
};
