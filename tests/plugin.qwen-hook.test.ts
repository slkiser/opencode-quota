import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAlibabaAuthModuleMock,
  createConfigModuleMock,
  createPluginTestClient as createClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createQwenAuthModuleMock,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
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

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn(),
  readAuthFile: vi.fn(),
  getAuthPath: vi.fn(() => "/tmp/auth.json"),
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  clearReadAuthFileCacheForTests: vi.fn(),
}));
vi.mock("../src/lib/qwen-auth.js", () =>
  createQwenAuthModuleMock(mocks.resolveQwenLocalPlanCached),
);
vi.mock("../src/lib/alibaba-auth.js", () =>
  createAlibabaAuthModuleMock(mocks.resolveAlibabaCodingPlanAuthCached),
);
vi.mock("../src/lib/modelsdev-pricing.js", () => createPricingModuleMock(mocks));

describe("plugin question hook accounting boundary", () => {
  beforeEach(() => {
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: { showOnQuestion: false },
    });
  });

  it("does not treat a successful question-tool execution as a completed model request", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "qwen3-coder-plus", providerID: "qwen-code" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-1" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(client.session.get).not.toHaveBeenCalled();
    expect(mocks.resolveQwenLocalPlanCached).not.toHaveBeenCalled();
    expect(mocks.resolveAlibabaCodingPlanAuthCached).not.toHaveBeenCalled();
  });

  it("does not use question-tool failure metadata as accounting authority", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const client = createClient({ modelID: "qwen3-coder-plus", providerID: "qwen-code" });
    const hooks = await QuotaToastPlugin({ client } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-2" },
      { title: "Error", output: "failed", metadata: { status: "error", error: "boom" } },
    );

    expect(client.session.get).not.toHaveBeenCalled();
    expect(mocks.resolveQwenLocalPlanCached).not.toHaveBeenCalled();
  });
});
