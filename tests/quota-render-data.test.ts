import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "fs/promises";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-render-data-tests";

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
} from "../src/lib/quota-render-data.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

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
    const runtimeProvider = {
      id: "custom-runtime",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Custom Runtime Daily",
            group: "Custom Runtime",
            label: "Daily:",
            percentRemaining: 42,
          },
        ],
        errors: [],
      }),
    };

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["custom-runtime"],
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "allWindows",
      providers: [runtimeProvider],
    });

    expect(runtimeProvider.isAvailable).toHaveBeenCalledOnce();
    expect(runtimeProvider.fetch).toHaveBeenCalledOnce();
    expect(result.active).toEqual([runtimeProvider]);
    expect(result.data?.entries).toEqual([
      {
        name: "Custom Runtime Daily",
        group: "Custom Runtime",
        label: "Daily:",
        percentRemaining: 42,
      },
    ]);
  });

  it("treats a thrown availability probe as unavailable instead of rejecting the whole render", async () => {
    const failingProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      fetch: vi.fn(),
    };
    const workingProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "OpenAI (Pro) 5h",
            group: "OpenAI (Pro)",
            label: "5h:",
            percentRemaining: 75,
          },
        ],
        errors: [],
        presentation: {
          singleWindowDisplayName: "OpenAI (Pro)",
        },
      }),
    };

    mockProviders.push(failingProvider, workingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["copilot", "openai"],
        showSessionTokens: false,
      },
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
      entries: [{ name: "[OpenAI] (Pro) 5h", percentRemaining: 75 }],
      errors: [{ label: "Copilot", message: "Unavailable (not detected)" }],
      sessionTokens: undefined,
    });
  });

  it("surfaces explicit unavailable rows when every availability probe fails", async () => {
    const failingProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      fetch: vi.fn(),
    };

    mockProviders.push(failingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["copilot"],
        showSessionTokens: false,
      },
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
    const failingProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      fetch: vi.fn(),
    };

    mockProviders.push(failingProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: "auto",
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
      formatStyle: "singleWindow",
    });

    expect(result.availability).toEqual([{ provider: failingProvider, ok: false, error: true }]);
    expect(result.active).toEqual([]);
    expect(result.hasExplicitProviderIssues).toBe(false);
    expect(result.data).toBeNull();
  });

  it("waits for current model metadata before probing providers under onlyCurrentModel", async () => {
    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };

    mockProviders.push(provider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["copilot"],
        onlyCurrentModel: true,
        showSessionTokens: false,
      },
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
    const openaiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "OpenAI Weekly", percentRemaining: 55 }],
        errors: [],
      }),
    };
    const copilotProvider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };

    mockProviders.push(openaiProvider, copilotProvider);

    const result = await collectQuotaRenderData({
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["openai", "copilot"],
        onlyCurrentModel: true,
        showSessionTokens: false,
      },
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
    expect(result.data?.entries).toEqual([{ name: "OpenAI Weekly", percentRemaining: 55 }]);
  });

  it("reuses one canonical provider snapshot across single-window and all-window renders without mutation bleed", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Synthetic 5h",
            group: "Synthetic",
            label: "5h:",
            percentRemaining: 75,
            right: "26/100",
            resetTimeIso: "2026-01-20T18:12:03.000Z",
          },
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 8,
            right: "$22/$24",
            resetTimeIso: "2026-01-27T18:12:03.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowShowRight: true,
        },
      }),
    };

    mockProviders.push(syntheticProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["synthetic"],
        minIntervalMs: 60_000,
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
    };

    const singleWindow = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries).toEqual([
      {
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
        name: "Synthetic 5h",
        group: "Synthetic",
        label: "5h:",
        percentRemaining: 75,
        right: "26/100",
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
      {
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

  it("projects Gemini quality tiers as bottleneck-only in single-window and all rows in all-windows", async () => {
    const geminiProvider = {
      id: "google-gemini-cli",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Gemini Pro (ali..example)",
            group: "Gemini CLI",
            label: "Gemini Pro:",
            percentRemaining: 45,
            right: "50 left",
            resetTimeIso: "2026-01-01T12:00:00.000Z",
          },
          {
            name: "Gemini Flash (ali..example)",
            group: "Gemini CLI",
            label: "Gemini Flash:",
            percentRemaining: 12,
            right: "20 left",
            resetTimeIso: "2026-01-01T08:00:00.000Z",
          },
          {
            name: "Gemini Flash Lite (ali..example)",
            group: "Gemini CLI",
            label: "Gemini Flash Lite:",
            percentRemaining: 30,
            right: "25 left",
            resetTimeIso: "2026-01-01T06:00:00.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowDisplayName: "Gemini CLI",
          singleWindowShowRight: true,
        },
      }),
    };

    mockProviders.push(geminiProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["google-gemini-cli"],
        minIntervalMs: 60_000,
        showSessionTokens: false,
      },
      surfaceExplicitProviderIssues: true,
    };

    const singleWindow = await collectQuotaRenderData({
      ...baseParams,
      formatStyle: "singleWindow",
    });
    expect(singleWindow.data?.entries).toEqual([
      {
        name: "[Gemini CLI]",
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
        name: "Gemini Pro (ali..example)",
        group: "Gemini CLI",
        label: "Gemini Pro:",
        percentRemaining: 45,
        right: "50 left",
        resetTimeIso: "2026-01-01T12:00:00.000Z",
      },
      {
        name: "Gemini Flash (ali..example)",
        group: "Gemini CLI",
        label: "Gemini Flash:",
        percentRemaining: 12,
        right: "20 left",
        resetTimeIso: "2026-01-01T08:00:00.000Z",
      },
      {
        name: "Gemini Flash Lite (ali..example)",
        group: "Gemini CLI",
        label: "Gemini Flash Lite:",
        percentRemaining: 30,
        right: "25 left",
        resetTimeIso: "2026-01-01T06:00:00.000Z",
      },
    ]);
    expect(geminiProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps live-local providers uncached and returns snapshot-owned entries", async () => {
    const cursorProvider = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Cursor API (Pro)",
            group: "Cursor (Pro)",
            label: "API:",
            right: "$5.00/$20.00",
            percentRemaining: 75,
            resetTimeIso: "2026-03-01T00:00:00.000Z",
          },
          {
            kind: "value",
            name: "Cursor Auto+Composer",
            group: "Cursor (Pro)",
            label: "Auto+Composer:",
            value: "$1.25 used",
            resetTimeIso: "2026-03-01T00:00:00.000Z",
          },
        ],
        errors: [],
      }),
    };

    mockProviders.push(cursorProvider);

    const params = {
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["cursor"],
        minIntervalMs: 60_000,
        showSessionTokens: false,
      },
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
        name: "[Cursor] (Pro)",
        percentRemaining: 75,
        resetTimeIso: "2026-03-01T00:00:00.000Z",
      },
    ]);
    expect(cursorProvider.fetch).toHaveBeenCalledTimes(2);
  });

  it("collects live probes in order, projects them to single-window rows, and bypasses shared cache reuse", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
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
      }),
    };
    const openaiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [{ label: "OpenAI", message: "Temporary outage" }],
        presentation: {
          singleWindowDisplayName: "OpenAI",
        },
      }),
    };

    const params = {
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        minIntervalMs: 60_000,
        showSessionTokens: false,
      },
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

  it("keeps legacy style ids and presentation fields working for direct render-data calls", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Synthetic 5h",
            group: "Synthetic",
            label: "5h:",
            percentRemaining: 75,
            right: "26/100",
          },
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 8,
            right: "$22/$24",
          },
        ],
        errors: [],
        presentation: {
          classicDisplayName: "Synthetic",
          classicShowRight: true,
        },
      }),
    };

    mockProviders.push(syntheticProvider);

    const baseParams = {
      client: TEST_CLIENT,
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["synthetic"],
        minIntervalMs: 60_000,
        showSessionTokens: false,
      },
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
        name: "[Synthetic] Weekly",
        percentRemaining: 8,
        right: "$22/$24",
      },
    ]);
    expect(alias.data).toEqual(canonical.data);
  });
});
