import { vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/lib/types.js";

type ReturnValueMock = {
  mockReturnValue(value: unknown): unknown;
};

type ResolvedValueMock = {
  mockResolvedValue(value: unknown): unknown;
};

interface PricingMocks {
  getPricingSnapshotMeta: ReturnValueMock;
  getPricingSnapshotSource: ReturnValueMock;
  getRuntimePricingRefreshStatePath: ReturnValueMock;
  getRuntimePricingSnapshotPath: ReturnValueMock;
  maybeRefreshPricingSnapshot: ResolvedValueMock;
}

export function resetPluginTestState(): void {
  delete (globalThis as any).__opencodeQuotaCommandCache;
}

export function makeQuotaToastTestConfig(
  overrides: Partial<typeof DEFAULT_CONFIG> = {},
): typeof DEFAULT_CONFIG {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

export function seedDefaultPricingMocks(mocks: PricingMocks): void {
  mocks.getPricingSnapshotMeta.mockReturnValue({
    source: "https://models.dev/api.json",
    generatedAt: Date.UTC(2026, 0, 1),
    units: "USD per 1M tokens",
  });
  mocks.getPricingSnapshotSource.mockReturnValue("runtime");
  mocks.getRuntimePricingSnapshotPath.mockReturnValue("/tmp/modelsdev-pricing.runtime.min.json");
  mocks.getRuntimePricingRefreshStatePath.mockReturnValue(
    "/tmp/modelsdev-pricing.refresh-state.json",
  );
  mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
    attempted: false,
    updated: false,
    state: { version: 1, updatedAt: Date.now() },
  });
}

export function createPluginTestClient({
  modelID,
  providerID,
  sessionData,
}: {
  modelID?: string;
  providerID?: string;
  sessionData?: Record<string, unknown>;
} = {}) {
  const data = {
    ...(modelID === undefined ? {} : { modelID }),
    ...(providerID === undefined ? {} : { providerID }),
    ...(sessionData ?? {}),
  };

  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data }),
      prompt: vi.fn().mockResolvedValue({}),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({}),
    },
    app: {
      log: vi.fn().mockResolvedValue({}),
    },
  };
}
