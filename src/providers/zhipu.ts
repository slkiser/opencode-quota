/**
 * Zhipu provider wrapper.
 *
 * Normalizes Zhipu quota into generic toast entries.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { queryZhipuQuota } from "../lib/zhipu.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS, resolveZhipuAuthCached } from "../lib/zhipu-auth.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
} from "./result-helpers.js";

export const zhipuProvider: QuotaProvider = {
  id: "zhipu",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "zhipu",
      fallbackOnError: false,
    });
    if (!providerAvailable) {
      return false;
    }

    const auth = await resolveZhipuAuthCached({
      maxAgeMs: DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured" || auth.state === "invalid";
  },

  matchesCurrentModel(model: string): boolean {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    return !!provider && (provider.includes("zhipu") || provider === "glm-coding-plan");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryZhipuQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    return mapNullableProviderResult(result, {
      errorLabel: "Zhipu",
      onSuccess: (result) =>
        attemptedResult(
          groupedPercentWindowEntries({
            group: result.label,
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
            },
            windows: [
              { window: result.windows.fiveHour, suffix: "5h", label: "5h:" },
              { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
              { window: result.windows.mcp, suffix: "MCP", label: "MCP:" },
            ],
          }),
          [],
          {
            singleWindowDisplayName: result.label,
          },
        ),
    });
  },
};
