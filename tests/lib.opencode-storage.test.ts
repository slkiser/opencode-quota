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

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({
    dataDirs: ["/tmp/opencode"],
    configDirs: ["/tmp/opencode"],
    cacheDirs: ["/tmp/opencode"],
    stateDirs: ["/tmp/opencode"],
  }),
}));

vi.mock("../src/lib/path-pick.js", () => ({
  pickFirstExistingPath: vi.fn(() => "/tmp/opencode.db"),
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
        expect(sql).toContain("json_extract(data, '$.time.completed')");
        expect(sql).toContain("ORDER BY CAST(json_extract(data, '$.time.completed') AS REAL)");
        expect(sql).not.toContain("time_created >=");
        expect(params).toEqual([completedSinceMs, completedUntilMs]);
        return [
          {
            id: "cross-cutoff",
            session_id: "ses_one",
            time_created: completedSinceMs - 60_000,
            data: JSON.stringify({
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              time: { completed: completedSinceMs + 1 },
            }),
          },
          {
            id: "unfinished",
            session_id: "ses_two",
            time_created: completedSinceMs + 1,
            data: JSON.stringify({
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              time: {},
            }),
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
    expect(conn.close).toHaveBeenCalledOnce();
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
              data: JSON.stringify({ role: "assistant" }),
            },
          ];
        }

        return [
          {
            id: "msg-first-batch",
            session_id: "ses_000",
            time_created: 20,
            data: JSON.stringify({ role: "assistant" }),
          },
        ];
      }),
      get: vi.fn(),
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
  function messageRow(params: {
    id: string;
    sessionID: string;
    created?: number;
    completed?: number | null;
    input?: number;
    output?: number;
    cost?: number;
  }) {
    const created = params.created ?? 100;
    const completed = params.completed === undefined ? 150 : params.completed;
    return {
      id: params.id,
      session_id: params.sessionID,
      time_created: created,
      data: JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: {
          input: params.input ?? 1000,
          output: params.output ?? 500,
          reasoning: 10,
          cache: { read: 20, write: 30 },
        },
        cost: params.cost ?? 10,
        time: completed === null ? { created } : { created, completed },
        agent: "build",
      }),
    };
  }

  const originalRow = messageRow({ id: "msg_01original", sessionID: "ses_parent" });
  // Message ids ascend with time. OpenCode copies finished parent rows into the
  // fork with a newer id and identical data.
  const forkCopyRow = messageRow({ id: "msg_05forkevent_1", sessionID: "ses_fork" });
  const forkNewRow = messageRow({
    id: "msg_06forknew",
    sessionID: "ses_fork",
    created: 200,
    completed: 250,
    input: 40,
    cost: 1,
  });

  function mockConnection(
    rowsForSql: (sql: string, params?: unknown[]) => unknown[],
    options: { jsonExtract?: boolean } = {},
  ) {
    const jsonExtractResult = options.jsonExtract === false ? null : "assistant";
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue({
      get: vi.fn((sql: string) =>
        sql.includes('FROM "session"') ? { ok: 1 } : { r: jsonExtractResult },
      ),
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

  it("counts a forked session's copied message once in completed reads without json_extract", async () => {
    mockConnection(() => [forkNewRow, forkCopyRow, originalRow], { jsonExtract: false });

    const { iterCompletedAssistantMessages } = await import("../src/lib/opencode-storage.js");
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

  it("keeps finished messages that differ only in tokens and identical unfinished messages", async () => {
    const otherTokensRow = messageRow({
      id: "msg_other_tokens",
      sessionID: "ses_parent",
      output: 501,
    });
    const unfinishedRow = messageRow({
      id: "msg_unfinished_a",
      sessionID: "ses_parent",
      created: 300,
      completed: null,
    });
    const unfinishedTwinRow = { ...unfinishedRow, id: "msg_unfinished_b" };
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
