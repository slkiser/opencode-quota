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

interface AuthPlanMocks {
  resolveAlibabaCodingPlanAuthCached?: MockFunction;
  resolveQwenLocalPlanCached?: MockFunction;
}

interface PluginBootstrapMocks extends PricingMocks, AuthPlanMocks {
  loadConfig: MockFunction;
  getProviders?: MockFunction;
  fetchSessionTokensForDisplay?: MockFunction;
}

interface PluginBootstrapOptions {
  configOverrides?: Partial<typeof DEFAULT_CONFIG>;
  providers?: unknown[];
  resetModules?: boolean;
  resetPluginState?: boolean;
  seedAuthPlans?: boolean;
  seedSessionTokens?: boolean;
}

interface PluginRuntimeRoot {
  cacheDir: string;
  configDir: string;
  dataDir: string;
  stateDir: string;
}

interface PluginRuntimePathCandidates {
  cacheDirs: string[];
  configDirs: string[];
  dataDirs: string[];
  stateDirs: string[];
}

interface PluginRuntimePathsMockOptions {
  includeCandidates?: boolean;
}

interface PluginTuiConfigInspectionOverrides {
  candidatePaths?: string[];
  configRoot?: string;
  configured?: boolean;
  inferredSelectedPath?: string | null;
  presentPaths?: string[];
  quotaPluginConfigPaths?: string[];
  quotaPluginConfigured?: boolean;
  workspaceRoot?: string;
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
      configIssues: [],
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
      (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
    resolveAlibabaCodingPlanAuthCached,
  };
}

export function createPluginBootstrapRuntimeRoot(root: string): PluginRuntimeRoot {
  return {
    dataDir: `${root}/data`,
    configDir: `${root}/config`,
    cacheDir: `${root}/cache`,
    stateDir: `${root}/state`,
  };
}

export function createPluginRuntimePathCandidates(root: string): PluginRuntimePathCandidates {
  return {
    dataDirs: [`${root}/data`],
    configDirs: [`${root}/config`],
    cacheDirs: [`${root}/cache`],
    stateDirs: [`${root}/state`],
  };
}

export function createPluginRuntimePathsMockModule(
  root: string,
  options: PluginRuntimePathsMockOptions = {},
) {
  const runtimeRoot = createPluginBootstrapRuntimeRoot(root);
  const candidates = createPluginRuntimePathCandidates(root);

  return {
    getOpencodeRuntimeDirs: () => ({ ...runtimeRoot }),
    ...(options.includeCandidates
      ? { getOpencodeRuntimeDirCandidates: () => ({ ...candidates }) }
      : {}),
  };
}

export function createPluginTuiConfigInspection(
  root: string,
  overrides: PluginTuiConfigInspectionOverrides = {},
) {
  return {
    workspaceRoot: overrides.workspaceRoot ?? root,
    configRoot: overrides.configRoot ?? root,
    configured: overrides.configured ?? false,
    inferredSelectedPath: overrides.inferredSelectedPath ?? null,
    presentPaths: overrides.presentPaths ?? [],
    candidatePaths: overrides.candidatePaths ?? [],
    quotaPluginConfigured: overrides.quotaPluginConfigured ?? false,
    quotaPluginConfigPaths: overrides.quotaPluginConfigPaths ?? [],
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
    enabledProviders:
      overrides.enabledProviders !== undefined
        ? Array.isArray(overrides.enabledProviders)
          ? [...overrides.enabledProviders]
          : overrides.enabledProviders
        : Array.isArray(DEFAULT_CONFIG.enabledProviders)
          ? [...DEFAULT_CONFIG.enabledProviders]
          : DEFAULT_CONFIG.enabledProviders,
    googleModels: [...(overrides.googleModels ?? DEFAULT_CONFIG.googleModels)],
    opencodeGoWindows: [...(overrides.opencodeGoWindows ?? DEFAULT_CONFIG.opencodeGoWindows)],
    pricingSnapshot: {
      ...DEFAULT_CONFIG.pricingSnapshot,
      ...overrides.pricingSnapshot,
    },
    tuiSidebarPanel: {
      ...DEFAULT_CONFIG.tuiSidebarPanel,
      ...overrides.tuiSidebarPanel,
    },
    tuiCompactStatus: {
      ...DEFAULT_CONFIG.tuiCompactStatus,
      ...overrides.tuiCompactStatus,
    },
    maintainerAnnouncements: {
      ...DEFAULT_CONFIG.maintainerAnnouncements,
      ...overrides.maintainerAnnouncements,
    },
    layout: {
      ...DEFAULT_CONFIG.layout,
      ...overrides.layout,
    },
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

export function seedDefaultAuthPlanMocks(mocks: AuthPlanMocks): void {
  mocks.resolveQwenLocalPlanCached?.mockResolvedValue({ state: "none" });
  mocks.resolveAlibabaCodingPlanAuthCached?.mockResolvedValue({ state: "none" });
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

  if (options.seedAuthPlans !== false) {
    seedDefaultAuthPlanMocks(mocks);
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
    ...(modelID === undefined && providerID === undefined
      ? {}
      : {
          model: {
            ...(modelID === undefined ? {} : { id: modelID }),
            ...(providerID === undefined ? {} : { providerID }),
          },
        }),
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
