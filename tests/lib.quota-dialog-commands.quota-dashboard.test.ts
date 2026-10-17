import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient as createClient,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  createQwenAuthModuleMock,
  createSessionTokensModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-quota-dashboard-command-tests";

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
  getDashboardApi: vi.fn(),
}));

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
vi.mock("../src/dashboard/dashboard-instance.js", () => ({
  getDashboardApi: mocks.getDashboardApi,
}));

async function runQuotaDashboardCommand(args?: string) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  const client = createClient();
  const result = await buildQuotaDialogCommandOutput({
    command: "quota_dashboard",
    arguments: args,
    client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: "session-1",
  });
  expect(result.state).toBe("output");
  return result.state === "output" ? result.output : "";
}

describe("/quota_dashboard command", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { enabled: true },
      resetPluginState: true,
    });
    mocks.getProviders.mockReturnValue([{ id: "anthropic" }, { id: "openai" }]);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("rejects arguments", async () => {
    const output = await runQuotaDashboardCommand("some-arg");
    expect(output).toContain("Invalid arguments for /quota_dashboard");
  });

  it("reports how to start the dashboard when the DB is unreachable", async () => {
    mocks.getDashboardApi.mockResolvedValue(null);
    const output = await runQuotaDashboardCommand();
    expect(output).toContain("Dashboard database is not reachable");
    expect(output).toContain("token-watcher gui");
    expect(output).toContain("token-watcher dashboard");
    expect(output).toContain("http://localhost:3939");
  });

  it("reports no snapshots yet when the DB has no data", async () => {
    mocks.getDashboardApi.mockResolvedValue({
      getCurrentQuota: vi.fn().mockReturnValue(null),
    });
    const output = await runQuotaDashboardCommand();
    expect(output).toContain("No quota snapshots captured yet");
  });

  it("lists providers with captured snapshots", async () => {
    mocks.getDashboardApi.mockResolvedValue({
      getCurrentQuota: vi.fn((providerId: string) =>
        providerId === "anthropic" ? { percentRemaining: 58, limits: [] } : null,
      ),
    });
    const output = await runQuotaDashboardCommand();
    expect(output).toContain("Snapshots available for: anthropic");
    expect(output).not.toContain("openai");
  });
});
