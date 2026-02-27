import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONFIG } from "../src/lib/types.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readAuthFileCached: vi.fn(),
  recordQwenCompletion: vi.fn(),
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

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
  readAuthFile: vi.fn(),
  getAuthPath: vi.fn(() => "/tmp/auth.json"),
  getAuthPaths: vi.fn(() => ["/tmp/auth.json"]),
  clearReadAuthFileCacheForTests: vi.fn(),
}));

vi.mock("../src/lib/qwen-local-quota.js", () => ({
  recordQwenCompletion: mocks.recordQwenCompletion,
  readQwenLocalQuotaState: vi.fn(),
  computeQwenQuota: vi.fn(),
  getQwenLocalQuotaPath: vi.fn(() => "/tmp/qwen-local-quota.json"),
}));

function createClient(modelID: string) {
  return {
    config: {
      get: vi.fn().mockResolvedValue({ data: {} }),
      providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
    },
    session: {
      get: vi.fn().mockResolvedValue({ data: { modelID } }),
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

describe("plugin qwen question hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_CONFIG,
      showOnQuestion: false,
    });
    mocks.readAuthFileCached.mockResolvedValue({
      "opencode-qwencode-auth": { type: "oauth", access: "token" },
    });
    mocks.recordQwenCompletion.mockResolvedValue({
      version: 1,
      utcDay: "2026-02-24",
      dayCount: 1,
      recent: [],
      updatedAt: 1,
    });
  });

  it("records completion on successful qwen question execution", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient("qwen-code/qwen3-coder-plus") } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-1" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(mocks.recordQwenCompletion).toHaveBeenCalledTimes(1);
  });

  it("does not record completion when plugin is disabled", async () => {
    mocks.loadConfig.mockResolvedValueOnce({
      ...DEFAULT_CONFIG,
      enabled: false,
      showOnQuestion: false,
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient("qwen-code/qwen3-coder-plus") } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-2" },
      { title: "Question", output: "ok", metadata: { status: "success" } },
    );

    expect(mocks.recordQwenCompletion).not.toHaveBeenCalled();
  });

  it("does not record completion when tool output indicates failure", async () => {
    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = await QuotaToastPlugin({ client: createClient("qwen-code/qwen3-coder-plus") } as any);

    await hooks["tool.execute.after"]?.(
      { tool: "question", sessionID: "session-1", callID: "call-3" },
      { title: "Error", output: "failed", metadata: { status: "error", error: "boom" } },
    );

    expect(mocks.recordQwenCompletion).not.toHaveBeenCalled();
  });
});
