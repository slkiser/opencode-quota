import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaProviderResult } from "../src/lib/entries.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-render-data-tests";
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const { mockProviders } = vi.hoisted(() => ({
  mockProviders: [] as any[],
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

import {
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
  matchesQuotaProviderCurrentSelection,
} from "../src/lib/quota-render-data.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

function renderConfig(overrides: Partial<QuotaToastConfig> = {}): QuotaToastConfig {
  return { ...DEFAULT_CONFIG, showSessionTokens: false, ...overrides };
}

function testProvider(
  id: string,
  result: Partial<QuotaProviderResult> = {},
  availability: boolean | Error = true,
) {
  return {
    id,
    isAvailable:
      availability instanceof Error
        ? vi.fn().mockRejectedValue(availability)
        : vi.fn().mockResolvedValue(availability),
    fetch: vi.fn().mockResolvedValue({ attempted: true, entries: [], errors: [], ...result }),
  };
}

const TEST_CLIENT = {
  config: {
    providers: async () => ({ data: { providers: [] } }),
    get: async () => ({ data: {} }),
  },
};

describe("collectQuotaRenderData shared quota state", () => {
  beforeEach(async () => {
    mockProviders.length = 0;
    vi.restoreAllMocks();
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockProviders.length = 0;
    vi.restoreAllMocks();
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("uses explicitly provided providers instead of the global registry", async () => {
    const runtimeProvider = testProvider("custom-runtime", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Custom Runtime Daily",
          group: "Custom Runtime",
          label: "Daily:",
          percentRemaining: 42,
        },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["custom-runtime"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [runtimeProvider],
    });

    expect(runtimeProvider.isAvailable).toHaveBeenCalledOnce();
    expect(runtimeProvider.fetch).toHaveBeenCalledOnce();
    expect(result.active).toEqual([runtimeProvider]);
    expect(result.data?.entries).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "Custom Runtime Daily",
        group: "Custom Runtime",
        label: "Daily:",
        percentRemaining: 42,
      },
    ]);
  });

  it("returns allWindowsData when includeAllWindowsData is true and style is singleWindow", async () => {
    const provider = testProvider("test-provider", {
      entries: [
        { accounting: TEST_ACCOUNTING, name: "Daily", label: "Daily:", percentRemaining: 50 },
        { accounting: TEST_ACCOUNTING, name: "Weekly", label: "Weekly:", percentRemaining: 80 },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["test-provider"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
      includeAllWindowsData: true,
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).toBeDefined();
    expect(result.allWindowsData).not.toBeNull();
    expect(result.allWindowsData!.entries.length).toBe(2);
    expect(result.data!.entries.length).toBe(1);
  });

  it("does not return allWindowsData when includeAllWindowsData is not set", async () => {
    const provider = testProvider("test-provider", {
      entries: [
        { accounting: TEST_ACCOUNTING, name: "Daily", label: "Daily:", percentRemaining: 50 },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["test-provider"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).toBeUndefined();
  });

  it("returns allWindowsData equal to data when style is already allWindows", async () => {
    const provider = testProvider("test-provider", {
      entries: [
        { accounting: TEST_ACCOUNTING, name: "Daily", label: "Daily:", percentRemaining: 50 },
        { accounting: TEST_ACCOUNTING, name: "Weekly", label: "Weekly:", percentRemaining: 80 },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["test-provider"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
      includeAllWindowsData: true,
    });

    expect(result.data).not.toBeNull();
    expect(result.allWindowsData).not.toBeNull();
    expect(result.allWindowsData!.entries).toEqual(result.data!.entries);
  });

  it("treats a thrown availability probe as unavailable instead of rejecting the whole render", async () => {
    const failingProvider = testProvider("copilot", {}, new Error("boom"));
    const workingProvider = testProvider("openai", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "OpenAI (Pro) 5h",
          group: "OpenAI (Pro)",
          label: "5h:",
          percentRemaining: 75,
        },
      ],
      presentation: {
        singleWindowDisplayName: "OpenAI (Pro)",
      },
    });

    mockProviders.push(failingProvider, workingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["copilot", "openai"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
    });

    expect(workingProvider.fetch).toHaveBeenCalledOnce();
    expect(result.availability).toEqual([
      { provider: failingProvider, ok: false, error: true },
      { provider: workingProvider, ok: true },
    ]);
    expect(result.active).toEqual([workingProvider]);
    expect(result.data).toEqual({
      entries: [{ accounting: TEST_ACCOUNTING, name: "[OpenAI] (Pro) 5h", percentRemaining: 75 }],
      errors: [{ label: "Copilot", message: "Unavailable (not detected)" }],
      sessionTokens: undefined,
    });
  });

  it("surfaces explicit unavailable rows when every availability probe fails", async () => {
    const failingProvider = testProvider("copilot", {}, new Error("boom"));

    mockProviders.push(failingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["copilot"] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
    });

    expect(result.availability).toEqual([{ provider: failingProvider, ok: false, error: true }]);
    expect(result.active).toEqual([]);
    expect(result.hasExplicitProviderIssues).toBe(true);
    expect(result.data).toEqual({
      entries: [],
      errors: [{ label: "Copilot", message: "Unavailable (not detected)" }],
    });
  });

  it("still returns null in auto mode when every availability probe fails", async () => {
    const failingProvider = testProvider("copilot", {}, new Error("boom"));

    mockProviders.push(failingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: "auto" }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
    });

    expect(result.availability).toEqual([{ provider: failingProvider, ok: false, error: true }]);
    expect(result.active).toEqual([]);
    expect(result.hasExplicitProviderIssues).toBe(false);
    expect(result.data).toBeNull();
  });

  it("waits for current model metadata before probing providers under onlyCurrentModel", async () => {
    const provider = testProvider("copilot", {}, false);

    mockProviders.push(provider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["copilot"],
        onlyCurrentModel: true,
      }),
      request: {
        sessionID: "fresh-session",
        sessionMeta: {},
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
    });

    expect(result.selection?.waitingForCurrentSelection).toBe(true);
    expect(result.selection?.filteringByCurrentSelection).toBe(false);
    expect(provider.isAvailable).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(result.availability).toEqual([]);
    expect(result.active).toEqual([]);
    expect(result.attemptedAny).toBe(false);
    expect(result.hasExplicitProviderIssues).toBe(false);
    expect(result.data).toBeNull();
  });

  it("uses provider-only session metadata for onlyCurrentModel filtering", async () => {
    const openaiProvider = testProvider("openai", {
      entries: [{ accounting: TEST_ACCOUNTING, name: "OpenAI Weekly", percentRemaining: 55 }],
    });
    const copilotProvider = testProvider("copilot");

    mockProviders.push(openaiProvider, copilotProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["openai", "copilot"],
        onlyCurrentModel: true,
      }),
      request: {
        sessionID: "provider-only-session",
        sessionMeta: { providerID: "openai" },
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
    });

    expect(result.selection?.waitingForCurrentSelection).toBe(false);
    expect(result.selection?.filteringByCurrentSelection).toBe(true);
    expect(result.selection?.filtered).toEqual([openaiProvider]);
    expect(openaiProvider.isAvailable).toHaveBeenCalledOnce();
    expect(openaiProvider.fetch).toHaveBeenCalledOnce();
    expect(copilotProvider.isAvailable).not.toHaveBeenCalled();
    expect(copilotProvider.fetch).not.toHaveBeenCalled();
    expect(result.data?.entries).toEqual([
      { accounting: TEST_ACCOUNTING, name: "OpenAI Weekly", percentRemaining: 55 },
    ]);
  });

  it("marks providers excluded by current-model filtering as intentional diagnostics", async () => {
    const openaiProvider = testProvider("openai", {
      entries: [{ accounting: TEST_ACCOUNTING, name: "OpenAI", percentRemaining: 75 }],
    });
    const xaiProvider = testProvider("xai");
    const ollamaProvider = testProvider("ollama-cloud");
    const openrouterProvider = testProvider("openrouter");

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["openai", "xai", "ollama-cloud", "openrouter"],
        onlyCurrentModel: true,
      }),
      request: {
        sessionID: "explicit-openai-session",
        sessionMeta: { providerID: "openai", modelID: "gpt-5.6-sol" },
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [openaiProvider, xaiProvider, ollamaProvider, openrouterProvider],
    });

    expect(result.data?.errors).toEqual([
      {
        kind: "intentional-filter",
        label: "xAI",
        message: "Skipped (current model: gpt-5.6-sol)",
      },
      {
        kind: "intentional-filter",
        label: "Ollama Cloud",
        message: "Skipped (current model: gpt-5.6-sol)",
      },
      {
        kind: "intentional-filter",
        label: "OpenRouter",
        message: "Skipped (current model: gpt-5.6-sol)",
      },
    ]);
  });

  it("normalizes provider-only session metadata before matching providers", () => {
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: { id: "minimax-china-coding-plan" } as any,
        currentProviderID: "minimax-cn-coding-plan",
      }),
    ).toBe(true);
  });

  it("selects an explicit OpenAI provider for an unprefixed OpenAI model", () => {
    const openaiProvider = {
      ...testProvider("openai"),
      matchesCurrentModel: vi.fn().mockReturnValue(false),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: openaiProvider,
        currentProviderID: "openai",
        currentModel: "gpt-5.6-sol",
      }),
    ).toBe(true);
    expect(openaiProvider.matchesCurrentModel).not.toHaveBeenCalled();
  });

  it.each([
    ["chatgpt", "openai"],
    ["codex", "openai"],
    ["chutes-ai", "chutes"],
  ])("selects the catalog provider for runtime alias %s", (currentProviderID, providerId) => {
    const provider = {
      ...testProvider(providerId),
      matchesCurrentModel: vi.fn().mockReturnValue(false),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider,
        currentProviderID,
        currentModel: "unprefixed-model-id",
      }),
    ).toBe(true);
    expect(provider.matchesCurrentModel).not.toHaveBeenCalled();
  });

  it.each([
    ["claude", "anthropic"],
    ["open-cursor", "cursor"],
    ["qwen", "qwen-code"],
    ["alibaba", "alibaba-coding-plan"],
  ])("fails closed for normalization-only provider synonym %s", (currentProviderID, providerId) => {
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: testProvider(providerId),
        currentProviderID,
        currentModel: "unprefixed-model-id",
      }),
    ).toBe(false);
  });

  it.each([
    ["gemini-2.5-pro", "google-gemini-cli"],
    ["antigravity-claude-sonnet", "google-antigravity"],
  ])("uses model matching to disambiguate the shared google runtime ID for %s", (currentModel, selectedProviderId) => {
    const antigravityProvider = {
      ...testProvider("google-antigravity"),
      matchesCurrentModel: vi.fn((model: string) => model === "google/antigravity-claude-sonnet"),
    };
    const geminiProvider = {
      ...testProvider("google-gemini-cli"),
      matchesCurrentModel: vi.fn((model: string) => model === "google/gemini-2.5-pro"),
    };

    for (const provider of [antigravityProvider, geminiProvider]) {
      expect(
        matchesQuotaProviderCurrentSelection({
          provider,
          currentProviderID: "google",
          currentModel,
        }),
      ).toBe(provider.id === selectedProviderId);
      expect(provider.matchesCurrentModel).toHaveBeenCalledWith(`google/${currentModel}`, {
        enabledProviders: "auto",
        currentProviderID: "google",
      });
    }
  });

  it("does not let Gemini CLI claim an Antigravity model containing gemini", () => {
    const selection = {
      currentProviderID: "google",
      currentModel: "antigravity-gemini-3-pro",
    };

    expect(
      matchesQuotaProviderCurrentSelection({ provider: googleAntigravityProvider, ...selection }),
    ).toBe(true);
    expect(
      matchesQuotaProviderCurrentSelection({ provider: googleGeminiCliProvider, ...selection }),
    ).toBe(false);
  });

  it("fails closed for an unknown explicit provider ID instead of broad model matching", () => {
    const openaiProvider = {
      ...testProvider("openai"),
      matchesCurrentModel: vi.fn().mockReturnValue(true),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: openaiProvider,
        currentProviderID: "private-openai-compatible-gateway",
        currentModel: "openai/gpt-5.6-sol",
      }),
    ).toBe(false);
    expect(openaiProvider.matchesCurrentModel).not.toHaveBeenCalled();
  });

  it("does not select OpenAI for an explicit OpenRouter provider with an OpenAI-looking model", () => {
    const openaiProvider = {
      ...testProvider("openai"),
      matchesCurrentModel: vi.fn().mockReturnValue(true),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: openaiProvider,
        currentProviderID: "openrouter",
        currentModel: "openai/gpt-5.6-sol",
      }),
    ).toBe(false);
    expect(openaiProvider.matchesCurrentModel).not.toHaveBeenCalled();
  });

  it("passes explicit enabledProviders context into current-model matching", () => {
    const provider = {
      id: "minimax-china-coding-plan",
      matchesCurrentModel: vi.fn().mockReturnValue(true),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: provider as any,
        currentModel: "minimax/MiniMax-M2.7",
        enabledProviders: ["minimax-china-coding-plan"],
      }),
    ).toBe(true);
    expect(provider.matchesCurrentModel).toHaveBeenCalledWith("minimax/MiniMax-M2.7", {
      enabledProviders: ["minimax-china-coding-plan"],
    });
  });

  it("keeps model-level matching for quota providers that share a provider ID", () => {
    const quotaProviders = [
      {
        id: "wide",
        providerId: "company",
        label: "Wide",
        mode: "remote-api",
        url: "https://wide.example/accounting",
        format: "quota-v1" as const,
      },
      {
        id: "model",
        providerId: "company",
        label: "Model",
        mode: "remote-api",
        url: "https://model.example/accounting",
        format: "quota-v1" as const,
        modelIds: ["model-a"],
      },
    ];
    const provider = {
      id: "quota-providers",
      matchesCurrentModel: vi
        .fn()
        .mockImplementation(
          (model: string, context: any) =>
            context.currentProviderID === "company" &&
            context.quotaProviders.some(
              (source: any) =>
                source.providerId === "company" &&
                (source.modelIds === undefined || source.modelIds.includes(model)),
            ),
        ),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: provider as any,
        currentModel: "model-a",
        currentProviderID: "company",
        quotaProviders,
      }),
    ).toBe(true);
    expect(provider.matchesCurrentModel).toHaveBeenCalledWith("model-a", {
      enabledProviders: "auto",
      currentProviderID: "company",
      quotaProviders,
    });
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: provider as any,
        currentProviderID: "company",
        quotaProviders,
      }),
    ).toBe(true);
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: provider as any,
        currentProviderID: "other",
        quotaProviders,
      }),
    ).toBe(false);
  });

  it("reuses one canonical provider snapshot across single-window and all-window renders without mutation bleed", async () => {
    const syntheticProvider = testProvider("synthetic", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Synthetic 5h",
          group: "Synthetic",
          label: "5h:",
          percentRemaining: 75,
          right: "26/100",
          resetTimeIso: "2026-01-20T18:12:03.000Z",
        },
        {
          accounting: TEST_ACCOUNTING,
          name: "Synthetic Weekly",
          group: "Synthetic",
          label: "Weekly:",
          percentRemaining: 8,
          right: "$22/$24",
          resetTimeIso: "2026-01-27T18:12:03.000Z",
        },
      ],
      presentation: {
        singleWindowShowRight: true,
      },
    });

    mockProviders.push(syntheticProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["synthetic"],
        minIntervalMs: 60_000,
      }),
      surfaceExplicitProviderIssues: true,
    };

    const singleWindow = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "[Synthetic] Weekly",
        percentRemaining: 8,
        right: "$22/$24",
        resetTimeIso: "2026-01-27T18:12:03.000Z",
      },
    ]);

    const firstEntry = singleWindow.data?.entries[0];
    if (!firstEntry || firstEntry.kind === "value") {
      throw new Error("expected single-window synthetic percent entry");
    }
    firstEntry.right = "0/500";
    firstEntry.percentRemaining = 100;

    const grouped = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "allWindows",
    });

    expect(grouped.data?.entries).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "Synthetic 5h",
        group: "Synthetic",
        label: "5h:",
        percentRemaining: 75,
        right: "26/100",
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
      {
        accounting: TEST_ACCOUNTING,
        name: "Synthetic Weekly",
        group: "Synthetic",
        label: "Weekly:",
        percentRemaining: 8,
        right: "$22/$24",
        resetTimeIso: "2026-01-27T18:12:03.000Z",
      },
    ]);
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("reprojects one immutable cached semantic snapshot across detail changes and refreshes normally at TTL zero", async () => {
    const provider = testProvider("synthetic", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
          name: "Monthly quota",
          group: "Semantic",
          percentRemaining: 75,
          semantic: {
            metric: { kind: "window", window: "month" },
            prominence: "primary",
          },
          basis: {
            remaining: {
              quantity: { decimal: "75", unit: { kind: "count", unit: "credit" } },
              authority: "provider_reported",
            },
          },
        },
        {
          accounting: {
            ...TEST_ACCOUNTING,
            resultType: "balance",
            sourceId: "account-a",
          },
          kind: "quantity",
          name: "Balance",
          group: "Semantic",
          quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
          semantic: {
            metric: { kind: "component", component: "total_balance" },
            prominence: "supplementary",
          },
        },
        {
          accounting: TEST_ACCOUNTING,
          kind: "value",
          name: "Legacy status",
          value: "Ready",
        },
      ],
    });

    const baseConfig = {
      enabledProviders: ["synthetic"],
      minIntervalMs: 60_000,
    } as const;
    const summary = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ ...baseConfig, accountingDetail: "summary" }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
    });
    expect(summary.data?.entries.map((entry) => entry.name)).toEqual([
      "Monthly quota",
      "Legacy status",
    ]);

    const projectedPercent = summary.data?.entries[0];
    if (
      !projectedPercent ||
      !("percentRemaining" in projectedPercent) ||
      !projectedPercent.semantic ||
      !projectedPercent.basis?.remaining
    ) {
      throw new Error("expected projected semantic percentage with remaining basis");
    }
    projectedPercent.semantic.metric = { kind: "aggregate" };
    projectedPercent.basis.remaining.quantity.decimal = "1";

    const detailed = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ ...baseConfig, accountingDetail: "detailed" }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
    });
    expect(detailed.data?.entries.map((entry) => entry.name)).toEqual([
      "Monthly quota",
      "Balance",
      "Legacy status",
    ]);
    const detailedPercent = detailed.data?.entries[0];
    if (!detailedPercent || !("percentRemaining" in detailedPercent)) {
      throw new Error("expected detailed semantic percentage");
    }
    expect(detailedPercent.semantic?.metric).toEqual({ kind: "window", window: "month" });
    expect(detailedPercent.basis?.remaining?.quantity.decimal).toBe("75");
    expect(provider.fetch).toHaveBeenCalledTimes(1);

    await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({
        ...baseConfig,
        accountingDetail: "detailed",
        minIntervalMs: 0,
      }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
    });
    expect(provider.fetch).toHaveBeenCalledTimes(2);
  });

  it("partitions semantic single-window percentages by source and result while retaining non-window facts", async () => {
    const provider = testProvider("synthetic", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
          name: "A weekly quota",
          group: "Semantic",
          percentRemaining: 30,
          semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
          name: "A daily quota",
          group: "Semantic",
          percentRemaining: 30,
          semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "budget", sourceId: "account-a" },
          name: "A monthly budget",
          group: "Semantic",
          percentRemaining: 40,
          semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "budget", sourceId: "account-a" },
          name: "A yearly budget",
          group: "Semantic",
          percentRemaining: 20,
          semantic: { metric: { kind: "window", window: "year" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-b" },
          name: "B daily quota",
          group: "Semantic",
          percentRemaining: 15,
          semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "spend", sourceId: "account-a" },
          name: "Known spend",
          group: "Semantic",
          percentRemaining: 90,
          semantic: { metric: { kind: "named", name: "Known API" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "balance", sourceId: "account-a" },
          kind: "quantity",
          name: "USD balance",
          group: "Semantic",
          quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } },
          semantic: {
            metric: { kind: "component", component: "total_balance" },
            prominence: "primary",
          },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "balance", sourceId: "account-a" },
          kind: "quantity",
          name: "CNY balance",
          group: "Semantic",
          quantity: { decimal: "20", unit: { kind: "currency", code: "CNY" } },
          semantic: {
            metric: { kind: "component", component: "total_balance" },
            prominence: "primary",
          },
        },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["synthetic"],
        accountingDetail: "detailed",
      }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });

    const entries = result.data?.entries ?? [];
    expect(entries).toHaveLength(6);
    expect(
      entries.map((entry) => ({
        resultType: entry.accounting.resultType,
        sourceId: entry.accounting.sourceId,
        metric: entry.semantic?.metric,
        unit: entry.kind === "quantity" ? entry.quantity.unit : undefined,
      })),
    ).toEqual([
      {
        resultType: "quota",
        sourceId: "account-a",
        metric: { kind: "window", window: "day" },
        unit: undefined,
      },
      {
        resultType: "quota",
        sourceId: "account-b",
        metric: { kind: "window", window: "day" },
        unit: undefined,
      },
      {
        resultType: "budget",
        sourceId: "account-a",
        metric: { kind: "window", window: "year" },
        unit: undefined,
      },
      {
        resultType: "spend",
        sourceId: "account-a",
        metric: { kind: "named", name: "Known API" },
        unit: undefined,
      },
      {
        resultType: "balance",
        sourceId: "account-a",
        metric: { kind: "component", component: "total_balance" },
        unit: { kind: "currency", code: "USD" },
      },
      {
        resultType: "balance",
        sourceId: "account-a",
        metric: { kind: "component", component: "total_balance" },
        unit: { kind: "currency", code: "CNY" },
      },
    ]);
  });

  it("sorts semantic rows only inside contiguous runs and keeps legacy anchors fixed", async () => {
    const provider = testProvider("synthetic", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
          kind: "quantity",
          name: "Balance",
          quantity: { decimal: "1", unit: { kind: "currency", code: "USD" } },
          semantic: {
            metric: { kind: "component", component: "total_balance" },
            prominence: "primary",
          },
        },
        {
          accounting: TEST_ACCOUNTING,
          name: "Quota",
          percentRemaining: 50,
          semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "legacy-one" },
          kind: "value",
          name: "Legacy anchor one",
          value: "one",
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
          kind: "quantity",
          name: "Spend",
          quantity: { decimal: "2", unit: { kind: "currency", code: "USD" } },
          semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "usage" },
          kind: "quantity",
          name: "Usage",
          quantity: { decimal: "3", unit: { kind: "count", unit: "token" } },
          semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "legacy-two" },
          kind: "value",
          name: "Legacy anchor two",
          value: "two",
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
          kind: "quantity",
          name: "First tied balance",
          quantity: { decimal: "4", unit: { kind: "currency", code: "USD" } },
          semantic: { metric: { kind: "named", name: "First" }, prominence: "primary" },
        },
        {
          accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
          kind: "quantity",
          name: "Second tied balance",
          quantity: { decimal: "5", unit: { kind: "currency", code: "USD" } },
          semantic: { metric: { kind: "named", name: "Second" }, prominence: "primary" },
        },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["synthetic"], accountingDetail: "detailed" }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [provider],
    });

    expect(result.data?.entries.map((entry) => entry.name)).toEqual([
      "Quota",
      "Balance",
      "Legacy anchor one",
      "Usage",
      "Spend",
      "Legacy anchor two",
      "First tied balance",
      "Second tied balance",
    ]);

    const singleWindow = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["synthetic"], accountingDetail: "detailed" }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });
    expect(singleWindow.data?.entries.map((entry) => entry.name)).toEqual([
      "[Quota]",
      "[Balance]",
      "[Legacy anchor one]",
      "[Usage]",
      "[Spend]",
      "[Legacy anchor two]",
      "[First tied balance]",
      "[Second tied balance]",
    ]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("suppresses a redundant Antigravity family only in render projections", async () => {
    const aliceAccounting = { ...TEST_ACCOUNTING, sourceId: "alice@example.com" };
    const bobAccounting = { ...TEST_ACCOUNTING, sourceId: "bob@example.com" };
    const googleProvider = testProvider("google-antigravity", {
      entries: [
        {
          accounting: aliceAccounting,
          name: "Antigravity (ali…): Claude",
          group: "[Antigravity (ali…)]",
          label: "Claude:",
          metricLabel: "Claude:",
          percentRemaining: 12,
          resetTimeIso: "2026-01-01T12:00:00.000Z",
        },
        {
          accounting: bobAccounting,
          name: "Antigravity (bob…): Claude",
          group: "[Antigravity (bob…)]",
          label: "Claude:",
          metricLabel: "Claude:",
          percentRemaining: 83,
          resetTimeIso: "2026-01-01T08:00:00.000Z",
        },
      ],
      presentation: { classicStrategy: "preserve", redundantQuotaFamily: "Claude" },
    });

    mockProviders.push(googleProvider);
    const baseParams = {
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["google-antigravity"],
        minIntervalMs: 60_000,
      }),
      surfaceExplicitProviderIssues: true,
    };

    const singleWindow = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries).toEqual([
      {
        accounting: aliceAccounting,
        name: "[Antigravity (ali…)]",
        percentRemaining: 12,
        resetTimeIso: "2026-01-01T12:00:00.000Z",
      },
      {
        accounting: bobAccounting,
        name: "[Antigravity (bob…)]",
        percentRemaining: 83,
        resetTimeIso: "2026-01-01T08:00:00.000Z",
      },
    ]);

    const allWindows = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "allWindows",
    });
    expect(allWindows.data?.entries).toEqual([
      {
        accounting: aliceAccounting,
        name: "Antigravity (ali…)",
        group: "[Antigravity (ali…)]",
        label: undefined,
        metricLabel: "Quota",
        percentRemaining: 12,
        resetTimeIso: "2026-01-01T12:00:00.000Z",
      },
      {
        accounting: bobAccounting,
        name: "Antigravity (bob…)",
        group: "[Antigravity (bob…)]",
        label: undefined,
        metricLabel: "Quota",
        percentRemaining: 83,
        resetTimeIso: "2026-01-01T08:00:00.000Z",
      },
    ]);
    expect(googleProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("projects Gemini quality tiers as bottleneck-only in single-window and all rows in all-windows", async () => {
    const geminiAccounting = { ...TEST_ACCOUNTING, sourceId: "alice@example.com" };
    const geminiProvider = testProvider("google-gemini-cli", {
      entries: [
        {
          accounting: geminiAccounting,
          name: "Gemini Pro (ali…)",
          group: "Gemini CLI (ali…)",
          label: "Gemini Pro:",
          percentRemaining: 45,
          right: "50 left",
          resetTimeIso: "2026-01-01T12:00:00.000Z",
        },
        {
          accounting: geminiAccounting,
          name: "Gemini Flash (ali…)",
          group: "Gemini CLI (ali…)",
          label: "Gemini Flash:",
          percentRemaining: 12,
          right: "20 left",
          resetTimeIso: "2026-01-01T08:00:00.000Z",
        },
        {
          accounting: geminiAccounting,
          name: "Gemini Flash Lite (ali…)",
          group: "Gemini CLI (ali…)",
          label: "Gemini Flash Lite:",
          percentRemaining: 30,
          right: "25 left",
          resetTimeIso: "2026-01-01T06:00:00.000Z",
        },
      ],
      presentation: {
        singleWindowDisplayName: "Gemini CLI",
        singleWindowShowRight: true,
      },
    });

    mockProviders.push(geminiProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["google-gemini-cli"],
        minIntervalMs: 60_000,
      }),
      surfaceExplicitProviderIssues: true,
    };

    const singleWindow = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries).toEqual([
      {
        accounting: geminiAccounting,
        name: "[Gemini CLI] (ali…)",
        percentRemaining: 12,
        right: "20 left",
        resetTimeIso: "2026-01-01T08:00:00.000Z",
      },
    ]);

    const allWindows = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "allWindows",
    });
    expect(allWindows.data?.entries).toEqual([
      {
        accounting: geminiAccounting,
        name: "Gemini Pro (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Pro:",
        percentRemaining: 45,
        right: "50 left",
        resetTimeIso: "2026-01-01T12:00:00.000Z",
      },
      {
        accounting: geminiAccounting,
        name: "Gemini Flash (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Flash:",
        percentRemaining: 12,
        right: "20 left",
        resetTimeIso: "2026-01-01T08:00:00.000Z",
      },
      {
        accounting: geminiAccounting,
        name: "Gemini Flash Lite (ali…)",
        group: "Gemini CLI (ali…)",
        label: "Gemini Flash Lite:",
        percentRemaining: 30,
        right: "25 left",
        resetTimeIso: "2026-01-01T06:00:00.000Z",
      },
    ]);
    expect(geminiProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps live-local providers uncached and returns snapshot-owned entries", async () => {
    const cursorProvider = testProvider("cursor", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Cursor API (Pro)",
          group: "Cursor (Pro)",
          label: "API:",
          right: "$5.00/$20.00",
          percentRemaining: 75,
          resetTimeIso: "2026-03-01T00:00:00.000Z",
        },
        {
          kind: "value",
          accounting: TEST_ACCOUNTING,
          name: "Cursor Auto+Composer",
          group: "Cursor (Pro)",
          label: "Auto+Composer:",
          value: "$1.25 used",
          resetTimeIso: "2026-03-01T00:00:00.000Z",
        },
      ],
    });

    mockProviders.push(cursorProvider);

    const params = {
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["cursor"],
        minIntervalMs: 60_000,
      }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow" as const,
    };

    const first = await collectQuotaRenderData(params);
    const firstEntry = first.data?.entries[0];
    if (!firstEntry || firstEntry.kind === "value") {
      throw new Error("expected single-window cursor percent entry");
    }
    firstEntry.percentRemaining = 1;

    const second = await collectQuotaRenderData(params);
    expect(second.data?.entries).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "[Cursor] (Pro)",
        percentRemaining: 75,
        resetTimeIso: "2026-03-01T00:00:00.000Z",
      },
    ]);
    expect(cursorProvider.fetch).toHaveBeenCalledTimes(2);
  });

  it("collects raw live probes in order and bypasses shared cache reuse", async () => {
    const syntheticProvider = testProvider("synthetic", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Synthetic Weekly",
          group: "Synthetic",
          label: "Weekly:",
          percentRemaining: 84,
          right: "$8/$50",
          resetTimeIso: "2026-04-21T18:00:00.000Z",
        },
      ],
      presentation: {
        singleWindowShowRight: true,
      },
    });
    const openaiProvider = testProvider("openai", {
      errors: [{ label: "OpenAI", message: "Temporary outage" }],
      presentation: {
        singleWindowDisplayName: "OpenAI",
      },
    });

    const params = {
      client: TEST_CLIENT,
      config: renderConfig({ minIntervalMs: 60_000 }),
      providers: [syntheticProvider, openaiProvider],
    };

    const first = await collectQuotaStatusLiveProbes(params);
    const second = await collectQuotaStatusLiveProbes(params);

    expect(first).toEqual([
      {
        providerId: "synthetic",
        result: {
          attempted: true,
          entries: [
            {
              accounting: TEST_ACCOUNTING,
              name: "Synthetic Weekly",
              group: "Synthetic",
              label: "Weekly:",
              percentRemaining: 84,
              right: "$8/$50",
              resetTimeIso: "2026-04-21T18:00:00.000Z",
            },
          ],
          errors: [],
          presentation: {
            singleWindowShowRight: true,
          },
        },
      },
      {
        providerId: "openai",
        result: {
          attempted: true,
          entries: [],
          errors: [{ label: "OpenAI", message: "Temporary outage" }],
          presentation: {
            singleWindowDisplayName: "OpenAI",
          },
        },
      },
    ]);
    expect(second).toEqual(first);
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(2);
    expect(openaiProvider.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches an available but disabled provider once and preserves its status details", async () => {
    const firstProvider = testProvider("synthetic", {
      attempted: false,
      statusDetails: [{ key: "api_key_source", value: "opencode.db" }],
      rawDetails: [{ key: "usage_usd", value: "$2.50" }],
    });
    const duplicateProvider = testProvider("synthetic", {
      errors: [{ label: "Synthetic", message: "must not be used" }],
    });

    const probes = await collectQuotaStatusLiveProbes({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["openai"] }),
      providers: [firstProvider, duplicateProvider],
    });

    expect(probes).toEqual([
      {
        providerId: "synthetic",
        result: {
          attempted: false,
          entries: [],
          errors: [],
          statusDetails: [{ key: "api_key_source", value: "opencode.db" }],
          rawDetails: [{ key: "usage_usd", value: "$2.50" }],
        },
      },
      {
        providerId: "synthetic",
        result: {
          attempted: false,
          entries: [],
          errors: [],
          statusDetails: [{ key: "api_key_source", value: "opencode.db" }],
          rawDetails: [{ key: "usage_usd", value: "$2.50" }],
        },
      },
    ]);
    expect(firstProvider.fetch).toHaveBeenCalledOnce();
    expect(duplicateProvider.fetch).not.toHaveBeenCalled();
  });

  it("keeps raw family metadata in quota status live probes", async () => {
    const accounting = { ...TEST_ACCOUNTING, sourceId: "alice@example.com" };
    const provider = testProvider("google-antigravity", {
      entries: [
        {
          accounting,
          name: "Antigravity (ali…): Claude",
          group: "[Antigravity (ali…)]",
          label: "Claude:",
          metricLabel: "Claude",
          percentRemaining: 64,
        },
      ],
      presentation: {
        classicStrategy: "preserve",
        redundantQuotaFamily: "Claude",
      },
    });

    const probes = await collectQuotaStatusLiveProbes({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["google-antigravity"] }),
      providers: [provider],
    });

    expect(probes[0]?.result.entries).toEqual([
      {
        accounting,
        name: "Antigravity (ali…): Claude",
        group: "[Antigravity (ali…)]",
        label: "Claude:",
        metricLabel: "Claude",
        percentRemaining: 64,
      },
    ]);
  });

  it("selects one limiting percent or first value row per ordered source identity", async () => {
    const accounting = (sourceId: string) => ({ ...TEST_ACCOUNTING, sourceId });
    const provider = testProvider("source-aggregate", {
      entries: [
        {
          accounting: accounting("first"),
          name: "Shared label",
          group: "Shared label",
          label: "Daily:",
          percentRemaining: 60,
        },
        {
          accounting: accounting("first"),
          name: "Shared label",
          group: "Shared label",
          label: "Weekly:",
          percentRemaining: 20,
        },
        {
          accounting: accounting("second"),
          name: "Shared label",
          group: "Shared label",
          label: "Balance:",
          kind: "value" as const,
          value: "$4.00",
        },
        {
          accounting: accounting("second"),
          name: "Shared label",
          group: "Shared label",
          label: "Credits:",
          kind: "value" as const,
          value: "9 credits",
        },
      ],
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: [provider.id] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });

    expect(result.data?.entries).toEqual([
      {
        accounting: accounting("first"),
        name: "[Shared label] Weekly",
        percentRemaining: 20,
      },
      {
        accounting: accounting("second"),
        name: "[Shared label]",
        kind: "value",
        value: "$4.00",
      },
    ]);
  });

  it("keeps one labeled Google AGY result per account in single-window mode", async () => {
    const provider = testProvider("google-agy", {
      entries: [
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-alice" },
          name: "Gemini Models (ali…)",
          group: "AGY (ali…): Gemini",
          label: "Weekly:",
          sortPriority: 0,
          percentRemaining: 58,
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-alice" },
          name: "Gemini Models (ali…)",
          group: "AGY (ali…): Gemini",
          label: "5h:",
          sortPriority: 1,
          percentRemaining: 25,
        },
        {
          accounting: { ...TEST_ACCOUNTING, sourceId: "account-bob" },
          name: "Gemini Models (bob…)",
          group: "AGY (bob…): Gemini",
          label: "Weekly:",
          sortPriority: 0,
          percentRemaining: 80,
        },
      ],
      presentation: { singleWindowShowRight: true },
    });

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: [provider.id] }),
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
      providers: [provider],
    });

    expect(result.data?.entries.map((entry) => entry.name)).toEqual([
      "[AGY (ali…): Gemini] 5h",
      "[AGY (bob…): Gemini] Weekly",
    ]);
  });

  it("keeps the classic style id aligned with current presentation fields", async () => {
    const syntheticProvider = testProvider("synthetic", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Synthetic 5h",
          group: "Synthetic",
          label: "5h:",
          percentRemaining: 75,
          right: "26/100",
        },
        {
          accounting: TEST_ACCOUNTING,
          name: "Synthetic Weekly",
          group: "Synthetic",
          label: "Weekly:",
          percentRemaining: 8,
          right: "$22/$24",
        },
      ],
      presentation: {
        singleWindowDisplayName: "Synthetic",
        singleWindowShowRight: true,
      },
    });

    mockProviders.push(syntheticProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: renderConfig({
        enabledProviders: ["synthetic"],
        minIntervalMs: 60_000,
      }),
      surfaceExplicitProviderIssues: true,
    };

    const alias = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "classic",
    });
    const canonical = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });

    expect(alias.data?.entries).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "[Synthetic] Weekly",
        percentRemaining: 8,
        right: "$22/$24",
      },
    ]);
    expect(alias.data).toEqual(canonical.data);
  });
});
