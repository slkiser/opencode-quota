import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => {
  const makeChain = () => {
    const chain: any = {};
    chain.optional = () => chain;
    chain.describe = () => chain;
    chain.int = () => chain;
    chain.min = () => chain;
    return chain;
  };

  const toolFn = ((definition: unknown) => definition) as any;
  toolFn.schema = {
    boolean: () => makeChain(),
    number: () => makeChain(),
  };

  return { tool: toolFn };
});

vi.mock("../src/lib/config.js", () => ({
  loadConfig: mocks.loadConfig,
  createLoadConfigMeta: () => ({ source: "test", paths: [] }),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: mocks.getProviders,
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  maybeRefreshPricingSnapshot: mocks.maybeRefreshPricingSnapshot,
}));

vi.mock("../src/lib/qwen-auth.js", () => ({
  isQwenCodeModelId: (model?: string) =>
    typeof model === "string" && model.toLowerCase().startsWith("qwen-code/"),
  resolveQwenLocalPlanCached: mocks.resolveQwenLocalPlanCached,
}));

vi.mock("../src/lib/alibaba-auth.js", () => ({
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5000,
  isAlibabaModelId: (model?: string) =>
    typeof model === "string" &&
    (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
  resolveAlibabaCodingPlanAuthCached: mocks.resolveAlibabaCodingPlanAuthCached,
}));

function createClient(modelID = "qwen-code/qwen3-coder-plus") {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: { modelID } }),
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

describe("/quota command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__opencodeQuotaCommandCache;

    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: true,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });
    mocks.getProviders.mockReturnValue([]);
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({ state: "none" });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: false,
      updated: false,
      state: { version: 1, updatedAt: Date.now() },
    });
  });

  it("renders provider errors even when no quota entries are returned", async () => {
    const provider = {
      id: "alibaba-coding-plan",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [{ label: "Alibaba Coding Plan", message: "Unsupported Alibaba Coding Plan tier: max" }],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-errors",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Alibaba Coding Plan: Unsupported Alibaba Coding Plan tier: max");
    expect(injected).not.toContain("Providers detected");
  });

  it("bypasses stale /quota cache for qwen local request-plan sessions", async () => {
    const provider = {
      id: "qwen-code",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Qwen Free", percentRemaining: 90 }],
          errors: [],
        })
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Qwen Free", percentRemaining: 80 }],
          errors: [],
        }),
    };
    mocks.getProviders.mockReturnValue([provider]);
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({ state: "qwen_free", accessToken: "token" });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient("qwen-code/qwen3-coder-plus");
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-qwen",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-qwen",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    const latest = client.session.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(latest).toContain("80% left");
  });

  it("bypasses stale /quota cache for alibaba local request-plan sessions", async () => {
    const provider = {
      id: "alibaba-coding-plan",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Alibaba Coding Plan (Lite) Weekly", percentRemaining: 70 }],
          errors: [],
        })
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Alibaba Coding Plan (Lite) Weekly", percentRemaining: 60 }],
          errors: [],
        }),
    };
    mocks.getProviders.mockReturnValue([provider]);
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "dashscope-key",
      tier: "lite",
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient("alibaba/qwen3-coder-plus");
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-alibaba",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-alibaba",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    const latest = client.session.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(latest).toContain("60% left");
  });
});
