import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
}));

const sqliteMocks = vi.hoisted(() => ({
  openOpenCodeSqliteReadOnly: vi.fn(),
}));

const claudeMocks = vi.hoisted(() => ({
  iterClaudeCodeCliMessages: vi.fn(async (): Promise<OpenCodeMessage[]> => []),
}));
vi.mock("../src/lib/claude-code-cli-storage.js", () => claudeMocks);
vi.mock("../src/lib/codex-cli-storage.js", () => ({
  iterCodexCliMessages: vi.fn(async (): Promise<OpenCodeMessage[]> => []),
}));

vi.mock("fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs")>();
  return {
    ...mod,
    existsSync: fsMocks.existsSync,
    readdirSync: vi.fn(() => []),
  };
});

const writes = vi.hoisted(() => ({ writeFile: vi.fn(async () => undefined) }));
vi.mock("fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs/promises")>()),
  writeFile: writes.writeFile,
}));

describe("forked session usage", () => {
  function row(id: string, session: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      session_id: session,
      time_created: 100,
      data: JSON.stringify({
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-4o",
        tokens: { input: 1000, output: 500, reasoning: 10, cache: { read: 20, write: 30 } },
        cost: 10,
        time: { created: 100, completed: 150 },
        ...overrides,
      }),
    };
  }
  const parent = row("msg_01original", "ses_parent");
  const copy = row("msg_05fork", "ses_fork");
  const fresh = {
    ...row("msg_06new", "ses_fork", { time: { created: 200, completed: 250 }, cost: 1 }),
    time_created: 200,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fsMocks.existsSync.mockReturnValue(true);
    claudeMocks.iterClaudeCodeCliMessages.mockResolvedValue([]);
  });

  function connect(rows: ReturnType<typeof row>[]) {
    const conn = {
      get: vi.fn(() => ({ ok: 1 })),
      all: vi.fn((sql: string, args?: unknown[]) => {
        if (sql.includes('FROM "session"')) return [];
        const sessions =
          args?.filter((arg) => typeof arg === "string" && arg.startsWith("ses_")) ?? [];
        return sessions.length ? rows.filter((item) => sessions.includes(item.session_id)) : rows;
      }),
      close: vi.fn(),
    };
    sqliteMocks.openOpenCodeSqliteReadOnly.mockResolvedValue(conn);
    return conn;
  }

  it("counts parent history once across forks and retains new messages", async () => {
    connect([parent, copy, fresh, row("msg_07nested", "ses_nested")]);
    const storage = await import("../src/lib/opencode-storage.js");
    expect((await storage.iterAssistantMessages({})).map((message) => message.id)).toEqual([
      parent.id,
      fresh.id,
    ]);
    expect(
      (
        await storage.iterAssistantMessagesForSessions({
          sessionIDs: ["ses_parent", "ses_fork", "ses_nested"],
        })
      ).map((message) => message.id),
    ).toEqual([parent.id, fresh.id]);
  });

  it("retains copied history when viewing just the fork session", async () => {
    connect([parent, copy, fresh]);
    const { iterAssistantMessagesForSession } = await import("../src/lib/opencode-storage.js");
    expect(
      (await iterAssistantMessagesForSession({ sessionID: "ses_fork" })).map(
        (message) => message.id,
      ),
    ).toEqual([copy.id, fresh.id]);
  });

  it("preserves real repeats within a session using the maximum per-session multiplicity", async () => {
    const parentTwin = { ...parent, id: "msg_02twin" };
    const forkTwin = { ...copy, id: "msg_05fork_twin" };
    connect([parent, parentTwin, copy, forkTwin]);
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    expect((await iterAssistantMessages({})).map((message) => message.id)).toEqual([
      parent.id,
      parentTwin.id,
    ]);
    connect([
      copy,
      { ...forkTwin, session_id: "ses_late" },
      { ...forkTwin, id: "msg_08late", session_id: "ses_late" },
    ]);
    expect(await iterAssistantMessages({})).toHaveLength(2);
  });

  it("keeps changed usage, missing completion, and incomplete identity as distinct observations", async () => {
    const rows = [
      parent,
      row("msg_02model", "ses_fork", { modelID: "gpt-4o-mini" }),
      row("msg_03cost", "ses_fork", { cost: 11 }),
      row("msg_04stream", "ses_parent", { time: { created: 100 } }),
      row("msg_05stream", "ses_fork", { time: { created: 100 } }),
      row("msg_06unknown", "ses_parent", { modelID: undefined }),
      row("msg_07unknown", "ses_fork", { modelID: undefined }),
    ];
    connect(rows);
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    expect(await iterAssistantMessages({})).toHaveLength(rows.length);
  });

  it("deduplicates copies even when related sessions cross the SQLite query chunk boundary", async () => {
    const conn = connect([parent, copy, fresh]);
    const { iterAssistantMessagesForSessions } = await import("../src/lib/opencode-storage.js");
    const filler = Array.from({ length: 900 }, (_, i) => `ses_empty_${i}`);
    const messages = await iterAssistantMessagesForSessions({
      sessionIDs: ["ses_parent", ...filler, "ses_fork"],
    });
    expect(conn.all).toHaveBeenCalledTimes(2);
    expect(messages.map((message) => message.id)).toEqual([parent.id, fresh.id]);
  });

  it("exports corrected version-2 sync totals and uses them in local merged usage", async () => {
    vi.stubEnv("OPENCODE_QUOTA_SYNC_DIR", "/tmp/quota-sync-fixture");
    connect([parent, copy, fresh]);
    const { exportTokenSync, loadMergedTokenUsage } = await import("../src/lib/token-sync.js");
    const exported = await exportTokenSync();
    expect(exported.version).toBe(2);
    expect(Object.values(exported.sessions).reduce((sum, session) => sum + session.i, 0)).toBe(
      2000,
    );
    expect(exported.sessions.ses_fork.i).toBe(1000);
    expect(writes.writeFile).toHaveBeenCalledWith(
      expect.any(String),
      JSON.stringify(exported, null, 2),
      "utf-8",
    );
    const merged = await loadMergedTokenUsage();
    expect(merged.totals.tokens.input).toBe(2000);
    expect(merged.totals.messages).toBe(2);
  });

  it("corrects global aggregation while leaving the separate Claude CLI source intact", async () => {
    connect([parent, copy, fresh]);
    claudeMocks.iterClaudeCodeCliMessages.mockResolvedValue([
      {
        id: parent.id,
        sessionID: "claude-cli-session",
        role: "assistant",
        providerID: "claudecode",
        modelID: "gpt-4o",
        tokens: { input: 1000, output: 500, cache: { read: 20, write: 30 } },
        time: { created: 100, completed: 150 },
      },
    ]);
    const { aggregateUsage } = await import("../src/lib/quota-stats.js");
    const aggregate = await aggregateUsage({});
    expect(aggregate.totals.messageCount).toBe(3);
    expect(
      aggregate.totals.priced.input +
        aggregate.totals.unknown.input +
        aggregate.totals.unpriced.input,
    ).toBe(3000);
  });
});

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: "/tmp/opencode",
    configDir: "/tmp/opencode",
    cacheDir: "/tmp/opencode",
    stateDir: "/tmp/opencode",
  }),
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
