import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPluginTestClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
} from "./helpers/plugin-test-harness.js";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const mocks = vi.hoisted(() => ({
  mockProviders: [] as any[],
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

function seedPricingMocks(): void {
  mocks.getPricingSnapshotMeta.mockReturnValue({
    source: "runtime",
    generatedAt: Date.UTC(2026, 0, 1),
    units: "USD per 1M tokens",
  });
  mocks.getPricingSnapshotSource.mockReturnValue("runtime");
  mocks.getRuntimePricingRefreshStatePath.mockReturnValue("/tmp/refresh-state.json");
  mocks.getRuntimePricingSnapshotPath.mockReturnValue("/tmp/pricing-runtime.json");
  mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
    attempted: false,
    updated: false,
    state: { version: 1, updatedAt: Date.now() },
  });
}

function createClient(params: {
  config: Record<string, unknown>;
  sessionMeta: { modelID?: string; providerID?: string };
}) {
  const client = createPluginTestClient({
    modelID: params.sessionMeta.modelID,
    providerID: params.sessionMeta.providerID,
  });

  client.config.get.mockResolvedValue({
    data: {
      experimental: {
        quotaToast: params.config,
      },
    },
  });
  client.config.providers.mockResolvedValue({
    data: {
      providers: mocks.mockProviders.map((provider) => ({ id: provider.id })),
    },
  });

  return client;
}

async function buildQuotaDialogOutputText(params: {
  client: ReturnType<typeof createClient>;
  sessionID: string;
  roots?: {
    workspaceRoot?: string;
    worktreeRoot?: string;
    configRoot?: string;
    fallbackDirectory?: string;
    activeDirectory?: string;
  };
}): Promise<string> {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: "quota",
    client: params.client,
    roots: params.roots ?? {
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
  return result.state === "output" ? result.output : "";
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
    vi.clearAllMocks();
    mocks.mockProviders.length = 0;
    mocks.getProviders.mockImplementation(() => mocks.mockProviders);
    seedPricingMocks();
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
    delete process.env.OPENCODE_CONFIG_DIR;

    process.chdir(worktreeDir);
  });

  afterEach(async () => {
    mocks.mockProviders.length = 0;
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
            accounting: TEST_ACCOUNTING,
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
    mocks.mockProviders.push(syntheticProvider);

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
    await QuotaToastPlugin({ client } as any);

    const quotaOutput = await buildQuotaDialogOutputText({
      client,
      sessionID: "session-worktree-root-parity",
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
    });
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
    expect(panel.lines.join("\n")).toContain("64%");
    expect(syntheticProvider.fetch).toHaveBeenCalledTimes(1);
  });

  it("resolves relative OPENCODE_CONFIG_DIR from the worktree root for plugin commands", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
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
    mocks.mockProviders.push(syntheticProvider);

    mkdirSync(join(worktreeDir, ".git"));
    mkdirSync(join(worktreeDir, ".opencode"), { recursive: true });
    mkdirSync(join(nestedDir, ".opencode"), { recursive: true });
    process.env.OPENCODE_CONFIG_DIR = ".opencode";

    writeFileSync(
      join(worktreeDir, ".opencode", "opencode.json"),
      JSON.stringify({
        experimental: {
          quotaToast: {
            enabled: false,
          },
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(nestedDir, ".opencode", "opencode.json"),
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

    process.chdir(nestedDir);

    const client = createClient({
      config: {
        enabled: false,
        enabledProviders: [],
      },
      sessionMeta: { modelID: "synthetic/default", providerID: "synthetic" },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    await QuotaToastPlugin({ client } as any);

    await expect(
      buildQuotaDialogOutputText({
        client,
        sessionID: "session-relative-config-root",
        roots: {
          workspaceRoot: worktreeDir,
          configRoot: worktreeDir,
          fallbackDirectory: nestedDir,
        },
      }),
    ).resolves.toBe("");
    expect(syntheticProvider.fetch).not.toHaveBeenCalled();
  });

  it("keeps workspace overrides for formerly global-authoritative settings aligned between plugin and sidebar", async () => {
    const syntheticProvider = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn().mockResolvedValue({
        attempted: true,
        entries: [
          {
            accounting: TEST_ACCOUNTING,
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
            accounting: TEST_ACCOUNTING,
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
    mocks.mockProviders.push(syntheticProvider, openaiProvider);

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
    await QuotaToastPlugin({ client } as any);

    const quotaOutput = await buildQuotaDialogOutputText({
      client,
      sessionID: "session-layered-provider-override",
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
    });
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
    expect(sidebarOutput).toContain("82%");
    expect(sidebarOutput).not.toContain("17%");
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
            accounting: TEST_ACCOUNTING,
            name: "Synthetic 5h",
            group: "Synthetic",
            label: "5h:",
            percentRemaining: 44,
            right: "44/100",
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
          {
            accounting: TEST_ACCOUNTING,
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
    mocks.mockProviders.push(syntheticProvider);

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
    await QuotaToastPlugin({ client } as any);

    const quotaOutput = await buildQuotaDialogOutputText({
      client,
      sessionID: "session-synthetic-parity",
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
    });
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
    expect(panel.linesExpanded).toBeDefined();
    const sidebarOutput = panel.linesExpanded!.join("\n");
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
            accounting: TEST_ACCOUNTING,
            name: "OpenAI Pro 5h",
            group: "OpenAI (Pro)",
            label: "5h:",
            percentRemaining: 95,
            resetTimeIso: "2099-01-01T00:00:00.000Z",
          },
          {
            accounting: TEST_ACCOUNTING,
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
    mocks.mockProviders.push(openaiProvider);

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
    await QuotaToastPlugin({ client } as any);

    const quotaOutput = await buildQuotaDialogOutputText({
      client,
      sessionID: "session-openai-style-divergence",
      roots: {
        worktreeRoot: worktreeDir,
        activeDirectory: nestedDir,
        fallbackDirectory: nestedDir,
      },
    });
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
    expect(panel.linesExpanded).toBeDefined();
    const sidebarOutput = panel.lines.join("\n");
    const expandedSidebarOutput = panel.linesExpanded!.join("\n");
    expect(sidebarOutput).toContain("40%");
    expect(sidebarOutput).not.toContain("95%");
    expect(expandedSidebarOutput).toContain("95% left");
    expect(expandedSidebarOutput).toContain("40% left");
    expect(openaiProvider.fetch).toHaveBeenCalledTimes(1);
  });
});
