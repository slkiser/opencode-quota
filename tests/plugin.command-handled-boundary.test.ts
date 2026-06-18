import { rm } from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-plugin-command-boundary-tests";

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
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));

vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);

vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

async function buildDialogOutput(params: {
  command: "quota" | "pricing_refresh" | "tokens_daily" | "tokens_session_all";
  client: ReturnType<typeof createClient>;
  sessionID?: string;
}) {
  const { buildQuotaDialogCommandOutput } = await import("../src/lib/quota-dialog-commands.js");
  return buildQuotaDialogCommandOutput({
    command: params.command,
    client: params.client,
    roots: {
      workspaceRoot: process.cwd(),
      configRoot: process.cwd(),
      fallbackDirectory: process.cwd(),
    },
    sessionID: params.sessionID,
  });
}

describe("plugin command handled boundary", () => {
  beforeEach(async () => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { enabled: true },
      resetPluginState: true,
    });
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("does not register or handle migrated deterministic slash commands in the server plugin", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);
    const cfg: { command?: Record<string, { template: string; description: string }> } = {};

    await hooks.config?.(cfg as any);

    expect(cfg.command).toBeUndefined();
    expect(hooks["command.execute.before"]).toBeUndefined();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("builds deterministic quota dialog output without session.prompt injection", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);
    const client = createClient();

    const result = await buildDialogOutput({ command: "quota", client, sessionID: "session-2" });

    expect(result.state).toBe("output");
    expect(result.state === "output" ? result.output : "").toContain("Quota unavailable");
    expect(result.state === "output" ? result.output : "").toContain("No quota providers detected");
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("returns no-op dialog result for disabled deterministic commands", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const daily = await buildDialogOutput({ command: "tokens_daily", client, sessionID: "session-disabled" });
    const tree = await buildDialogOutput({
      command: "tokens_session_all",
      client,
      sessionID: "session-disabled-tree",
    });

    expect(daily).toEqual({ state: "noop", command: "tokens_daily", reason: "disabled" });
    expect(tree).toEqual({ state: "noop", command: "tokens_session_all", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("builds /pricing_refresh dialog output without throwing a handled sentinel", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
    });

    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-pricing-refresh",
    });

    expect(mocks.maybeRefreshPricingSnapshot).toHaveBeenCalledWith({
      reason: "manual",
      force: true,
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(result.state === "output" ? result.output : "").toContain(
      "Pricing Refresh (/pricing_refresh)",
    );
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("treats /pricing_refresh as a dialog no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));
    const client = createClient();

    const result = await buildDialogOutput({
      command: "pricing_refresh",
      client,
      sessionID: "session-disabled-refresh",
    });

    expect(result).toEqual({ state: "noop", command: "pricing_refresh", reason: "disabled" });
    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});
