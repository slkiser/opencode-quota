import { vi } from "vitest";

type ProviderAvailabilityContextOptions = {
  providerIds?: string[];
  providersError?: Error;
  configOverrides?: Record<string, unknown>;
};

export function createProviderAvailabilityContext(options: ProviderAvailabilityContextOptions = {}) {
  const { providerIds = [], providersError, configOverrides = {} } = options;

  const providers = providersError
    ? vi.fn().mockRejectedValue(providersError)
    : vi.fn().mockResolvedValue({ data: { providers: providerIds.map((id) => ({ id })) } });

  return {
    client: {
      config: {
        providers,
        get: vi.fn(() => {
          throw new Error("Unexpected config.get() in provider availability test");
        }),
      },
    },
    config: {
      googleModels: [],
      ...configOverrides,
    },
  } as any;
}
