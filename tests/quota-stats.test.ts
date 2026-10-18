import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-storage.js", () => {
  class SessionNotFoundError extends Error {
    sessionID: string;
    checkedPath: string;

    constructor(sessionID: string, checkedPath: string) {
      super(`Session not found: ${sessionID}`);
      this.name = "SessionNotFoundError";
      this.sessionID = sessionID;
      this.checkedPath = checkedPath;
    }
  }

  return {
    getOpenCodeDbPath: vi.fn(() => "/tmp/opencode.db"),
    iterAssistantMessages: vi.fn(),
    iterAssistantMessagesForSession: vi.fn(),
    iterAssistantMessagesForSessions: vi.fn(),
    readAllSessionsIndex: vi.fn(),
    SessionNotFoundError,
  };
});

vi.mock("../src/lib/claude-code-cli-storage.js", () => ({
  iterClaudeCodeCliMessages: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../src/lib/codex-cli-storage.js", () => ({
  iterCodexCliMessages: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  hasCost: vi.fn(
    (providerID: string, modelID: string) => providerID === "openai" && modelID === "gpt-5",
  ),
  hasProvider: vi.fn((providerID: string) => providerID === "openai"),
  hasModel: vi.fn(
    (providerID: string, modelID: string) => providerID === "openai" && modelID === "gpt-5",
  ),
  isModelsDevProviderId: vi.fn((providerID: string) => providerID === "openai"),
  listProvidersForModelId: vi.fn((modelID: string) => (modelID === "gpt-5" ? ["openai"] : [])),
  lookupCost: vi.fn((providerID: string, modelID: string) =>
    providerID === "openai" && modelID === "gpt-5"
      ? { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1 }
      : null,
  ),
}));

vi.mock("../src/lib/cursor-pricing.js", () => ({
  isCursorModelId: vi.fn(() => false),
  isCursorProviderId: vi.fn(() => false),
  lookupCursorLocalCost: vi.fn(() => null),
  resolveCursorModel: vi.fn(() => ({ kind: "unknown" })),
}));

vi.mock("../src/lib/token-cost.js", () => ({
  calculateUsdFromTokenBuckets: vi.fn(
    (
      _rates: unknown,
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache_read: number;
        cache_write: number;
      },
    ) => tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write,
  ),
}));

import {
  aggregateUsage,
  getSessionTokenSummary,
  resolveSessionTree,
  SessionNotFoundError,
} from "../src/lib/quota-stats.js";

describe("quota stats session tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves recursive descendants in preorder using session creation order", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: { id: "ses_root", title: "Root", time: { created: 1 } },
      ses_child_b: {
        id: "ses_child_b",
        parentID: "ses_root",
        title: "Child B",
        time: { created: 30 },
      },
      ses_grandchild: {
        id: "ses_grandchild",
        parentID: "ses_child_a",
        title: "Grandchild",
        time: { created: 20 },
      },
      ses_child_a: {
        id: "ses_child_a",
        parentID: "ses_root",
        title: "Child A",
        time: { created: 10 },
      },
    });

    await expect(resolveSessionTree("ses_root")).resolves.toEqual([
      { sessionID: "ses_root", parentID: undefined, title: "Root", depth: 0 },
      { sessionID: "ses_child_a", parentID: "ses_root", title: "Child A", depth: 1 },
      {
        sessionID: "ses_grandchild",
        parentID: "ses_child_a",
        title: "Grandchild",
        depth: 2,
      },
      { sessionID: "ses_child_b", parentID: "ses_root", title: "Child B", depth: 1 },
    ]);
  });

  it("skips repeated nodes when parent links form a cycle", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: {
        id: "ses_root",
        parentID: "ses_leaf",
        title: "Root",
        time: { created: 1 },
      },
      ses_mid: {
        id: "ses_mid",
        parentID: "ses_root",
        title: "Mid",
        time: { created: 2 },
      },
      ses_leaf: {
        id: "ses_leaf",
        parentID: "ses_mid",
        title: "Leaf",
        time: { created: 3 },
      },
    });

    const tree = await resolveSessionTree("ses_root");

    expect(tree.map((node) => node.sessionID)).toEqual(["ses_root", "ses_mid", "ses_leaf"]);
  });

  it("throws SessionNotFoundError when the requested root session is missing", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({});

    await expect(resolveSessionTree("ses_missing")).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("session token summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns new and cached input token totals separately", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 4, write: 0 } },
      },
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 6, write: 0 } },
      },
    ]);

    const result = await getSessionTokenSummary("ses_root");

    expect(result).toEqual({
      sessionID: "ses_root",
      totalInput: 12,
      totalCachedInput: 10,
      totalCombinedInput: 22,
      totalOutput: 8,
      models: [
        {
          modelID: "gpt-5",
          input: 12,
          cachedInput: 10,
          totalInput: 22,
          output: 8,
        },
      ],
    });
  });
});

describe("aggregateUsage session scoping", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: { id: "ses_root", title: "Root Session", time: { created: 1 } },
      ses_child: {
        id: "ses_child",
        parentID: "ses_root",
        title: "Child Session",
        time: { created: 2 },
      },
      ses_unknown: { id: "ses_unknown", title: "Unknown Pricing", time: { created: 3 } },
    });
  });

  it("aggregates only the requested session set when sessionIDs are provided", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        sessionID: "ses_child",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_root", "ses_child"] });

    expect(storage.iterAssistantMessagesForSessions).toHaveBeenCalledWith({
      sessionIDs: ["ses_root", "ses_child"],
      sinceMs: undefined,
      untilMs: undefined,
    });
    expect(storage.iterAssistantMessagesForSession).not.toHaveBeenCalled();
    expect(result.totals.messageCount).toBe(2);
    expect(result.totals.sessionCount).toBe(2);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        title: "Root Session",
        messageCount: 1,
        costUsd: 15,
      }),
      expect.objectContaining({
        sessionID: "ses_child",
        title: "Child Session",
        messageCount: 1,
        costUsd: 5,
      }),
    ]);
  });

  it("keeps the single-session path unchanged for sessionID filters", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionID: "ses_root" });

    expect(storage.iterAssistantMessagesForSession).toHaveBeenCalledWith({
      sessionID: "ses_root",
      sinceMs: undefined,
      untilMs: undefined,
    });
    expect(storage.iterAssistantMessagesForSessions).not.toHaveBeenCalled();
    expect(result.totals.messageCount).toBe(1);
    expect(result.totals.sessionCount).toBe(1);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        title: "Root Session",
        messageCount: 1,
        costUsd: 5,
      }),
    ]);
  });

  it("keeps per-session breakdown rows for unknown-pricing usage", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_unknown",
        role: "assistant",
        providerID: "mystery-provider",
        modelID: "future-model",
        tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_unknown"] });

    expect(result.unknown).toHaveLength(1);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_unknown",
        title: "Unknown Pricing",
        messageCount: 1,
        costUsd: 0,
        tokens: expect.objectContaining({ input: 7, output: 2 }),
      }),
    ]);
  });
});

describe("aggregateUsage global view merges Claude Code CLI messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("folds standalone Claude Code CLI transcript usage into the global (non-session-scoped) aggregate", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    const claudeCliStorage = await import("../src/lib/claude-code-cli-storage.js");

    (storage.readAllSessionsIndex as any).mockResolvedValue({});
    (storage.iterAssistantMessages as any).mockResolvedValue([
      {
        sessionID: "ses_opencode",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);
    (claudeCliStorage.iterClaudeCodeCliMessages as any).mockResolvedValue([
      {
        id: "claude-cli:abc:0",
        sessionID: "abc",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sinceMs: 100, untilMs: 200 });

    expect(storage.iterAssistantMessages).toHaveBeenCalledWith({ sinceMs: 100, untilMs: 200 });
    expect(claudeCliStorage.iterClaudeCodeCliMessages).toHaveBeenCalledWith({
      sinceMs: 100,
      untilMs: 200,
    });
    // One message from each source landed in the aggregate.
    expect(result.totals.messageCount).toBe(2);
    expect(result.totals.sessionCount).toBe(2);
  });

  it("does not consult Claude Code CLI transcripts for session-scoped aggregation", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    const claudeCliStorage = await import("../src/lib/claude-code-cli-storage.js");

    (storage.readAllSessionsIndex as any).mockResolvedValue({});
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([]);

    await aggregateUsage({ sessionID: "ses_root" });

    expect(claudeCliStorage.iterClaudeCodeCliMessages).not.toHaveBeenCalled();
  });

  it("folds Codex CLI rollout usage into the global aggregate only", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    const claudeCliStorage = await import("../src/lib/claude-code-cli-storage.js");
    const codexCliStorage = await import("../src/lib/codex-cli-storage.js");

    (storage.readAllSessionsIndex as any).mockResolvedValue({});
    (storage.iterAssistantMessages as any).mockResolvedValue([]);
    (claudeCliStorage.iterClaudeCodeCliMessages as any).mockResolvedValue([]);
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([]);
    (codexCliStorage.iterCodexCliMessages as any).mockResolvedValue([
      {
        id: "codex:resp-1",
        sessionID: "thread-a",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 30, output: 7, reasoning: 3, cache: { read: 60, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sinceMs: 100, untilMs: 200 });

    expect(codexCliStorage.iterCodexCliMessages).toHaveBeenCalledWith({
      sinceMs: 100,
      untilMs: 200,
    });
    expect(result.totals.messageCount).toBe(1);
    expect(result.totals.sessionCount).toBe(1);

    vi.clearAllMocks();
    await aggregateUsage({ sessionID: "ses_root" });
    expect(codexCliStorage.iterCodexCliMessages).not.toHaveBeenCalled();
  });
});
