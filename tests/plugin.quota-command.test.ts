import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createPluginTestClient as createClient,
  makeQuotaToastTestConfig,
  resetPluginTestState,
  seedDefaultPricingMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
  fetchSessionTokensForDisplay: vi.fn(),
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
  createLoadConfigMeta: () => ({ source: "test", paths: [], networkSettingSources: {} }),
}));

vi.mock("../src/providers/registry.js", () => ({
  getProviders: mocks.getProviders,
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotMeta: mocks.getPricingSnapshotMeta,
  getPricingSnapshotSource: mocks.getPricingSnapshotSource,
  getRuntimePricingRefreshStatePath: mocks.getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath: mocks.getRuntimePricingSnapshotPath,
  maybeRefreshPricingSnapshot: mocks.maybeRefreshPricingSnapshot,
  setPricingSnapshotAutoRefresh: mocks.setPricingSnapshotAutoRefresh,
  setPricingSnapshotSelection: mocks.setPricingSnapshotSelection,
}));

vi.mock("../src/lib/session-tokens.js", () => ({
  fetchSessionTokensForDisplay: mocks.fetchSessionTokensForDisplay,
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

describe("/quota command behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPluginTestState();

    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      }),
    );
    mocks.getProviders.mockReturnValue([]);
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({ state: "none" });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
    mocks.fetchSessionTokensForDisplay.mockResolvedValue({
      sessionTokens: undefined,
      error: undefined,
    });
    seedDefaultPricingMocks(mocks);
  });

  it("applies pricing snapshot selection from config on first use", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();

    const hooks = await QuotaToastPlugin({ client } as any);

    // Config is deferred — trigger a command to force the first config load.
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-init",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.setPricingSnapshotSelection).toHaveBeenCalledWith("bundled");
    expect(mocks.setPricingSnapshotAutoRefresh).toHaveBeenCalledWith(7);
    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "init",
        snapshotSelection: "bundled",
      }),
    );
  });

  it("loads config before honoring the first session.idle trigger", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      showOnIdle: false,
      showOnCompact: false,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();

    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-idle" },
      },
    } as any);

    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "init",
        snapshotSelection: DEFAULT_CONFIG.pricingSnapshot.source,
      }),
    );
  });

  it("shows explicit provider availability errors in idle-triggered toasts", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["copilot"],
      showOnIdle: true,
      showOnCompact: false,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-idle-explicit-provider" },
      },
    } as any);

    expect(provider.fetch).not.toHaveBeenCalled();
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const message = client.tui.showToast.mock.calls[0]?.[0]?.body?.message ?? "";
    expect(message).toContain("Copilot: Unavailable (not detected)");
  });

  it("shows explicit current-model skip errors in idle-triggered toasts", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["openai"],
      onlyCurrentModel: true,
      showOnIdle: true,
      showOnCompact: false,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      matchesCurrentModel: vi.fn().mockReturnValue(false),
      isAvailable: vi.fn(),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({
      modelID: "claude-3.7-sonnet",
      providerID: "anthropic",
    });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-idle-model-filter" },
      },
    } as any);

    expect(provider.isAvailable).not.toHaveBeenCalled();
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const message = client.tui.showToast.mock.calls[0]?.[0]?.body?.message ?? "";
    expect(message).toContain("OpenAI: Skipped (current model: claude-3.7-sonnet)");
  });

  it("rewrites default_agent only when one zero-width-normalized key matches", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient() } as any);

    const uniqueMatch = {
      agent: {
        "\u200Bplanner": {},
        coder: {},
      },
      default_agent: "planner",
    };

    await hooks.config?.(uniqueMatch as any);
    expect(uniqueMatch.default_agent).toBe("\u200Bplanner");

    const ambiguousMatch = {
      agent: {
        "\u200Bplanner": {},
        "\u200Cplanner": {},
      },
      default_agent: "planner",
    };

    await hooks.config?.(ambiguousMatch as any);
    expect(ambiguousMatch.default_agent).toBe("planner");
  });

  it("renders provider errors even when no quota entries are returned", async () => {
    const provider = {
      id: "alibaba-coding-plan",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [
          { label: "Alibaba Coding Plan", message: "Unsupported Alibaba Coding Plan tier: max" },
        ],
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

  it("converts provider fetch failures into injected quota errors", async () => {
    const provider = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockRejectedValue(new Error("sqlite busy")),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "auto", providerID: "cursor" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-fetch-failure",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Cursor: Failed to read quota data");
    expect(injected).not.toContain("Providers detected");
  });

  it("reports explicit cursor providers with no local history as no local usage yet", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["cursor"],
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: false,
        entries: [],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "auto", providerID: "cursor" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-cursor-empty",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Cursor: No local usage yet");
    expect(injected).not.toContain("Cursor: Not configured");
  });

  it("reports explicit Anthropic providers with local auth but no exposed quota windows", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["anthropic"],
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "anthropic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: false,
        entries: [],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({
      modelID: "anthropic/claude-sonnet-4-5",
      providerID: "anthropic",
    });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-anthropic-empty",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Anthropic: Quota unavailable via local Claude CLI");
    expect(injected).not.toContain("Anthropic: Not configured");
  });

  it("reports Anthropic no-data guidance in auto mode when it is the only active provider", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: "auto",
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "anthropic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: false,
        entries: [],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({
      modelID: "anthropic/claude-sonnet-4-5",
      providerID: "anthropic",
    });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-anthropic-auto-empty",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Anthropic: Quota unavailable via local Claude CLI");
    expect(injected).not.toContain("Providers detected");
  });

  it("does not diagnose filtered providers as detected-but-empty when onlyCurrentModel excludes them", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      onlyCurrentModel: true,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "cursor",
      matchesCurrentModel: vi.fn((model?: string) => model === "cursor/auto"),
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-filtered-out",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(provider.fetch).not.toHaveBeenCalled();
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain(
      "No enabled quota providers matched the current model: openai/gpt-5.",
    );
    expect(injected).not.toContain("Providers detected");
  });

  it("does not reuse cached /quota output after the current model changes in the same session", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      onlyCurrentModel: true,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      matchesCurrentModel: vi.fn((model?: string) => model === "openai/gpt-5"),
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "OpenAI Pro", percentRemaining: 95 }],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    let currentSession = { data: { modelID: "openai/gpt-5", providerID: "openai" } };
    client.session.get = vi.fn().mockImplementation(async () => currentSession);

    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-model-switch",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    currentSession = { data: { modelID: "openai/gpt-4.1", providerID: "openai" } };

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-model-switch",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    const firstInjected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    const secondInjected = client.session.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text ?? "";

    expect(firstInjected).toContain("95% left");
    expect(secondInjected).toContain(
      "No enabled quota providers matched the current model: openai/gpt-4.1.",
    );
    expect(secondInjected).not.toContain("95% left");
  });

  it("uses one session snapshot for both /quota cache keys and rendered output", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      onlyCurrentModel: true,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      matchesCurrentModel: vi.fn(() => true),
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockImplementation(async ({ config }: any) => ({
        attempted: true,
        entries: [{ name: config.currentModel ?? "unknown-model", percentRemaining: 95 }],
        errors: [],
      })),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    let sessionReadCount = 0;
    client.session.get = vi.fn().mockImplementation(async () => {
      sessionReadCount += 1;
      if (sessionReadCount === 3) {
        return { data: { modelID: "openai/gpt-4.1", providerID: "openai" } };
      }
      return { data: { modelID: "openai/gpt-5", providerID: "openai" } };
    });

    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-snapshot-race",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-snapshot-race",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(2);
    const firstInjected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    const secondInjected = client.session.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text ?? "";

    expect(firstInjected).toContain("openai/gpt-5");
    expect(secondInjected).toContain("openai/gpt-5");
    expect(firstInjected).not.toContain("openai/gpt-4.1");
    expect(secondInjected).not.toContain("openai/gpt-4.1");
  });

  it("keeps concurrent /quota session-token output isolated per session", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      showOnQuestion: false,
      showSessionTokens: true,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "OpenAI Pro", percentRemaining: 88 }],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    let resolveSessionA: ((value: any) => void) | undefined;
    let resolveSessionB: ((value: any) => void) | undefined;
    mocks.fetchSessionTokensForDisplay.mockImplementation(
      ({ sessionID }: { sessionID: string }) =>
        new Promise((resolve) => {
          if (sessionID === "session-a") {
            resolveSessionA = resolve;
            return;
          }
          if (sessionID === "session-b") {
            resolveSessionB = resolve;
            return;
          }
          resolve({ sessionTokens: undefined, error: undefined });
        }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const hooks = await QuotaToastPlugin({ client } as any);

    const firstRun = hooks["command.execute.before"]?.({
      command: "quota",
      sessionID: "session-a",
    } as any);
    const secondRun = hooks["command.execute.before"]?.({
      command: "quota",
      sessionID: "session-b",
    } as any);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetchSessionTokensForDisplay).toHaveBeenCalledTimes(2);
    expect(resolveSessionA).toBeTypeOf("function");
    expect(resolveSessionB).toBeTypeOf("function");

    resolveSessionB?.({
      sessionTokens: {
        models: [{ modelID: "session-b-model", input: 222, output: 22 }],
        totalInput: 222,
        totalOutput: 22,
      },
      error: undefined,
    });
    resolveSessionA?.({
      sessionTokens: {
        models: [{ modelID: "session-a-model", input: 111, output: 11 }],
        totalInput: 111,
        totalOutput: 11,
      },
      error: undefined,
    });

    await expect(secondRun).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(firstRun).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    const promptOutputs = client.session.prompt.mock.calls.map((call) => ({
      sessionID: call?.[0]?.path?.id,
      text: call?.[0]?.body?.parts?.[0]?.text ?? "",
    }));
    const sessionAOutput =
      promptOutputs.find((output) => output.sessionID === "session-a")?.text ?? "";
    const sessionBOutput =
      promptOutputs.find((output) => output.sessionID === "session-b")?.text ?? "";

    expect(sessionAOutput).toContain("session-a-model");
    expect(sessionAOutput).not.toContain("session-b-model");
    expect(sessionBOutput).toContain("session-b-model");
    expect(sessionBOutput).not.toContain("session-a-model");
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
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({
      state: "qwen_free",
      accessToken: "token",
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "qwen-code/qwen3-coder-plus" });
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
    const client = createClient({ modelID: "alibaba/qwen3-coder-plus" });
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

  it("bypasses stale /quota cache for cursor local-usage sessions", async () => {
    const provider = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Cursor API (Pro)", percentRemaining: 95 }],
          errors: [],
        })
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "Cursor API (Pro)", percentRemaining: 90 }],
          errors: [],
        }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "auto", providerID: "cursor" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-cursor",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-cursor",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    const latest = client.session.prompt.mock.calls[1]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(latest).toContain("90% left");
  });

  it("runs /pricing_refresh with force=true by default and reports bundled pinning", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      pricingSnapshot: { source: "bundled", autoRefresh: 7 },
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });
    mocks.getPricingSnapshotSource.mockReturnValue("bundled");
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: {
        version: 1,
        updatedAt: Date.now(),
        lastResult: "success",
      },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    await Promise.resolve();
    await Promise.resolve();
    mocks.maybeRefreshPricingSnapshot.mockClear();

    await expect(
      hooks["command.execute.before"]?.({
        command: "pricing_refresh",
        sessionID: "session-pricing-refresh",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
    });
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Pricing Refresh (/pricing_refresh)");
    expect(injected).toContain("- selection: configured=bundled active=bundled");
    expect(injected).toContain(
      "runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
    );
  });

  it("rejects /pricing_refresh arguments", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    // Force first config load so deferred init completes before our assertion.
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-warmup",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await Promise.resolve();
    mocks.maybeRefreshPricingSnapshot.mockClear();
    client.session.prompt.mockClear();

    await expect(
      hooks["command.execute.before"]?.({
        command: "pricing_refresh",
        arguments: '{"force":false}',
        sessionID: "session-pricing-refresh-invalid",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    const injected = client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
    expect(injected).toContain("Invalid arguments for /pricing_refresh");
    expect(injected).toContain("This command does not accept arguments.");
  });
});
