import { afterEach, describe, expect, it, vi } from "vitest";

const { mockProviders } = vi.hoisted(() => ({
  mockProviders: [] as any[],
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

import {
  collectQuotaRenderData,
  collectQuotaStatusLiveProbes,
} from "../src/lib/quota-render-data.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

describe("collectQuotaRenderData availability handling", () => {
  afterEach(() => {
    mockProviders.length = 0;
    vi.restoreAllMocks();
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
        entries: [{ name: "OpenAI", percentRemaining: 75 }],
        errors: [],
      }),
    };

    mockProviders.push(failingProvider, workingProvider);

    const result = await collectQuotaRenderData({
      client: {
        config: {
          providers: async () => ({ data: { providers: [] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["copilot", "openai"],
        showSessionTokens: false,
      },
      providerFetchCache: new Map(),
      surfaceExplicitProviderIssues: true,
      formatStyle: "classic",
    });

    expect(failingProvider.isAvailable).toHaveBeenCalledOnce();
    expect(workingProvider.isAvailable).toHaveBeenCalledOnce();
    expect(workingProvider.fetch).toHaveBeenCalledOnce();
    expect(result.availability).toEqual([
      { provider: failingProvider, ok: false },
      { provider: workingProvider, ok: true },
    ]);
    expect(result.active).toEqual([workingProvider]);
    expect(result.data).toEqual({
      entries: [{ name: "OpenAI", percentRemaining: 75 }],
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
      client: {
        config: {
          providers: async () => ({ data: { providers: [] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["copilot"],
        showSessionTokens: false,
      },
      providerFetchCache: new Map(),
      surfaceExplicitProviderIssues: true,
      formatStyle: "classic",
    });

    expect(result.availability).toEqual([{ provider: failingProvider, ok: false }]);
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
      client: {
        config: {
          providers: async () => ({ data: { providers: [] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: "auto",
        showSessionTokens: false,
      },
      providerFetchCache: new Map(),
      surfaceExplicitProviderIssues: true,
      formatStyle: "classic",
    });

    expect(result.availability).toEqual([{ provider: failingProvider, ok: false }]);
    expect(result.active).toEqual([]);
    expect(result.hasExplicitProviderIssues).toBe(false);
    expect(result.data).toBeNull();
  });

  it("returns snapshot-owned weekly rows so sidebar/runtime mutations cannot poison future live fetches", async () => {
    const sharedResult = {
      attempted: true,
      entries: [
        {
          name: "Cursor Weekly",
          percentRemaining: 8,
          right: "22/24",
          resetTimeIso: "2099-01-01T00:00:00.000Z",
        },
      ],
      errors: [],
    };
    const cursorProvider = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue(sharedResult),
    };

    mockProviders.push(cursorProvider);

    const providerFetchCache = new Map();
    const params = {
      client: {
        config: {
          providers: async () => ({ data: { providers: [] } }),
          get: async () => ({ data: {} }),
        },
      },
      config: {
        ...DEFAULT_CONFIG,
        enabledProviders: ["cursor"],
        showSessionTokens: false,
      },
      providerFetchCache,
      surfaceExplicitProviderIssues: true,
      formatStyle: "classic" as const,
    };

    const first = await collectQuotaRenderData(params);
    const firstEntry = first.data?.entries[0];
    expect(firstEntry).toBeDefined();
    if (!firstEntry || firstEntry.kind === "value") {
      throw new Error("expected percent entry for cursor weekly test");
    }

    firstEntry.right = "0/500";
    firstEntry.percentRemaining = 100;

    const second = await collectQuotaRenderData(params);
    const secondEntry = second.data?.entries[0];
    expect(secondEntry).toBeDefined();
    if (!secondEntry || secondEntry.kind === "value") {
      throw new Error("expected percent entry for cursor weekly test");
    }

    expect(secondEntry.right).toBe("22/24");
    expect(secondEntry.percentRemaining).toBe(8);
    expect(sharedResult.entries[0]?.right).toBe("22/24");
    expect(sharedResult.entries[0]?.percentRemaining).toBe(8);
    expect(cursorProvider.fetch).toHaveBeenCalledTimes(2);
  });

  it("collects per-provider live probes in order, forces classic formatting, and bypasses stale shared fetch cache entries", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockImplementation(async ({ config }: any) => {
        expect(config.formatStyle).toBe("classic");
        return {
          attempted: true,
          entries: [
            {
              name: "Synthetic",
              percentRemaining: 84,
              right: "8/50",
              resetTimeIso: "2026-04-21T18:00:00.000Z",
            },
          ],
          errors: [],
        };
      }),
    };
    const openaiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockImplementation(async ({ config }: any) => {
        expect(config.formatStyle).toBe("classic");
        return {
          attempted: true,
          entries: [],
          errors: [{ label: "OpenAI", message: "Temporary outage" }],
        };
      }),
    };

    const providerFetchCache = new Map();
    const client = {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    };
    const config = {
      ...DEFAULT_CONFIG,
      formatStyle: "grouped" as const,
      minIntervalMs: 60_000,
      showSessionTokens: false,
    };

    const first = await collectQuotaStatusLiveProbes({
      client,
      config,
      formatStyle: "classic",
      providers: [syntheticProvider, openaiProvider],
      providerFetchCache,
    });
    const second = await collectQuotaStatusLiveProbes({
      client,
      config,
      formatStyle: "classic",
      providers: [syntheticProvider, openaiProvider],
      providerFetchCache,
    });

    expect(first).toEqual([
      {
        providerId: "synthetic",
        result: {
          attempted: true,
          entries: [
            {
              name: "Synthetic",
              percentRemaining: 84,
              right: "8/50",
              resetTimeIso: "2026-04-21T18:00:00.000Z",
            },
          ],
          errors: [],
        },
      },
      {
        providerId: "openai",
        result: {
          attempted: true,
          entries: [],
          errors: [{ label: "OpenAI", message: "Temporary outage" }],
        },
      },
    ]);
    expect(second).toEqual(first);
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(2);
    expect(openaiProvider.fetch).toHaveBeenCalledTimes(2);
  });
});
