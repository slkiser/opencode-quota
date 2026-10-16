import type { CanonicalQuotaProviderId } from "./provider-metadata.js";
import { QUOTA_PROVIDER_RUNTIME_IDS } from "./provider-metadata.js";

interface ProviderModelRef {
  lower: string;
  providerId: string;
  modelId: string;
}

export function parseProviderModelRef(model: string): ProviderModelRef {
  const lower = model.toLowerCase();
  const [providerId = "", modelId = ""] = lower.split("/", 2);
  return { lower, providerId, modelId };
}

export function providerIdIncludesAny(providerId: string, fragments: readonly string[]): boolean {
  const lowerProviderId = providerId.toLowerCase();
  return fragments.some((fragment) => lowerProviderId.includes(fragment.toLowerCase()));
}

export function modelProviderIncludesAny(model: string, fragments: readonly string[]): boolean {
  const { providerId } = parseProviderModelRef(model);
  return providerIdIncludesAny(providerId, fragments);
}

export function modelProviderMatchesRuntimeId(
  model: string,
  canonicalId: CanonicalQuotaProviderId,
): boolean {
  const { providerId } = parseProviderModelRef(model);
  return QUOTA_PROVIDER_RUNTIME_IDS[canonicalId].includes(providerId);
}

export function modelIncludesAny(model: string, fragments: readonly string[]): boolean {
  const lower = model.toLowerCase();
  return fragments.some((fragment) => lower.includes(fragment.toLowerCase()));
}
