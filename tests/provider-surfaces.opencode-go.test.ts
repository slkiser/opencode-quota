import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getPromptText,
  getToastMessage,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-opencode-go-surfaces";
const TEST_TOKEN = "distinctive-opencode-go-surface-token";

let provider: typeof import("../src/providers/opencode-go.js")["opencodeGoProvider"];

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  resolveOpenCodeGoAuthCached: vi.fn(),
  getOpenCodeGoAuthDiagnostics: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/config.js")>()),
  ...createConfigModuleMock(mocks.loadConfig),
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/opencode-go-auth.js", () => ({
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveOpenCodeGoAuthCached: mocks.resolveOpenCodeGoAuthCached,
  getOpenCodeGoAuthDiagnostics: mocks.getOpenCodeGoAuthDiagnostics,
}));
vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
}));

type PluginHooks = {
  dispose?: () => Promise<void> | void;
  event?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    sessionID: string;
  }) => Promise<void> | void;
};

function createConfig() {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["opencode-go"],
    formatStyle: "allWindows",
    minIntervalMs: 60_000,
    onlyCurrentModel: false,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: false,
    telemetry: { enabled: false },
    maintainerAnnouncements: { enabled: false, home: false },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: true,
      formatStyle: "allWindows",
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle: "allWindows",
      suppressWhenNativeProviderQuota: false,
    },
    tuiPromptBar: { enabled: true },
  });
}

function successfulResult() {
  return {
    success: true as const,
    rolling: {
      status: "ok" as const,
      usagePercent: 12,
      percentRemaining: 88,
      resetTimeIso: "2026-08-12T12:30:00.000Z",
    },
    weekly: {
      status: "ok" as const,
      usagePercent: 45,
      percentRemaining: 55,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    },
    monthly: {
      status: "ok" as const,
      usagePercent: 80,
      percentRemaining: 20,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    },
  };
}

async function expectHandled(value: unknown): Promise<void> {
  try {
    await Promise.resolve(value);
  } catch (error) {
    expect(isCommandHandledError(error)).toBe(true);
    return;
  }
  throw new Error("Expected the handled command sentinel");
}

function expectCanonicalPercentOrder(output: string): void {
  expect(output).toContain("OpenCode Go");
  const positions = [
    output.lastIndexOf("88%"),
    output.lastIndexOf("55%"),
    output.lastIndexOf("20%"),
  ];
  expect(
    positions.every((position) => position >= 0),
    output,
  ).toBe(true);
  expect(positions, output).toEqual([...positions].sort((left, right) => left - right));
}

describe("OpenCode Go shared projections", () => {
  beforeEach(async () => {
    const config = createConfig();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: config,
      resetPluginState: true,
    });
    provider = (await import("../src/providers/opencode-go.js")).opencodeGoProvider;
    mocks.loadConfig.mockResolvedValue(config);
    mocks.getProviders.mockReturnValue([provider]);
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: TEST_TOKEN,
    });
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue({
      state: "configured",
      source: "opencode.db",
      checkedPaths: ["env:OPENCODE_API_KEY"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());

    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("keeps canonical all-window values and the five-hour prompt entry on every surface", async () => {
    const client = createPluginTestClient({
      modelID: "opencode-go/model",
      providerID: "opencode-go",
    });
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "opencode-go" }] },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = (await QuotaToastPlugin({ client } as never)) as PluginHooks;

    await expectHandled(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "opencode-go-session",
      }),
    );
    const command = getPromptText(client);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "opencode-go-session" },
      },
    });
    const toast = getToastMessage(client);

    const { loadTuiSessionQuotaSurfaces } = await import("../src/lib/tui-runtime.js");
    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: {
        state: {
          provider: [{ id: "opencode-go" }],
          path: { worktree: process.cwd(), directory: process.cwd() },
          session: { messages: () => [] },
        },
        client,
      } as never,
      sessionID: "opencode-go-session",
    });
    const sidebar = [...surfaces.sidebar.lines, ...(surfaces.sidebar.linesExpanded ?? [])].join(
      "\n",
    );
    const compact = surfaces.compact.status === "ready" ? surfaces.compact.text : "";

    for (const output of [command, toast, sidebar, compact]) {
      expectCanonicalPercentOrder(output);
      expect(output).not.toContain(TEST_TOKEN);
    }
    expect(surfaces.promptBar).toMatchObject({
      status: "ready",
      entry: {
        name: "OpenCode Go 5h",
        percentRemaining: 88,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
        accounting: { acquisitionMethod: "remote_api" },
      },
      percentDisplayMode: "remaining",
    });
    expect(JSON.stringify(surfaces)).not.toContain(TEST_TOKEN);

    await hooks.dispose?.();
  });

  it("selects the most constrained window and preserves accounting through projection", async () => {
    const config = createConfig();
    const { collectQuotaRenderData } = await import("../src/lib/quota-render-data.js");
    const result = await collectQuotaRenderData({
      client: {} as never,
      config,
      providers: [provider],
      formatStyle: "singleWindow",
      surfaceExplicitProviderIssues: true,
      bypassProviderCache: true,
      includeAllWindowsData: true,
    });

    expect(result.allWindowsData?.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Weekly",
      "OpenCode Go Monthly",
    ]);
    expect(result.data?.entries).toHaveLength(1);
    expect(result.data?.entries[0]).toMatchObject({
      name: "[OpenCode Go] Monthly",
      percentRemaining: 20,
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
    });
  });

  it("includes the selected Go windows in the provider cache identity", async () => {
    const { buildQuotaProviderStateCacheKey } = await import("../src/lib/quota-state.js");
    const rolling = createProviderAvailabilityContext({
      configOverrides: { opencodeGoWindows: ["rolling"] },
    });
    const monthly = createProviderAvailabilityContext({
      configOverrides: { opencodeGoWindows: ["monthly"] },
    });

    const rollingKey = buildQuotaProviderStateCacheKey("opencode-go", rolling);
    const monthlyKey = buildQuotaProviderStateCacheKey("opencode-go", monthly);

    expect(rollingKey).toContain("opencodeGoWindows=rolling");
    expect(monthlyKey).toContain("opencodeGoWindows=monthly");
    expect(rollingKey).not.toBe(monthlyKey);
    expect(rollingKey).not.toContain(TEST_TOKEN);
    expect(monthlyKey).not.toContain(TEST_TOKEN);
  });
});
