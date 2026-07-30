import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import { rm } from "fs/promises";

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

  it("normalizes provider-only session metadata before matching providers", () => {
    expect(
      matchesQuotaProviderCurrentSelection({
        provider: { id: "minimax-china-coding-plan" } as any,
        currentProviderID: "minimax-cn-coding-plan",
      }),
    ).toBe(true);
  });

  it("uses currentModel matching when currentProviderID is also present", () => {
    const provider = {
      id: "openai",
      matchesCurrentModel: vi.fn().mockReturnValue(false),
    };

    expect(
      matchesQuotaProviderCurrentSelection({
        provider: provider as any,
        currentProviderID: "openai",
        currentModel: "anthropic/claude-sonnet-4",
      }),
    ).toBe(false);
    expect(provider.matchesCurrentModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4", {
      enabledProviders: "auto",
      currentProviderID: "openai",
    });
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

  it("selects quota providers by exact model and permits provider-only identity only for provider-wide sources", () => {
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
        modelIds: ["company/model-a"],
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
        currentModel: "company/model-a",
        currentProviderID: "company",
        quotaProviders,
      }),
    ).toBe(true);
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

  it("keeps two Antigravity accounts distinct in single-window and all-windows", async () => {
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
      presentation: { classicStrategy: "preserve" },
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
        name: "[Antigravity (ali…): Claude]",
        percentRemaining: 12,
        resetTimeIso: "2026-01-01T12:00:00.000Z",
      },
      {
        accounting: bobAccounting,
        name: "[Antigravity (bob…): Claude]",
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

  it("collects live probes in order, projects them to single-window rows, and bypasses shared cache reuse", async () => {
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
      formatStyle: "singleWindow" as const,
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
              name: "[Synthetic] Weekly",
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
      statusDetails: [{ key: "api_key_source", value: "auth.json" }],
    });
    const duplicateProvider = testProvider("synthetic", {
      errors: [{ label: "Synthetic", message: "must not be used" }],
    });

    const probes = await collectQuotaStatusLiveProbes({
      client: TEST_CLIENT,
      config: renderConfig({ enabledProviders: ["openai"] }),
      formatStyle: "singleWindow",
      providers: [firstProvider, duplicateProvider],
    });

    expect(probes).toEqual([
      {
        providerId: "synthetic",
        result: {
          attempted: false,
          entries: [],
          errors: [],
          statusDetails: [{ key: "api_key_source", value: "auth.json" }],
        },
      },
      {
        providerId: "synthetic",
        result: {
          attempted: false,
          entries: [],
          errors: [],
          statusDetails: [{ key: "api_key_source", value: "auth.json" }],
        },
      },
    ]);
    expect(firstProvider.fetch).toHaveBeenCalledOnce();
    expect(duplicateProvider.fetch).not.toHaveBeenCalled();
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

  it("keeps custom percent labels when projecting grouped plan names", async () => {
    const provider = testProvider("kilo", {
      entries: [
        {
          accounting: TEST_ACCOUNTING,
          name: "Kilo Credits",
          group: "[Kilo] Starter",
          label: "Credits:",
          percentRemaining: 100,
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
        accounting: TEST_ACCOUNTING,
        name: "[Kilo] (Starter) Credits",
        percentRemaining: 100,
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
