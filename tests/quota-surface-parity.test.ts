import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";

function createSchemaChain() {
  const chain: any = {};
  chain.optional = () => chain;
  chain.describe = () => chain;
  chain.int = () => chain;
  chain.min = () => chain;
  return chain;
}

const { mockProviders } = vi.hoisted(() => ({
  mockProviders: [] as any[],
}));

vi.mock("@opencode-ai/plugin", () => {
  const toolFn = ((definition: unknown) => definition) as any;
  toolFn.schema = {
    boolean: () => createSchemaChain(),
    number: () => createSchemaChain(),
  };
  return { tool: toolFn };
});

vi.mock("../src/providers/registry.js", () => ({
  getProviders: () => mockProviders,
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  getPricingSnapshotMeta: () => ({
    source: "runtime",
    generatedAt: Date.UTC(2026, 0, 1),
    units: "USD per 1M tokens",
  }),
  getPricingSnapshotSource: () => "runtime",
  getRuntimePricingRefreshStatePath: () => "/tmp/refresh-state.json",
  getRuntimePricingSnapshotPath: () => "/tmp/pricing-runtime.json",
  maybeRefreshPricingSnapshot: vi.fn().mockResolvedValue({
    attempted: false,
    updated: false,
    state: { version: 1, updatedAt: Date.now() },
  }),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

function getPromptText(client: any): string {
  return client.session.prompt.mock.calls[0]?.[0]?.body?.parts?.[0]?.text ?? "";
}

function createClient(params: {
  config: Record<string, unknown>;
  sessionMeta: { modelID?: string; providerID?: string };
}) {
  return {
    config: {
      get: vi.fn().mockResolvedValue({
        data: {
          experimental: {
            quotaToast: params.config,
          },
        },
      }),
      providers: vi.fn().mockResolvedValue({
        data: {
          providers: mockProviders.map((provider) => ({ id: provider.id })),
        },
      }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: params.sessionMeta }),
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

async function resetQuotaStateForTests(): Promise<void> {
  const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
  __resetQuotaStateForTests();
}

describe("quota surface parity regressions", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let tempDir: string;
  let worktreeDir: string;
  let nestedDir: string;

  beforeEach(async () => {
    vi.resetModules();
    mockProviders.length = 0;
    await resetQuotaStateForTests();

    tempDir = mkdtempSync(join(tmpdir(), "opencode-quota-surface-parity-"));
    worktreeDir = join(tempDir, "worktree");
    nestedDir = join(worktreeDir, "packages", "feature");
    mkdirSync(nestedDir, { recursive: true });

    process.env.HOME = tempDir;
    process.env.XDG_CONFIG_HOME = join(tempDir, "xdg-config");
    process.env.XDG_DATA_HOME = join(tempDir, "xdg-data");
    process.env.XDG_CACHE_HOME = join(tempDir, "xdg-cache");
    process.env.XDG_STATE_HOME = join(tempDir, "xdg-state");

    process.chdir(worktreeDir);
  });

  afterEach(async () => {
    mockProviders.length = 0;
    await resetQuotaStateForTests();
    process.chdir(originalCwd);
    process.env = originalEnv;
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("uses the same effective worktree local root for plugin and sidebar in nested-directory sessions", async () => {
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
            percentRemaining: 64,
            right: "$16/$24",
            resetTimeIso: "2099-01-08T00:00:00.000Z",
          },
        ],
        errors: [],
      }),
    };
    mockProviders.push(syntheticProvider);

    // Stage 1 parity guard: both surfaces should resolve local config from worktree root,
    // not nested active directory config.
    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["synthetic"],
            formatStyle: "allWindows",
            showOnQuestion: false,
            showSessionTokens: false,
            minIntervalMs: 60_000,
          },
        },
      }),
      "utf8",
    );

    writeFileSync(
      join(nestedDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
            enabledProviders: [],
          },
        },
      }),
      "utf8",
    );

    const client = createClient({
      config: {
        enabled: false,
        enabledProviders: [],
      },
      sessionMeta: { modelID: "synthetic/default", providerID: "synthetic" },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-worktree-root-parity",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    const quotaOutput = getPromptText(client);
    expect(quotaOutput).toContain("64% left");

    await resetQuotaStateForTests();

    const { loadSidebarPanel } = await import("../src/lib/tui-runtime.js");
    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client,
      } as any,
      sessionID: "session-worktree-root-parity",
    });

    expect(panel.status).toBe("ready");
    expect(panel.lines.join("\n")).toContain("64% left");
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps workspace overrides for formerly global-authoritative settings aligned between plugin and sidebar", async () => {
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
            percentRemaining: 17,
            right: "$4/$24",
            resetTimeIso: "2099-01-08T00:00:00.000Z",
          },
        ],
        errors: [],
      }),
    };
    const openaiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "OpenAI Pro",
            group: "OpenAI",
            label: "Pro:",
            percentRemaining: 82,
            right: "82/100",
            resetTimeIso: "2099-01-08T00:00:00.000Z",
          },
        ],
        errors: [],
      }),
    };
    mockProviders.push(syntheticProvider, openaiProvider);

    const globalConfigDir = join(process.env.XDG_CONFIG_HOME!, "opencode");
    mkdirSync(globalConfigDir, { recursive: true });

    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["synthetic"],
            formatStyle: "allWindows",
            showOnQuestion: false,
            showSessionTokens: false,
            minIntervalMs: 60_000,
          },
        },
      }),
      "utf8",
    );

    writeFileSync(
      join(worktreeDir, "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: true,
            enabledProviders: ["openai"],
            formatStyle: "allWindows",
            showOnQuestion: false,
            showSessionTokens: false,
            minIntervalMs: 60_000,
          },
        },
      }),
      "utf8",
    );

    const client = createClient({
      config: {
        enabled: false,
        enabledProviders: ["synthetic"],
      },
      sessionMeta: { modelID: "openai/gpt-5", providerID: "openai" },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-layered-provider-override",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    const quotaOutput = getPromptText(client);
    expect(quotaOutput).toContain("82% left");
    expect(quotaOutput).not.toContain("17% left");

    await resetQuotaStateForTests();

    const { loadSidebarPanel } = await import("../src/lib/tui-runtime.js");
    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client,
      } as any,
      sessionID: "session-layered-provider-override",
    });

    expect(panel.status).toBe("ready");
    const sidebarOutput = panel.lines.join("\n");
    expect(sidebarOutput).toContain("82% left");
    expect(sidebarOutput).not.toContain("17% left");
    expect(openaiProvider.fetch).toHaveBeenCalledTimes(1);
    expect(syntheticProvider.fetch).not.toHaveBeenCalled();
  });

  it("keeps synthetic grouped numeric parity between real /quota and real sidebar from shared snapshot storage", async () => {
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
            percentRemaining: 44,
            right: "44/100",
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
          {
            name: "Synthetic Weekly",
            group: "Synthetic",
            label: "Weekly:",
            percentRemaining: 8,
            right: "$22/$24",
            resetTimeIso: "2099-01-08T00:00:00.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowShowRight: true,
        },
      }),
    };
    mockProviders.push(syntheticProvider);

    const sharedConfig = {
      enabled: true,
      enabledProviders: ["synthetic"],
      formatStyle: "allWindows",
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    };

    const client = createClient({
      config: sharedConfig,
      sessionMeta: { modelID: "synthetic/default", providerID: "synthetic" },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-synthetic-parity",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    const quotaOutput = getPromptText(client);
    expect(quotaOutput).toContain("44% left");
    expect(quotaOutput).toContain("8% left");

    // Force sidebar path to reuse persisted shared snapshot storage (not in-memory).
    await resetQuotaStateForTests();

    const { loadSidebarPanel } = await import("../src/lib/tui-runtime.js");
    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client,
      } as any,
      sessionID: "session-synthetic-parity",
    });

    expect(panel.status).toBe("ready");
    const sidebarOutput = panel.lines.join("\n");
    expect(sidebarOutput).toContain("44% left");
    expect(sidebarOutput).toContain("8% left");
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps intentional single-window-vs-all-windows non-parity while still sharing the same underlying snapshot", async () => {
    const openaiProvider = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            name: "OpenAI Pro 5h",
            group: "OpenAI (Pro)",
            label: "5h:",
            percentRemaining: 95,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
          {
            name: "OpenAI Pro Weekly",
            group: "OpenAI (Pro)",
            label: "Weekly:",
            percentRemaining: 40,
            resetTimeIso: "2099-01-08T00:00:00.000Z",
          },
        ],
        errors: [],
        presentation: {
          singleWindowDisplayName: "OpenAI Pro",
        },
      }),
    };
    mockProviders.push(openaiProvider);

    const config = {
      enabled: true,
      enabledProviders: ["openai"],
      formatStyle: "singleWindow",
      showOnQuestion: false,
      showSessionTokens: false,
      minIntervalMs: 60_000,
    };

    const client = createClient({
      config,
      sessionMeta: { modelID: "openai/gpt-5", providerID: "openai" },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);
    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-openai-style-divergence",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    const quotaOutput = getPromptText(client);
    expect(quotaOutput).toContain("95% left");
    expect(quotaOutput).toContain("40% left");

    // Ensure sidebar reads from shared persisted snapshot, then projects as single-window.
    await resetQuotaStateForTests();

    const { loadSidebarPanel } = await import("../src/lib/tui-runtime.js");
    const panel = await loadSidebarPanel({
      api: {
        state: {
          provider: [],
          path: {
            worktree: worktreeDir,
            directory: nestedDir,
          },
          session: {
            messages: () => [],
          },
        },
        client,
      } as any,
      sessionID: "session-openai-style-divergence",
    });

    expect(panel.status).toBe("ready");
    const sidebarOutput = panel.lines.join("\n");
    expect(sidebarOutput).toContain("40% left");
    expect(sidebarOutput).not.toContain("95% left");
    expect(openaiProvider.fetch).toHaveBeenCalledTimes(1);
  });
});
