import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  createSessionTokensModuleMock,
  getToastMessage,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-quota-command-tests";

type DialogCommand = "quota" | "pricing_refresh";

async function buildDialogOutput(params: {
  command?: DialogCommand;
  client: ReturnType<typeof createClient>;
  sessionID: string;
  arguments?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: params.command ?? "quota",
    arguments: params.arguments,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
    resolveSessionMeta: async (sessionID) => {
      const response = await params.client.session.get({ path: { id: sessionID } });
      return {
        modelID: response.data?.modelID,
        providerID: response.data?.providerID,
      };
    },
  });
  expect(params.client.session.prompt).not.toHaveBeenCalled();
  expect(result.state).toBe("output");
  return result.state === "output" ? result.output : "";
}

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

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/session-tokens.js", () =>
  createSessionTokensModuleMock(mocks.fetchSessionTokensForDisplay),
);

vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);

vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);

vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);

describe("/quota command behavior", () => {
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        enabled: true,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      },
      resetPluginState: true,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
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

    await QuotaToastPlugin({ client } as any);

    await buildDialogOutput({ client, sessionID: "session-init" });

    expect(mocks.loadConfig).toHaveBeenCalledWith(
      client,
      expect.any(Object),
      expect.objectContaining({ configRootDir: process.cwd() }),
    );
    expect(mocks.setPricingSnapshotSelection).toHaveBeenCalledWith("bundled");
    expect(mocks.setPricingSnapshotAutoRefresh).toHaveBeenCalledWith(7);
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
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
    const message = getToastMessage(client);
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
    const message = getToastMessage(client);
    expect(message).toContain("OpenAI: Skipped (current model: claude-3.7-sonnet)");
  });

  it("applies percentDisplayMode to idle-triggered toast output", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["copilot"],
      showOnIdle: true,
      showOnCompact: false,
      showOnQuestion: false,
      showSessionTokens: false,
      percentDisplayMode: "used",
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "Copilot",
            percentRemaining: 81,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
        ],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-idle-percent-display" },
      },
    } as any);

    expect(client.tui.showToast).toHaveBeenCalledTimes(1);
    const message = getToastMessage(client);
    expect(message).toContain("19% used");
    expect(message).not.toContain("81% left");
  });

  it("honors percentDisplayMode for /quota output", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["openai"],
      showOnQuestion: false,
      showSessionTokens: false,
      percentDisplayMode: "used",
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "OpenAI Pro", percentRemaining: 81 }],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({
      client,
      sessionID: "session-quota-percent-display-boundary",
    });
    expect(injected).toContain("19% used");
    expect(injected).not.toContain("81% left");
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-errors" });
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-fetch-failure" });
    expect(injected).toContain("Cursor: Failed to read quota data");
    expect(injected).not.toContain("Providers detected");
  });

  it("retries a toast provider fetch failure on a deferred timer with provider cache bypass", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadConfig.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        enabled: true,
        enabledProviders: ["openai"],
        showOnIdle: true,
        showOnCompact: false,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      });

      const provider = {
        id: "openai",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi
          .fn()
          .mockRejectedValueOnce(new Error("firewall warming up"))
          .mockResolvedValueOnce({
            attempted: true,
            entries: [{ name: "OpenAI Pro", percentRemaining: 72 }],
            errors: [],
          }),
      };
      mocks.getProviders.mockReturnValue([provider]);

      const { QuotaToastPlugin } = await import("../src/plugin.js");
      const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
      const hooks = await QuotaToastPlugin({ client } as any);

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-deferred-retry" },
        },
      } as any);

      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(client.tui.showToast).toHaveBeenCalledTimes(1);
      expect(getToastMessage(client, 0)).toContain("OpenAI: Failed to read quota data");

      await vi.advanceTimersByTimeAsync(3_000);

      expect(provider.fetch).toHaveBeenCalledTimes(2);
      expect(client.tui.showToast).toHaveBeenCalledTimes(2);
      expect(getToastMessage(client, 1)).toContain("72% left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a suppressed toast provider fetch failure when showOnBothFail is false", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadConfig.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        enabled: true,
        enabledProviders: ["openai"],
        showOnIdle: true,
        showOnCompact: false,
        showOnQuestion: false,
        showOnBothFail: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      });

      const provider = {
        id: "openai",
        isAvailable: vi.fn().mockResolvedValue(true),
        fetch: vi
          .fn()
          .mockRejectedValueOnce(new Error("startup network unavailable"))
          .mockResolvedValueOnce({
            attempted: true,
            entries: [{ name: "OpenAI Pro", percentRemaining: 61 }],
            errors: [],
          }),
      };
      mocks.getProviders.mockReturnValue([provider]);

      const { QuotaToastPlugin } = await import("../src/plugin.js");
      const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
      const hooks = await QuotaToastPlugin({ client } as any);

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-deferred-suppressed-error" },
        },
      } as any);

      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(client.tui.showToast).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(provider.fetch).toHaveBeenCalledTimes(2);
      expect(client.tui.showToast).toHaveBeenCalledTimes(1);
      expect(getToastMessage(client)).toContain("61% left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an explicit provider availability exception on a deferred timer", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadConfig.mockResolvedValueOnce({
        ...DEFAULT_CONFIG,
        enabled: true,
        enabledProviders: ["openai"],
        showOnIdle: true,
        showOnCompact: false,
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      });

      const provider = {
        id: "openai",
        isAvailable: vi
          .fn()
          .mockRejectedValueOnce(new Error("OpenCode auth not readable yet"))
          .mockResolvedValue(true),
        fetch: vi.fn().mockResolvedValue({
          attempted: true,
          entries: [{ name: "OpenAI Pro", percentRemaining: 58 }],
          errors: [],
        }),
      };
      mocks.getProviders.mockReturnValue([provider]);

      const { QuotaToastPlugin } = await import("../src/plugin.js");
      const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
      const hooks = await QuotaToastPlugin({ client } as any);

      await hooks.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-deferred-availability" },
        },
      } as any);

      expect(provider.isAvailable).toHaveBeenCalledTimes(1);
      expect(provider.fetch).not.toHaveBeenCalled();
      expect(client.tui.showToast).toHaveBeenCalledTimes(1);
      expect(getToastMessage(client, 0)).toContain("OpenAI: Unavailable (not detected)");

      await vi.advanceTimersByTimeAsync(3_000);

      expect(provider.isAvailable).toHaveBeenCalledTimes(2);
      expect(provider.fetch).toHaveBeenCalledTimes(1);
      expect(client.tui.showToast).toHaveBeenCalledTimes(2);
      expect(getToastMessage(client, 1)).toContain("58% left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("consumes a pending deferred retry immediately on the next lifecycle toast", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["openai"],
      showOnIdle: true,
      showOnCompact: true,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("opencode unavailable"))
        .mockResolvedValueOnce({
          attempted: true,
          entries: [{ name: "OpenAI Pro", percentRemaining: 66 }],
          errors: [],
        }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-deferred-lifecycle" },
      },
    } as any);
    await hooks.event?.({
      event: {
        type: "session.compacted",
        properties: { sessionID: "session-deferred-lifecycle" },
      },
    } as any);

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 1)).toContain("66% left");
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-cursor-empty" });
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-anthropic-empty" });
    expect(injected).toContain(
      "Anthropic: Quota unavailable via local Claude CLI or Claude OAuth fallback",
    );
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-anthropic-auto-empty" });
    expect(injected).toContain(
      "Anthropic: Quota unavailable via local Claude CLI or Claude OAuth fallback",
    );
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
    await QuotaToastPlugin({ client } as any);

    const injected = await buildDialogOutput({ client, sessionID: "session-filtered-out" });

    expect(provider.fetch).not.toHaveBeenCalled();
    expect(injected).toContain(
      "No enabled quota providers matched the current model: openai/gpt-5.",
    );
    expect(injected).not.toContain("Providers detected");
  });

  it("does not reuse shared /quota output after the current model changes in the same session", async () => {
    mocks.loadConfig.mockResolvedValue({
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

    await QuotaToastPlugin({ client } as any);

    const firstInjected = await buildDialogOutput({
      client,
      sessionID: "session-model-switch",
    });

    currentSession = { data: { modelID: "openai/gpt-4.1", providerID: "openai" } };

    const secondInjected = await buildDialogOutput({
      client,
      sessionID: "session-model-switch",
    });

    expect(firstInjected).toContain("95% left");
    expect(secondInjected).toContain(
      "No enabled quota providers matched the current model: openai/gpt-4.1.",
    );
    expect(secondInjected).not.toContain("95% left");
  });

  it("reuses shared quota-state across /quota sessions when render context matches", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      onlyCurrentModel: false,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ name: "OpenAI Pro", percentRemaining: 95 }],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    const firstOutput = await buildDialogOutput({ client, sessionID: "session-a" });
    const secondOutput = await buildDialogOutput({ client, sessionID: "session-b" });

    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(firstOutput).toContain("95% left");
    expect(secondOutput).toContain("95% left");
  });

  it("caches rendered DeepSeek value-only toast rows", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["deepseek"],
      showOnIdle: true,
      showOnCompact: false,
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "deepseek",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [{ kind: "value", name: "DeepSeek Balance", value: "$12.34" }],
        errors: [],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "deepseek-chat", providerID: "deepseek" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-deepseek-value" },
      },
    } as any);
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-deepseek-value" },
      },
    } as any);

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("$12.34");
    expect(getToastMessage(client, 1)).toContain("$12.34");
    expect(provider.isAvailable).toHaveBeenCalledTimes(1);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache rendered error-only toast results", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      enabledProviders: ["deepseek"],
      showOnIdle: true,
      showOnCompact: false,
      showOnQuestion: false,
      showOnBothFail: true,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    });

    const provider = {
      id: "deepseek",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [],
        errors: [{ label: "DeepSeek", message: "Failed to read quota data" }],
      }),
    };
    mocks.getProviders.mockReturnValue([provider]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "deepseek-chat", providerID: "deepseek" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-deepseek-error" },
      },
    } as any);
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-deepseek-error" },
      },
    } as any);

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("DeepSeek: Failed to read quota data");
    expect(getToastMessage(client, 1)).toContain("DeepSeek: Failed to read quota data");
    expect(provider.isAvailable).toHaveBeenCalledTimes(2);
  });

  it("keys toast throttling by session render context so sessions do not share cached output", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: true,
      onlyCurrentModel: true,
      showOnIdle: true,
      showOnCompact: false,
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
    const client = createClient();
    client.session.get = vi.fn().mockImplementation(async ({ path }: any) => {
      if (path.id === "session-a") {
        return { data: { modelID: "openai/gpt-5", providerID: "openai" } };
      }
      return { data: { modelID: "openai/gpt-4.1", providerID: "openai" } };
    });

    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-a" },
      },
    } as any);
    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "session-b" },
      },
    } as any);

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(getToastMessage(client, 0)).toContain("openai/gpt-5");
    expect(getToastMessage(client, 1)).toContain("openai/gpt-4.1");
    expect(getToastMessage(client, 0)).not.toContain("openai/gpt-4.1");
    expect(getToastMessage(client, 1)).not.toContain("openai/gpt-5");
  });

  it("keeps concurrent /quota session-token output isolated per session", async () => {
    mocks.loadConfig.mockResolvedValue({
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
    await QuotaToastPlugin({ client } as any);

    const firstRun = buildDialogOutput({ client, sessionID: "session-a" });
    const secondRun = buildDialogOutput({ client, sessionID: "session-b" });

    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        mocks.fetchSessionTokensForDisplay.mock.calls.length === 2 &&
        typeof resolveSessionA === "function" &&
        typeof resolveSessionB === "function"
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

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

    const sessionBOutput = await secondRun;
    const sessionAOutput = await firstRun;

    expect(sessionAOutput).toContain("session-a-model");
    expect(sessionAOutput).not.toContain("session-b-model");
    expect(sessionBOutput).toContain("session-b-model");
    expect(sessionBOutput).not.toContain("session-a-model");
  });

  it("keeps qwen local request-plan quota live across repeated /quota commands", async () => {
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
    await QuotaToastPlugin({ client } as any);

    await buildDialogOutput({ client, sessionID: "session-qwen" });
    const latest = await buildDialogOutput({ client, sessionID: "session-qwen" });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(latest).toContain("80% left");
  });

  it("keeps alibaba local request-plan quota live across repeated /quota commands", async () => {
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
    await QuotaToastPlugin({ client } as any);

    await buildDialogOutput({ client, sessionID: "session-alibaba" });
    const latest = await buildDialogOutput({ client, sessionID: "session-alibaba" });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
    expect(latest).toContain("60% left");
  });

  it("keeps cursor local usage live across repeated /quota commands", async () => {
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
    await QuotaToastPlugin({ client } as any);

    await buildDialogOutput({ client, sessionID: "session-cursor" });
    const latest = await buildDialogOutput({ client, sessionID: "session-cursor" });

    expect(provider.fetch).toHaveBeenCalledTimes(2);
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
    await QuotaToastPlugin({ client } as any);
    await Promise.resolve();
    await Promise.resolve();
    mocks.maybeRefreshPricingSnapshot.mockClear();

    const injected = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-pricing-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(injected).toContain("Pricing Refresh (/pricing_refresh)");
    expect(injected).toContain("- selection: configured=bundled active=bundled");
    expect(injected).toContain(
      "runtime snapshot refreshed locally, but active reports remain pinned to bundled pricing",
    );
  });

  it("rejects /pricing_refresh arguments", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    await QuotaToastPlugin({ client } as any);

    // Force first config load so deferred init completes before our assertion.
    await buildDialogOutput({ client, sessionID: "session-warmup" });
    await Promise.resolve();
    mocks.maybeRefreshPricingSnapshot.mockClear();

    const injected = await buildDialogOutput({
      command: "pricing_refresh",
      arguments: '{"force":false}',
      client,
      sessionID: "session-pricing-refresh-invalid",
    });

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(injected).toContain("Invalid arguments for /pricing_refresh");
    expect(injected).toContain("This command does not accept arguments.");
  });
});
