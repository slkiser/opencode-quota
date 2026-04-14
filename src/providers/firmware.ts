/**
 * Firmware AI provider wrapper.
 */

import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { hasFirmwareApiKeyConfigured, queryFirmwareQuota } from "../lib/firmware.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";

export const firmwareProvider: QuotaProvider = {
  id: "firmware",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "firmware",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasFirmwareApiKeyConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    const provider = model.split("/")[0]?.toLowerCase();
    if (!provider) return false;
    return provider.includes("firmware");
  },

  async fetch(_ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const result = await queryFirmwareQuota();

    if (!result) {
      return notAttemptedResult();
    }

    if (!result.success) {
      return attemptedErrorResult("Firmware", result.error);
    }

    const value = fmtUsdAmount(result.creditsUsd);

    return attemptedResult([
      {
        kind: "value",
        name: "Firmware",
        value,
        resetTimeIso: result.resetTimeIso,
      },
    ]);
  },
};
