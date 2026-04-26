import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
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

describe("/quota_status command behavior", () => {
  beforeEach(() => {
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
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({ state: "none" });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
    mocks.inspectTuiConfig.mockResolvedValue({
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      configured: false,
      inferredSelectedPath: null,
      presentPaths: [],
      candidatePaths: [],
      quotaPluginConfigured: false,
      quotaPluginConfigPaths: [],
    });
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
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota_status",
        sessionID: "session-status",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

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
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    expect(client.session.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { id: "session-status" },
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: "Injected quota status",
            }),
          ],
        }),
      }),
    );
  });
});
