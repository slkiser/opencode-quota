import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMMAND_HANDLED_SENTINEL } from "../src/lib/command-handled.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

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
  createLoadConfigMeta: () => ({ source: "test", paths: [] }),
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

function createClient() {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: {} }),
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

describe("plugin command handled boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__opencodeQuotaCommandCache;

    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: true,
    });
    mocks.getProviders.mockReturnValue([]);
    mocks.getPricingSnapshotMeta.mockReturnValue({
      source: "https://models.dev/api.json",
      generatedAt: Date.UTC(2026, 0, 1),
      units: "USD per 1M tokens",
    });
    mocks.getPricingSnapshotSource.mockReturnValue("runtime");
    mocks.getRuntimePricingSnapshotPath.mockReturnValue("/tmp/modelsdev-pricing.runtime.min.json");
    mocks.getRuntimePricingRefreshStatePath.mockReturnValue(
      "/tmp/modelsdev-pricing.refresh-state.json",
    );
    mocks.maybeRefreshPricingSnapshot.mockResolvedValue({
      attempted: false,
      updated: false,
      state: { version: 1, updatedAt: Date.now() },
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

  it("rethrows non-sentinel errors", async () => {
    mocks.getProviders.mockReturnValue([
      {
        id: "boom-provider",
        isAvailable: vi.fn().mockRejectedValue(new Error("boom")),
        fetch: vi.fn(),
      },
    ]);
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient() } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "session-2",
      } as any),
    ).rejects.toThrow("boom");
  });

  it("treats handled slash commands as strict no-op when disabled", async () => {
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: false,
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient();
    const hooks = await QuotaToastPlugin({ client } as any);

    await expect(
      hooks["command.execute.before"]?.({
        command: "tokens_daily",
        sessionID: "session-disabled",
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
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      enabled: false,
    });

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
