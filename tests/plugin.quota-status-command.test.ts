import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPluginTuiConfigInspection,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
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
  collectQuotaStatusLiveProbes: vi.fn(),
  buildQuotaStatusReport: vi.fn(),
  inspectTuiConfig: vi.fn(),
  refreshGoogleTokensForAllAccounts: vi.fn(),
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

vi.mock("../src/lib/quota-render-data.js", () => ({
  collectConcreteEnabledProviderIds: vi.fn(),
  collectQuotaRenderData: vi.fn(),
  collectQuotaStatusLiveProbes: mocks.collectQuotaStatusLiveProbes,
  matchesQuotaProviderCurrentSelection: vi.fn(() => true),
  resolveQuotaRenderSelection: vi.fn(),
}));

vi.mock("../src/lib/quota-status.js", () => ({
  buildQuotaStatusReport: mocks.buildQuotaStatusReport,
}));

vi.mock("../src/lib/tui-config-diagnostics.js", () => ({
  inspectTuiConfig: mocks.inspectTuiConfig,
}));

vi.mock("../src/lib/google.js", () => ({
  refreshGoogleTokensForAllAccounts: mocks.refreshGoogleTokensForAllAccounts,
}));

async function buildQuotaStatusDialogOutput(params: {
  client: ReturnType<typeof createClient>;
  sessionID?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const result = await buildQuotaDialogCommandOutput({
    command: "quota_status",
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

describe("/quota_status command behavior", () => {
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    savedConfigDir = process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG_DIR;
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: {
        ...DEFAULT_CONFIG,
        enabled: true,
        enabledProviders: ["openai", "synthetic", "copilot", "cursor"],
        showOnQuestion: false,
        showSessionTokens: false,
        minIntervalMs: 60_000,
      },
      resetModules: true,
      resetPluginState: true,
    });
    mocks.inspectTuiConfig.mockResolvedValue(createPluginTuiConfigInspection(process.cwd()));
    mocks.refreshGoogleTokensForAllAccounts.mockResolvedValue({ attempted: false });
    mocks.collectQuotaStatusLiveProbes.mockResolvedValue([
      {
        providerId: "openai",
        result: { attempted: true, entries: [{ name: "OpenAI", percentRemaining: 90 }], errors: [] },
      },
      {
        providerId: "synthetic",
        result: { attempted: false, entries: [], errors: [] },
      },
      {
        providerId: "copilot",
        result: {
          attempted: true,
          entries: [],
          errors: [{ label: "Copilot", message: "Billing endpoint unavailable" }],
        },
      },
    ]);
    mocks.buildQuotaStatusReport.mockResolvedValue("Injected quota status");
  });

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.OPENCODE_CONFIG_DIR = savedConfigDir;
    else delete process.env.OPENCODE_CONFIG_DIR;
  });

  it("probes every enabled and available provider with fresh single-window status probes and still throws the handled sentinel", async () => {
    const openai = {
      id: "openai",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    const synthetic = {
      id: "synthetic",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    const copilot = {
      id: "copilot",
      isAvailable: vi.fn().mockResolvedValue(true),
      fetch: vi.fn(),
    };
    const cursor = {
      id: "cursor",
      isAvailable: vi.fn().mockResolvedValue(false),
      fetch: vi.fn(),
    };
    mocks.getProviders.mockReturnValue([openai, synthetic, copilot, cursor]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    await QuotaToastPlugin({ client } as any);

    const output = await buildQuotaStatusDialogOutput({
      client,
      sessionID: "session-status",
    });

    expect(mocks.collectQuotaStatusLiveProbes).toHaveBeenCalledTimes(1);
    expect(mocks.inspectTuiConfig).toHaveBeenCalledWith({
      roots: {
        workspaceRoot: process.cwd(),
        configRoot: process.cwd(),
      },
    });
    expect(mocks.collectQuotaStatusLiveProbes).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        config: expect.objectContaining({ enabledProviders: ["openai", "synthetic", "copilot", "cursor"] }),
        formatStyle: "singleWindow",
        providers: [openai, synthetic, copilot],
      }),
    );
    expect(mocks.buildQuotaStatusReport).toHaveBeenCalledWith(
      expect.objectContaining({
        globalConfigPaths: [],
        workspaceConfigPaths: [],
        settingSources: {},
        configIssues: [],
        geminiCliClient: client,
        providerLiveProbes: [
          {
            providerId: "openai",
            result: { attempted: true, entries: [{ name: "OpenAI", percentRemaining: 90 }], errors: [] },
          },
          {
            providerId: "synthetic",
            result: { attempted: false, entries: [], errors: [] },
          },
          {
            providerId: "copilot",
            result: {
              attempted: true,
              entries: [],
              errors: [{ label: "Copilot", message: "Billing endpoint unavailable" }],
            },
          },
        ],
      }),
    );
    expect(output).toBe("Injected quota status");
  });

  it("reports no_session diagnostics when no active TUI session is available", async () => {
    mocks.getProviders.mockReturnValue([]);

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "openai/gpt-5", providerID: "openai" });
    await QuotaToastPlugin({ client } as any);

    const output = await buildQuotaStatusDialogOutput({
      client,
      sessionID: undefined,
    });

    expect(client.session.get).not.toHaveBeenCalled();
    expect(mocks.buildQuotaStatusReport).toHaveBeenCalledWith(
      expect.objectContaining({
        currentModel: undefined,
        sessionModelLookup: "no_session",
      }),
    );
    expect(output).toBe("Injected quota status");
  });
});
