import type { QuotaProviderContext } from "./entries.js";
import { getQuotaProviderRuntimeIds, type CanonicalQuotaProviderId } from "./provider-metadata.js";

export async function isAnyProviderIdAvailable(params: {
  ctx: Pick<QuotaProviderContext, "resolveRuntimeProviderIds">;
  candidateIds: readonly string[];
  fallbackOnError: boolean;
}): Promise<boolean> {
  const { ctx, candidateIds, fallbackOnError } = params;

  try {
    const ids = await ctx.resolveRuntimeProviderIds();
    return candidateIds.some((id) => ids.has(id));
  } catch {
    return fallbackOnError;
  }
}

export async function isCanonicalProviderAvailable(params: {
  ctx: Pick<QuotaProviderContext, "resolveRuntimeProviderIds">;
  providerId: CanonicalQuotaProviderId;
  fallbackOnError: boolean;
}): Promise<boolean> {
  const { ctx, providerId, fallbackOnError } = params;
  return isAnyProviderIdAvailable({
    ctx,
    candidateIds: getQuotaProviderRuntimeIds(providerId),
    fallbackOnError,
  });
}
