import { vi } from "vitest";

import { DEFAULT_CONFIG } from "../../src/lib/types.js";

type MockFunction = ReturnType<typeof vi.fn>;

type PromptClient = {
  session: {
    prompt: MockFunction;
  };
};

type ToastClient = {
  tui: {
    showToast: MockFunction;
  };
};

interface PricingMocks {
  getPricingSnapshotMeta: MockFunction;
  getPricingSnapshotSource: MockFunction;
  getRuntimePricingRefreshStatePath: MockFunction;
  getRuntimePricingSnapshotPath: MockFunction;
  maybeRefreshPricingSnapshot: MockFunction;
  setPricingSnapshotAutoRefresh: MockFunction;
  setPricingSnapshotSelection: MockFunction;
}

interface SessionTokenMocks {
  fetchSessionTokensForDisplay: MockFunction;
}

interface PluginBootstrapMocks extends PricingMocks {
  loadConfig: MockFunction;
  getProviders?: MockFunction;
  fetchSessionTokensForDisplay?: MockFunction;
}

interface PluginBootstrapOptions {
  configOverrides?: Partial<typeof DEFAULT_CONFIG>;
  providers?: unknown[];
  resetModules?: boolean;
  resetPluginState?: boolean;
  seedSessionTokens?: boolean;
}

function createSchemaChain() {
  const chain: any = {};
  chain.optional = () => chain;
  chain.describe = () => chain;
  chain.int = () => chain;
  chain.min = () => chain;
  return chain;
}

export function createPluginToolMockModule() {
  const toolFn = ((definition: unknown) => definition) as any;
  toolFn.schema = {
    boolean: () => createSchemaChain(),
    number: () => createSchemaChain(),
  };

  return { tool: toolFn };
}

export function createConfigModuleMock(loadConfig: MockFunction) {
  return {
    loadConfig,
    createLoadConfigMeta: () => ({
      source: "defaults",
      paths: [],
      globalConfigPaths: [],
      workspaceConfigPaths: [],
      settingSources: {},
      networkSettingSources: {},
    }),
  };
}

export function createProvidersRegistryModuleMock(getProviders: MockFunction) {
  return { getProviders };
}

export function createPricingModuleMock(mocks: PricingMocks) {
  return {
    getPricingSnapshotMeta: mocks.getPricingSnapshotMeta,
    getPricingSnapshotSource: mocks.getPricingSnapshotSource,
    getRuntimePricingRefreshStatePath: mocks.getRuntimePricingRefreshStatePath,
    getRuntimePricingSnapshotPath: mocks.getRuntimePricingSnapshotPath,
    maybeRefreshPricingSnapshot: mocks.maybeRefreshPricingSnapshot,
    setPricingSnapshotAutoRefresh: mocks.setPricingSnapshotAutoRefresh,
    setPricingSnapshotSelection: mocks.setPricingSnapshotSelection,
  };
}

export function createSessionTokensModuleMock(fetchSessionTokensForDisplay: MockFunction) {
  return { fetchSessionTokensForDisplay };
}

export function createQwenAuthModuleMock(resolveQwenLocalPlanCached: MockFunction) {
  return {
    isQwenCodeModelId: (model?: string) =>
      typeof model === "string" && model.toLowerCase().startsWith("qwen-code/"),
    resolveQwenLocalPlanCached,
  };
}

export function createAlibabaAuthModuleMock(resolveAlibabaCodingPlanAuthCached: MockFunction) {
  return {
    DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5000,
    isAlibabaModelId: (model?: string) =>
      typeof model === "string" &&
      (model.toLowerCase().startsWith("alibaba/") ||
        model.toLowerCase().startsWith("alibaba-cn/")),
    resolveAlibabaCodingPlanAuthCached,
  };
}

export function resetPluginTestState(): void {
  // Per-test module resets clear in-memory plugin/cache singletons.
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

export function seedDefaultSessionTokenMocks(mocks: SessionTokenMocks): void {
  mocks.fetchSessionTokensForDisplay.mockResolvedValue({
    sessionTokens: undefined,
    error: undefined,
  });
}

export function seedDefaultPluginBootstrapMocks(
  mocks: PluginBootstrapMocks,
  options: PluginBootstrapOptions = {},
): void {
  vi.clearAllMocks();

  if (options.resetModules || options.resetPluginState) {
    // Fresh module instances clear singleton state such as src/lib/cache.ts.
    vi.resetModules();
  }

  if (options.resetPluginState) {
    resetPluginTestState();
  }

  mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig(options.configOverrides));
  mocks.getProviders?.mockReturnValue(options.providers ?? []);

  if (mocks.fetchSessionTokensForDisplay && options.seedSessionTokens !== false) {
    seedDefaultSessionTokenMocks(mocks);
  }

  seedDefaultPricingMocks(mocks);
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

export function getPromptText(client: PromptClient, callIndex = 0): string {
  return client.session.prompt.mock.calls[callIndex]?.[0]?.body?.parts?.[0]?.text ?? "";
}

export function getToastMessage(client: ToastClient, callIndex = 0): string {
  return client.tui.showToast.mock.calls[callIndex]?.[0]?.body?.message ?? "";
}
