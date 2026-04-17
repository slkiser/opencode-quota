import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPluginTestClient as createClient,
  makeQuotaToastTestConfig,
  seedDefaultPricingMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  recordQwenCompletion: vi.fn(),
  recordAlibabaCodingPlanCompletion: vi.fn(),
  resolveQwenLocalPlanCached: vi.fn(),
  resolveAlibabaCodingPlanAuthCached: vi.fn(),
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
  createLoadConfigMeta: () => ({ source: "test", paths: [], networkSettingSources: {} }),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
  readAuthFile: vi.fn(),
  getAuthPath: vi.fn(() => "/tmp/auth.json"),
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  clearReadAuthFileCacheForTests: vi.fn(),
}));

vi.mock("../src/lib/qwen-auth.js", () => ({
  isQwenCodeModelId: (model?: string) =>
    typeof model === "string" && model.toLowerCase().startsWith("qwen-code/"),
  resolveQwenLocalPlanCached: mocks.resolveQwenLocalPlanCached,
}));

vi.mock("../src/lib/alibaba-auth.js", () => ({
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS: 5000,
  isAlibabaModelId: (model?: string) =>
    typeof model === "string" &&
    (model.toLowerCase().startsWith("alibaba/") || model.toLowerCase().startsWith("alibaba-cn/")),
  resolveAlibabaCodingPlanAuthCached: mocks.resolveAlibabaCodingPlanAuthCached,
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  recordQwenCompletion: mocks.recordQwenCompletion,
  recordAlibabaCodingPlanCompletion: mocks.recordAlibabaCodingPlanCompletion,
  readQwenLocalQuotaState: vi.fn(),
  computeQwenQuota: vi.fn(),
  getQwenLocalQuotaPath: vi.fn(() => "/tmp/qwen-local-quota.json"),
  getAlibabaCodingPlanQuotaPath: vi.fn(() => "/tmp/alibaba-local-quota.json"),
  readAlibabaCodingPlanQuotaState: vi.fn(),
  computeAlibabaCodingPlanQuota: vi.fn(),
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

describe("plugin qwen question hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ showOnQuestion: false }));
    mocks.resolveQwenLocalPlanCached.mockResolvedValue({
      state: "qwen_free",
      accessToken: "token",
    });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValue({ state: "none" });
    mocks.recordQwenCompletion.mockResolvedValue({
      version: 1,
      utcDay: "2026-02-24",
      dayCount: 1,
      recent: [],
      updatedAt: 1,
    });
    mocks.recordAlibabaCodingPlanCompletion.mockResolvedValue({
      version: 1,
      recent: [],
      updatedAt: 1,
    });
    seedDefaultPricingMocks(mocks);
  });

  it("records qwen free completion on successful qwen question execution", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({
      client: createClient({ modelID: "qwen-code/qwen3-coder-plus" }),
    } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-1" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(mocks.recordQwenCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.recordAlibabaCodingPlanCompletion).not.toHaveBeenCalled();
  });

  it("records alibaba coding plan completion when that plan is active", async () => {
    mocks.resolveQwenLocalPlanCached.mockResolvedValueOnce({ state: "none" });
    mocks.resolveAlibabaCodingPlanAuthCached.mockResolvedValueOnce({
      state: "configured",
      apiKey: "dashscope-key",
      tier: "lite",
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({
      client: createClient({ modelID: "alibaba/qwen3-coder-plus" }),
    } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-2" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(mocks.recordAlibabaCodingPlanCompletion).toHaveBeenCalledTimes(1);
    expect(mocks.recordQwenCompletion).not.toHaveBeenCalled();
  });

  it("does not record completion when plugin is disabled", async () => {
    mocks.loadConfig.mockResolvedValueOnce(
      makeQuotaToastTestConfig({
        enabled: false,
        showOnQuestion: false,
      }),
    );

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({
      client: createClient({ modelID: "qwen-code/qwen3-coder-plus" }),
    } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-3" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(mocks.recordQwenCompletion).not.toHaveBeenCalled();
    expect(mocks.recordAlibabaCodingPlanCompletion).not.toHaveBeenCalled();
  });

  it("does not record completion when tool output indicates failure", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({
      client: createClient({ modelID: "qwen-code/qwen3-coder-plus" }),
    } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-4" },
      { title: "Error", output: "failed", metadata: { status: "error", error: "boom" } },
    );

    expect(mocks.recordQwenCompletion).not.toHaveBeenCalled();
    expect(mocks.recordAlibabaCodingPlanCompletion).not.toHaveBeenCalled();
  });
});
