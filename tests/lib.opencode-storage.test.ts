import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

const sqliteMocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
  };
});

vi.mock("../src/lib/opencode-db-path.js", () => ({
  getOpenCodeDbPath: () => "/tmp/opencode.db",
}));

vi.mock("../src/lib/opencode-sqlite.js", () => ({
  openOpenCodeSqliteReadOnly: sqliteMocks.openOpenCodeSqliteReadOnly,
}));

describe("opencode storage multi-session reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fsMocks.existsSync.mockReturnValue(true);
  });

  it("queries completed assistant work by completion time across creation cutoffs", async () => {
    const completedSinceMs = Date.parse("2026-07-16T00:00:00.000Z");
    const completedUntilMs = Date.parse("2026-07-16T12:00:00.000Z");
    const conn = {
      get: vi.fn(() => ({ r: "assistant" })),
      all: vi.fn((sql: string, params?: unknown[]) => {
        expect(sql).toContain(`FROM "session_message"`);
        expect(sql).toContain("type = 'assistant'");
        expect(sql).toContain("type AS role");
        expect(sql).toContain(
          "CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END",
        );
        expect(sql).toContain("ORDER BY CAST(CASE WHEN json_valid(data)");
        expect(sql).not.toMatch(/SELECT[\s\S]*\bdata\b\s+FROM/);
        expect(sql).not.toContain("time_created >=");
        expect(params).toEqual([completedSinceMs, completedUntilMs]);
        return [
          {
            id: "cross-cutoff",
            session_id: "ses_one",
            time_created: completedSinceMs - 60_000,
            role: "assistant",
            provider_id: "openai",
            model_id: "gpt-5",
            tokens_input: 10,
            tokens_output: 5,
            tokens_reasoning: 2,
            tokens_cache_read: 3,
            tokens_cache_write: 4,
            cost: 0.01,
            time_completed: completedSinceMs + 1,
            agent: "build",
            mode: "primary",
          },
        ];
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterCompletedAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterCompletedAssistantMessages({
      completedSinceMs,
      completedUntilMs,
    });

    expect(messages.map((message) => message.id)).toEqual(["cross-cutoff"]);
    expect(messages[0]?.time?.completed).toBe(completedSinceMs + 1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5",
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
      cost: 0.01,
      agent: "build",
      mode: "primary",
    });
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("projects normal assistant reads without selecting message payloads", async () => {
    const conn = {
      get: vi.fn(() => ({ r: "assistant" })),
      all: vi.fn((sql: string) => {
        expect(sql).toContain("type = 'assistant'");
        expect(sql).toContain("type AS role");
        expect(sql).not.toMatch(/SELECT[\s\S]*\bdata\b\s+FROM/);
        return [
          {
            id: "msg_projected",
            session_id: "ses_one",
            time_created: 100,
            role: "assistant",
            provider_id: "openai",
            model_id: "gpt-5",
            tokens_input: 11,
            tokens_output: 7,
            tokens_reasoning: null,
            tokens_cache_read: 2,
            tokens_cache_write: 1,
            cost: 0.02,
            time_completed: 101,
            agent: null,
            mode: null,
          },
        ];
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessages({ sinceMs: 100, untilMs: 200 });

    expect(messages).toEqual([
      {
        id: "msg_projected",
        sessionID: "ses_one",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 11, output: 7, cache: { read: 2, write: 1 } },
        cost: 0.02,
        time: { created: 100, completed: 101 },
        agent: undefined,
        mode: undefined,
      },
    ]);
  });

  it("guards malformed JSON without reading payloads", async () => {
    const conn = {
      get: vi.fn(() => ({ r: "assistant" })),
      all: vi.fn((sql: string) => {
        expect(sql).toContain(
          "CASE WHEN json_valid(data) THEN json_extract(data, '$.tokens.input') END",
        );
        expect(sql).not.toMatch(/SELECT[\s\S]*\bdata\b\s+FROM/);
        return [];
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    await expect(iterAssistantMessages({})).resolves.toEqual([]);
  });

  it("does not fall back to scanning message payloads without SQLite JSON support", async () => {
    const conn = {
      get: vi.fn(() => null),
      all: vi.fn(),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { getOpenCodeDbStats, iterAssistantMessages, iterCompletedAssistantMessages } =
      await import("../src/lib/opencode-storage.js");

    await expect(iterAssistantMessages({})).resolves.toEqual([]);
    await expect(iterCompletedAssistantMessages({})).resolves.toEqual([]);
    await expect(getOpenCodeDbStats()).resolves.toMatchObject({ assistantMessageCount: 0 });

    expect(conn.all).not.toHaveBeenCalled();
  });

  it("chunks large session queries below the SQLite bind limit and preserves message order", async () => {
    const conn = {
      all: vi.fn((_: string, params?: unknown[]) => {
        const sessionParams = (params ?? []).filter(
          (value): value is string => typeof value === "string" && value.startsWith("ses_"),
        );

        expect(params?.length ?? 0).toBeLessThanOrEqual(900);

        if (sessionParams.includes("ses_999")) {
          return [
            {
              id: "msg-second-batch",
              session_id: "ses_999",
              time_created: 10,
              role: "assistant",
            },
          ];
        }

        return [
          {
            id: "msg-first-batch",
            session_id: "ses_000",
            time_created: 20,
            role: "assistant",
          },
        ];
      }),
      get: vi.fn(() => ({ r: "assistant" })),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);

    const { iterAssistantMessagesForSessions } = await import("../src/lib/opencode-storage.js");
    const sessionIDs = Array.from(
      { length: 1000 },
      (_, index) => `ses_${String(index).padStart(3, "0")}`,
    );

    const messages = await iterAssistantMessagesForSessions({
      sessionIDs,
      sinceMs: 100,
      untilMs: 200,
    });

    expect(sqliteMocks.openOpenCodeSqliteReadOnly).toHaveBeenCalledWith("/tmp/opencode.db");
    expect(conn.all).toHaveBeenCalledTimes(2);
    expect(messages.map((message) => message.id)).toEqual(["msg-second-batch", "msg-first-batch"]);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});

describe("opencode storage forked session copies", () => {
  const originalRow = {
    id: "msg_01original",
    session_id: "ses_parent",
    time_created: 100,
    role: "assistant",
    provider_id: "openai",
    model_id: "gpt-5",
    tokens_input: 1000,
    tokens_output: 500,
    tokens_reasoning: 10,
    tokens_cache_read: 20,
    tokens_cache_write: 30,
    cost: 10,
    time_completed: 150,
    agent: "build",
    mode: null,
  };
  // Message ids ascend with time. OpenCode copies finished parent rows into the
  // fork with a newer id and identical data.
  const forkCopyRow = { ...originalRow, id: "msg_05forkevent_1", session_id: "ses_fork" };
  const forkNewRow = {
    ...originalRow,
    id: "msg_06forknew",
    session_id: "ses_fork",
    time_created: 200,
    tokens_input: 40,
    cost: 1,
    time_completed: 250,
  };

  function mockConnection(rowsForSql: (sql: string, params?: unknown[]) => unknown[]) {
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue({
      get: vi.fn((sql: string) => (sql.includes("session_v2") ? { ok: 1 } : { r: "assistant" })),
      all: vi.fn(rowsForSql),
      close: vi.fn(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fsMocks.existsSync.mockReturnValue(true);
  });

  it("counts a forked session's copied message once in all-history reads", async () => {
    mockConnection(() => [originalRow, forkCopyRow, forkNewRow]);

    const { iterAssistantMessages, iterCompletedAssistantMessages } = await import(
      "../src/lib/opencode-storage.js"
    );

    const messages = await iterAssistantMessages({});
    expect(messages.map((message) => message.id)).toEqual(["msg_01original", "msg_06forknew"]);

    const completed = await iterCompletedAssistantMessages({});
    expect(completed.map((message) => message.id)).toEqual(["msg_01original", "msg_06forknew"]);
  });

  it("counts a forked session's copied message once across a session set", async () => {
    mockConnection((_sql, params) => {
      const sessionIDs = params ?? [];
      return [originalRow, forkCopyRow, forkNewRow].filter((row) =>
        sessionIDs.includes(row.session_id),
      );
    });

    const { iterAssistantMessagesForSessions } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessagesForSessions({
      sessionIDs: ["ses_parent", "ses_fork"],
    });

    expect(messages.map((message) => message.id)).toEqual(["msg_01original", "msg_06forknew"]);
  });

  it("keeps a fork's copied history in its own single-session read", async () => {
    mockConnection(() => [forkCopyRow, forkNewRow]);

    const { iterAssistantMessagesForSession } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessagesForSession({ sessionID: "ses_fork" });

    expect(messages.map((message) => message.id)).toEqual(["msg_05forkevent_1", "msg_06forknew"]);
  });

  it("keeps finished messages that differ only in tokens and identical unfinished messages across sessions", async () => {
    const otherTokensRow = {
      ...originalRow,
      id: "msg_other_tokens",
      session_id: "ses_fork",
      tokens_output: 501,
    };
    const unfinishedRow = {
      ...originalRow,
      id: "msg_unfinished_a",
      time_created: 300,
      time_completed: null,
    };
    const unfinishedTwinRow = { ...unfinishedRow, id: "msg_unfinished_b", session_id: "ses_fork" };
    mockConnection(() => [originalRow, otherTokensRow, unfinishedRow, unfinishedTwinRow]);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessages({});

    expect(messages.map((message) => message.id)).toEqual([
      "msg_01original",
      "msg_other_tokens",
      "msg_unfinished_a",
      "msg_unfinished_b",
    ]);
  });

  it("keeps identical finished messages that are in the same session", async () => {
    const sameSessionTwinRow = { ...originalRow, id: "msg_02sametwin" };
    mockConnection(() => [originalRow, sameSessionTwinRow]);

    const { iterAssistantMessages, iterCompletedAssistantMessages } = await import(
      "../src/lib/opencode-storage.js"
    );

    const messages = await iterAssistantMessages({});
    expect(messages.map((message) => message.id)).toEqual(["msg_01original", "msg_02sametwin"]);

    const completed = await iterCompletedAssistantMessages({});
    expect(completed.map((message) => message.id)).toEqual(["msg_01original", "msg_02sametwin"]);
  });

  it("drops both fork copies when the parent has two identical messages", async () => {
    const parentTwinRow = { ...originalRow, id: "msg_02parenttwin" };
    const forkTwinCopyRow = { ...originalRow, id: "msg_05forkevent_2", session_id: "ses_fork" };
    mockConnection(() => [originalRow, parentTwinRow, forkCopyRow, forkTwinCopyRow]);

    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessages({});

    expect(messages.map((message) => message.id)).toEqual(["msg_01original", "msg_02parenttwin"]);
  });

  it("keeps both identical messages when an earlier fork copied one and a later fork copied both", async () => {
    // The parent had two identical messages. The earlier fork copied only the
    // first; the later fork copied both. The parent is not read or was deleted.
    const laterForkCopyRow = {
      ...originalRow,
      id: "msg_07laterforkevent_1",
      session_id: "ses_later_fork",
    };
    const laterForkTwinCopyRow = { ...laterForkCopyRow, id: "msg_07laterforkevent_2" };
    mockConnection(() => [forkCopyRow, laterForkCopyRow, laterForkTwinCopyRow]);

    const { iterAssistantMessages, iterAssistantMessagesForSessions } = await import(
      "../src/lib/opencode-storage.js"
    );

    const sessionMessages = await iterAssistantMessagesForSessions({
      sessionIDs: ["ses_fork", "ses_later_fork"],
    });
    expect(sessionMessages.map((message) => message.id)).toEqual([
      "msg_05forkevent_1",
      "msg_07laterforkevent_2",
    ]);

    const allMessages = await iterAssistantMessages({});
    expect(allMessages.map((message) => message.id)).toEqual([
      "msg_05forkevent_1",
      "msg_07laterforkevent_2",
    ]);
  });

  it("counts a fork copy once when the original and copy come from different query chunks", async () => {
    const fillerSessionIDs = Array.from({ length: 899 }, (_, index) => `ses_filler_${index}`);
    const queriedChunks: unknown[][] = [];
    mockConnection((_sql, params) => {
      const sessionIDs = params ?? [];
      queriedChunks.push(sessionIDs);
      return [originalRow, forkCopyRow, forkNewRow].filter((row) =>
        sessionIDs.includes(row.session_id),
      );
    });

    const { iterAssistantMessagesForSessions } = await import("../src/lib/opencode-storage.js");
    const messages = await iterAssistantMessagesForSessions({
      sessionIDs: ["ses_parent", ...fillerSessionIDs, "ses_fork"],
    });

    expect(queriedChunks).toHaveLength(2);
    expect(queriedChunks[0]).toContain("ses_parent");
    expect(queriedChunks[0]).not.toContain("ses_fork");
    expect(queriedChunks[1]).toEqual(["ses_fork"]);
    expect(messages.map((message) => message.id)).toEqual(["msg_01original", "msg_06forknew"]);
  });
});
