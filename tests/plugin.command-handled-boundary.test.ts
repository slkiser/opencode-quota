import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import {
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getPromptText,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

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

describe("plugin command handled boundary", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { enabled: true },
      resetPluginState: true,
    });
  });

  it("propagates command-handled sentinel errors to abort command pipeline", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-1",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("downgrades availability probe errors into handled unavailable output", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);
    const client = createClient();
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-2",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(client.session.prompt).toHaveBeenCalledTimes(1);
    const injected = getPromptText(client);
    expect(injected).toContain("Quota unavailable");
    expect(injected).toContain("No quota providers detected");
  });

  it("rethrows unexpected non-sentinel errors from handled commands", async () => {
    const client = createClient();
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client } as any);
    client.session.prompt.mockRejectedValue(new Error("inject failed"));
    client.app.log.mockRejectedValue(new Error("log failed"));

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-inject-failure",
      } as any),
    ).rejects.toThrow("log failed");
  });

  it("treats handled token slash commands as strict no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_daily",
        sessionID: "session-disabled",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);
    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_session_all",
        sessionID: "session-disabled-tree",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });

  it("propagates handled sentinel for /pricing_refresh after injecting output", async () => {
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: true,
      updated: true,
      state: { version: 1, updatedAt: Date.now(), lastResult: "success" },
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
      snapshotSelection: "auto",
      allowRefreshWhenSelectionBundled: true,
    });
    expect(client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("treats /pricing_refresh as a strict no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ enabled: false }));

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "pricing_refresh",
        sessionID: "session-disabled-refresh",
      } as any),
    ).rejects.toThrow(COMMAND_HANDLED_SENTINEL);

    expect(mocks.maybeRefreshPricingSnapshot).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
  });
});
