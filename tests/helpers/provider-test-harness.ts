import { vi } from "vitest";

import type { QuotaProviderContext } from "../../src/lib/entries.js";
import { createRuntimeProviderIdResolver } from "../../src/lib/runtime-provider-ids.js";

type ProviderAvailabilityContextOptions = {
  providerIds?: string[];
  providersError?: Error;
  configOverrides?: Record<string, unknown>;
};

export function createProviderAvailabilityContext(
  options: ProviderAvailabilityContextOptions = {},
) {
  const { providerIds = [], providersError, configOverrides = {} } = options;

  const providers = providersError
    ? vi.fn().mockRejectedValue(providersError)
    : vi.fn().mockResolvedValue({ data: { providers: providerIds.map((id) => ({ id })) } });

  const client: QuotaProviderContext["client"] = {
    config: {
      providers,
      get: vi.fn(async () => {
        throw new Error("Unexpected config.get() in provider availability test");
      }),
    },
  };

  return {
    client,
    resolveRuntimeProviderIds: createRuntimeProviderIdResolver(client),
    config: {
      googleModels: [],
      ...configOverrides,
    },
  } as any;
}
