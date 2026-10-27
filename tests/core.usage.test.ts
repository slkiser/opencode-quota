import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  sessionUsage,
  type UsageQuery,
  type UsageRow,
  usageReport,
  withProviderNames,
} from "../src/core/usage.js";
import { usePricingSettings } from "../src/lib/modelsdev-pricing.js";
import { resolveSessionTree } from "../src/lib/opencode-storage.js";
import {
  type SessionDatabaseMessage,
  type SessionDatabaseSession,
  writeSessionDatabase,
} from "./helpers/session-database.js";

const M = 1_000_000;

/** Test prices in USD per 1M tokens. `claude-plain` has no cache rates: cache tokens cost as input. */
const TEST_PRICES = {
  "claude-test": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-plain": { input: 1, output: 4 },
};

/** A local time relative to the tests' "now", noon on Sunday 2026-03-15. */
function at(dayOffset: number, hours: number, minutes = 0, seconds = 0, ms = 0): number {
  return new Date(2026, 2, 15 + dayOffset, hours, minutes, seconds, ms).getTime();
}

const NOW = at(0, 12);

/** The time zone `NOW` and the other times made at load are in; the DST tests switch away. */
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-quota-usage-"));
  // OpenCode's database and the downloaded price list live under these roots.
  vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  vi.stubEnv("OPENCODE_DB", undefined);
  // A downloaded price list newer than the bundled one wins, so the test prices apply.
  const pricesFile = join(
    root,
    "cache",
    "opencode",
    "opencode-quota",
    "modelsdev-pricing.runtime.min.json",
  );
  await mkdir(dirname(pricesFile), { recursive: true });
  await writeFile(
    pricesFile,
    JSON.stringify({
      _meta: {
        source: "test",
        generatedAt: Date.now(),
        providers: ["anthropic"],
        units: "USD per 1M tokens",
      },
      providers: { anthropic: TEST_PRICES },
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let messageCount = 0;

/** A finished `claude-test` message from Anthropic in `ses_main`, with `fields` on top. */
function message(
  fields: Partial<SessionDatabaseMessage> & { created: number },
): SessionDatabaseMessage {
  messageCount += 1;
  return {
    id: `msg_${String(messageCount).padStart(4, "0")}`,
    sessionID: "ses_main",
    providerID: "anthropic",
    modelID: "claude-test",
    completed: fields.created + 1_000,
    ...fields,
  };
}

function databasePath(): string {
  return join(root, "data", "opencode", "opencode.db");
}

/**
 * Writes OpenCode's database, replacing any earlier one: `sessions`, plus a plain session for
 * every other session id.
 */
function writeHistory(
  messages: SessionDatabaseMessage[],
  sessions: SessionDatabaseSession[] = [],
): void {
  const listed = new Set(sessions.map((session) => session.id));
  const unlisted = [...new Set(messages.map((item) => item.sessionID))]
    .filter((id) => !listed.has(id))
    .map((id) => ({ id, created: 0 }));
  rmSync(databasePath(), { force: true });
  writeSessionDatabase(databasePath(), { sessions: [...sessions, ...unlisted], messages });
}

function sum(rows: UsageRow[], field: "costShare" | "tokenShare" | "tokens"): number {
  return rows.reduce((total, row) => total + row[field], 0);
}

describe("usage report ranges", () => {
  // Output tokens tell the messages apart: each one has its own power of two.
  const history = () => [
    message({ created: at(0, 9), tokens: { output: 1 } }),
    message({ created: at(-1, 23, 59, 59, 999), tokens: { output: 2 } }),
    message({ created: at(-6, 0), tokens: { output: 4 } }),
    message({ created: at(-7, 23, 59, 59, 999), tokens: { output: 8 } }),
    message({ created: at(-29, 0), tokens: { output: 16 } }),
    message({ created: at(-30, 12), tokens: { output: 32 } }),
    message({ created: at(-89, 0), tokens: { output: 64 } }),
    message({ created: at(-90, 23, 59, 59, 999), tokens: { output: 128 } }),
  ];

  const cases: Array<{ query: UsageQuery; tokens: number; days: [string, string, number] }> = [
    { query: { range: "today" }, tokens: 1, days: ["2026-03-15", "2026-03-15", 1] },
    { query: { range: "7d" }, tokens: 1 + 2 + 4, days: ["2026-03-09", "2026-03-15", 7] },
    { query: { range: "30d" }, tokens: 31, days: ["2026-02-14", "2026-03-15", 30] },
    // 90d starts 89 days before today, on 2025-12-16.
    { query: { range: "90d" }, tokens: 127, days: ["2025-12-16", "2026-03-15", 90] },
    // All time runs from the first to the last message: the one 90 days ago counts too.
    { query: { range: "all" }, tokens: 255, days: ["2025-12-15", "2026-03-15", 91] },
    {
      query: { range: "between", from: "2026-03-08", to: "2026-03-14" },
      tokens: 2 + 4 + 8,
      days: ["2026-03-08", "2026-03-14", 7],
    },
  ];

  it.each(cases)("$query.range counts the messages of its local days", async (item) => {
    writeHistory(history());

    const report = await usageReport(item.query, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    const [firstDay, lastDay, dayCount] = item.days;
    expect(report.days).toHaveLength(dayCount);
    expect(report.days[0]?.date).toBe(firstDay);
    expect(report.days.at(-1)?.date).toBe(lastDay);
    expect(sum(report.days, "tokens")).toBe(item.tokens);
  });

  it("counts the rolling last 24 hours for 24h, not calendar days", async () => {
    writeHistory([
      message({ created: at(-1, 11, 59, 59, 999), tokens: { output: 1 } }),
      message({ created: at(-1, 12), tokens: { output: 2 } }),
      message({ created: at(0, 11), tokens: { output: 4 } }),
    ]);

    const report = await usageReport({ range: "24h" }, NOW);

    expect(report).toMatchObject({ sinceMs: at(-1, 12), untilMs: NOW });
    expect(report.totals.tokens.processed).toBe(2 + 4);
    expect(report.days.map(({ date, tokens }) => [date, tokens])).toEqual([
      ["2026-03-14", 2],
      ["2026-03-15", 4],
    ]);
  });

  it("puts each message on its local day across midnight", async () => {
    writeHistory([
      message({ created: at(-1, 23, 59, 59, 999), tokens: { output: 1 } }),
      message({ created: at(0, 0), tokens: { output: 2 } }),
    ]);

    const week = await usageReport({ range: "7d" }, NOW);
    expect(week.days.slice(-2).map(({ date, tokens }) => ({ date, tokens }))).toEqual([
      { date: "2026-03-14", tokens: 1 },
      { date: "2026-03-15", tokens: 2 },
    ]);

    // A date range ends just before the next day starts: the midnight message is not in it.
    const oneDay = await usageReport(
      { range: "between", from: "2026-03-14", to: "2026-03-14" },
      NOW,
    );
    expect(oneDay).toMatchObject({ sinceMs: at(-1, 0), untilMs: at(0, 0) - 1 });
    expect(oneDay.totals.tokens.processed).toBe(1);
  });

  it("reports zeros, not an error, before OpenCode has any history", async () => {
    const quarter = await usageReport({ range: "90d" }, NOW);
    expect(quarter.totals).toEqual({
      costUsd: 0,
      sessions: 0,
      tokens: { processed: 0, cachedInput: 0, uncachedInput: 0, output: 0 },
      tokensByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
      unpricedTokens: 0,
      unpricedShare: 0,
    });
    expect(quarter.providers).toEqual([]);
    expect(quarter.days).toHaveLength(90);

    // All time has no window, so no days either.
    const all = await usageReport({ range: "all" }, NOW);
    expect(all).not.toHaveProperty("sinceMs");
    expect(all).not.toHaveProperty("untilMs");
    expect(all.totals.tokens.processed).toBe(0);
    expect(all.days).toEqual([]);

    const week = await usageReport({ range: "7d" }, NOW);
    expect(week.days.map((day) => [day.tokens, day.costShare, day.tokenShare])).toEqual(
      Array.from({ length: 7 }, () => [0, 0, 0]),
    );
  });

  it.each<{ query: UsageQuery; error: string }>([
    {
      query: { range: "between", from: "2026-03-14", to: "2026-03-08" },
      error: "to (2026-03-08) is before from (2026-03-14)",
    },
    {
      query: { range: "between", from: "2026-02-31", to: "2026-03-08" },
      error: "from must be a date like 2026-01-31",
    },
    // 2026 is no leap year.
    {
      query: { range: "between", from: "2026-02-01", to: "2026-02-29" },
      error: "to must be a date like 2026-01-31",
    },
    {
      query: { range: "between", from: "2026-04-31", to: "2026-05-01" },
      error: "from must be a date like 2026-01-31",
    },
    { query: { range: "between", from: "2026-03-01" }, error: "to must be a date like 2026-01-31" },
    { query: { range: "session" }, error: "sessionID is required for range session" },
    {
      query: { range: "session", sessionID: "ses_missing" },
      error: "Session not found: ses_missing",
    },
    // Without its subagents, the session is checked all the same.
    {
      query: { range: "session", sessionID: "ses_missing", subagents: false },
      error: "Session not found: ses_missing",
    },
    {
      query: { range: "session", sessionID: "missing", subagents: false },
      error: "Session not found: missing",
    },
  ])("rejects $query.range: $error", async ({ query, error }) => {
    writeHistory([message({ created: at(0, 8) })]);

    await expect(usageReport(query, NOW)).rejects.toThrow(error);
  });

  it("takes a leap day in a leap year", async () => {
    const report = await usageReport(
      { range: "between", from: "2028-02-29", to: "2028-02-29" },
      NOW,
    );

    expect(report).toMatchObject({
      sinceMs: new Date(2028, 1, 29).getTime(),
      untilMs: new Date(2028, 2, 1).getTime() - 1,
    });
    expect(report.days.map((day) => day.date)).toEqual(["2028-02-29"]);
  });

  describe("across daylight saving time changes (New York)", () => {
    const HOUR_MS = 60 * 60 * 1000;
    beforeEach(() => {
      vi.stubEnv("TZ", "America/New_York");
    });
    // Unstubbing deletes TZ again. On Windows, Node then keeps New York time instead of going
    // back to the system zone, and the later tests would mix it with `NOW`. So each test
    // switches back by name first.
    afterEach(() => {
      vi.stubEnv("TZ", LOCAL_TIME_ZONE);
    });

    it("counts 24h as 24 real hours over the short day clocks spring forward", async () => {
      // 2026-03-08 has 23 hours: 02:00 does not happen.
      const now = new Date(2026, 2, 8, 12).getTime();
      writeHistory([
        message({ created: new Date(2026, 2, 7, 10, 59).getTime(), tokens: { output: 1 } }),
        message({ created: new Date(2026, 2, 7, 11).getTime(), tokens: { output: 2 } }),
        message({ created: new Date(2026, 2, 8, 3, 30).getTime(), tokens: { output: 4 } }),
      ]);

      const report = await usageReport({ range: "24h" }, now);

      // 24 hours back is 11:00 the day before, not 12:00.
      expect(report).toMatchObject({ sinceMs: new Date(2026, 2, 7, 11).getTime(), untilMs: now });
      expect(report.totals.tokens.processed).toBe(2 + 4);
      expect(report.days.map(({ date, tokens }) => [date, tokens])).toEqual([
        ["2026-03-07", 2],
        ["2026-03-08", 4],
      ]);
    });

    it("keeps both 1:30s of the long day clocks fall back on that one day", async () => {
      // 2026-11-01 has 25 hours: 01:00 to 02:00 happens twice.
      const firstHalfPastOne = new Date(2026, 10, 1, 1, 30).getTime();
      writeHistory([
        message({ created: firstHalfPastOne, tokens: { output: 1 } }),
        message({ created: firstHalfPastOne + HOUR_MS, tokens: { output: 2 } }),
        message({ created: new Date(2026, 10, 2, 0, 30).getTime(), tokens: { output: 4 } }),
      ]);

      const report = await usageReport(
        { range: "between", from: "2026-11-01", to: "2026-11-01" },
        new Date(2026, 10, 2, 12).getTime(),
      );

      expect(report.untilMs - report.sinceMs + 1).toBe(25 * HOUR_MS);
      expect(report.totals.tokens.processed).toBe(1 + 2);
      expect(report.days.map(({ date, tokens }) => [date, tokens])).toEqual([["2026-11-01", 3]]);
    });

    it("gives 7d seven calendar days across the short day", async () => {
      const report = await usageReport({ range: "7d" }, new Date(2026, 2, 10, 12).getTime());

      expect(report.days.map((day) => day.date)).toEqual([
        "2026-03-04",
        "2026-03-05",
        "2026-03-06",
        "2026-03-07",
        "2026-03-08",
        "2026-03-09",
        "2026-03-10",
      ]);
      expect(report.sinceMs).toBe(new Date(2026, 2, 4).getTime());
    });
  });
});

describe("usage report sessions", () => {
  const sessions = [
    { id: "ses_root", created: 1 },
    { id: "ses_child", parentID: "ses_root", created: 2 },
    { id: "ses_grandchild", parentID: "ses_child", created: 3 },
    { id: "ses_other", created: 4 },
  ];
  const history = () => [
    message({ sessionID: "ses_root", created: at(0, 8), tokens: { output: 1 } }),
    message({ sessionID: "ses_child", created: at(0, 9), tokens: { output: 2 } }),
    message({ sessionID: "ses_grandchild", created: at(0, 10), tokens: { output: 4 } }),
    message({ sessionID: "ses_other", created: at(0, 11), tokens: { output: 8 } }),
  ];

  it.each<{ query: UsageQuery; tokens: number; sessions: number }>([
    // A session counts with its subagent sessions, and theirs.
    { query: { range: "session", sessionID: "ses_root" }, tokens: 1 + 2 + 4, sessions: 1 },
    { query: { range: "session", sessionID: "ses_child" }, tokens: 2 + 4, sessions: 1 },
    // Without its subagents, the session alone.
    {
      query: { range: "session", sessionID: "ses_root", subagents: false },
      tokens: 1,
      sessions: 1,
    },
    // Subagent sessions count as part of their top session.
    { query: { range: "today" }, tokens: 15, sessions: 2 },
  ])("$query.range $query.sessionID counts $sessions session(s)", async (item) => {
    writeHistory(history(), sessions);

    const report = await usageReport(item.query, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    expect(report.totals.sessions).toBe(item.sessions);
    expect(report.providers.map((provider) => provider.sessions)).toEqual([item.sessions]);
    expect(report.sessionID).toBe(item.query.sessionID);
  });

  it("lists a session's tree depth first, children oldest first", async () => {
    writeHistory(
      [],
      [
        { id: "ses_root", created: 1 },
        { id: "ses_child_b", parentID: "ses_root", created: 30 },
        { id: "ses_grandchild", parentID: "ses_child_a", created: 20 },
        { id: "ses_child_a", parentID: "ses_root", created: 10 },
        { id: "ses_other", created: 5 },
      ],
    );

    await expect(resolveSessionTree("ses_root")).resolves.toEqual([
      "ses_root",
      "ses_child_a",
      "ses_grandchild",
      "ses_child_b",
    ]);
  });

  describe("forks", () => {
    // A fork made at 09:30 from ses_parent, and the fork's own subagent.
    const forkSessions = [
      { id: "ses_parent", created: at(0, 7) },
      { id: "ses_fork", forkOf: "ses_parent", created: at(0, 9, 30) },
      { id: "ses_fork_child", parentID: "ses_fork", created: at(0, 10) },
    ];
    const forkHistory = (forkAddsWork: boolean) => {
      const parent = [
        message({ sessionID: "ses_parent", created: at(0, 8), tokens: { output: 1 } }),
        message({
          type: "compaction",
          sessionID: "ses_parent",
          created: at(0, 9),
          tokens: { output: 2 },
        }),
      ];
      // OpenCode copies the parent's settled rows into the fork: new ids, same times and data.
      const copies = parent.map((original, index) => ({
        ...original,
        id: `msg_fork_copy_${index}`,
        sessionID: "ses_fork",
      }));
      const added = forkAddsWork
        ? [
            message({ sessionID: "ses_fork", created: at(0, 10), tokens: { output: 4 } }),
            message({ sessionID: "ses_fork_child", created: at(0, 10, 30), tokens: { output: 8 } }),
          ]
        : [];
      return [...parent, ...copies, ...added];
    };

    it.each<{ query: UsageQuery; forkAddsWork: boolean; tokens: number; sessions: number }>([
      { query: { range: "90d" }, forkAddsWork: false, tokens: 1 + 2, sessions: 1 },
      { query: { range: "today" }, forkAddsWork: false, tokens: 1 + 2, sessions: 1 },
      {
        query: { range: "between", from: "2026-03-15", to: "2026-03-15" },
        forkAddsWork: false,
        tokens: 1 + 2,
        sessions: 1,
      },
      {
        query: { range: "session", sessionID: "ses_fork" },
        forkAddsWork: false,
        tokens: 0,
        sessions: 0,
      },
      { query: { range: "90d" }, forkAddsWork: true, tokens: 1 + 2 + 4 + 8, sessions: 2 },
      {
        query: { range: "session", sessionID: "ses_fork" },
        forkAddsWork: true,
        tokens: 4 + 8,
        sessions: 1,
      },
      {
        query: { range: "session", sessionID: "ses_parent" },
        forkAddsWork: true,
        tokens: 1 + 2,
        sessions: 1,
      },
    ])(
      "counts a fork's copies only in its parent: $query.range $query.sessionID (fork adds work: $forkAddsWork)",
      async (item) => {
        writeHistory(forkHistory(item.forkAddsWork), forkSessions);

        const report = await usageReport(item.query, NOW);

        expect(report.totals.tokens.processed).toBe(item.tokens);
        expect(report.totals.sessions).toBe(item.sessions);
        expect(report.totals.costUsd).toBeCloseTo((item.tokens * 10) / M, 10);
      },
    );
  });
});

describe("session usage (the sidebar's session line)", () => {
  // ses_root has a subagent; ses_fork was forked from ses_root after its first two rows.
  const sessions = [
    { id: "ses_root", created: at(0, 7) },
    { id: "ses_child", parentID: "ses_root", created: at(0, 8) },
    { id: "ses_fork", forkOf: "ses_root", created: at(0, 9, 30) },
    { id: "ses_other", created: at(0, 6) },
  ];
  const history = () => {
    const root = [
      message({
        sessionID: "ses_root",
        created: at(0, 8),
        tokens: { input: 10, output: 5, reasoning: 3, cacheRead: 4, cacheWrite: 6 },
      }),
      message({
        type: "compaction",
        sessionID: "ses_root",
        created: at(0, 9),
        tokens: { input: 7 },
      }),
    ];
    const copies = root.map((original, index) => ({
      ...original,
      id: `msg_fork_copy_${index}`,
      sessionID: "ses_fork",
    }));
    return [
      ...root,
      ...copies,
      message({
        sessionID: "ses_child",
        modelID: "claude-plain",
        created: at(0, 10),
        tokens: { input: 2, output: 1, cacheRead: 8 },
      }),
      message({ sessionID: "ses_other", created: at(0, 11), tokens: { input: 100 } }),
    ];
  };

  it.each([
    {
      scope: "current" as const,
      // In: input and cache writes, out: output and reasoning, and the compaction counts.
      tokens: {
        input: 10 + 6 + 7,
        cachedInput: 4,
        output: 5 + 3,
        models: [{ modelID: "claude-test", input: 17, cacheRead: 4, cacheWrite: 6 }],
      },
    },
    {
      scope: "tree" as const,
      tokens: {
        input: 10 + 6 + 7 + 2,
        cachedInput: 4 + 8,
        output: 5 + 3 + 1,
        models: [
          { modelID: "claude-test", input: 17, cacheRead: 4, cacheWrite: 6 },
          { modelID: "claude-plain", input: 2, cacheRead: 8, cacheWrite: 0 },
        ],
      },
    },
  ])("counts $scope as the Usage tab counts", async ({ scope, tokens }) => {
    writeHistory(history(), sessions);

    await expect(sessionUsage("ses_root", scope)).resolves.toEqual(tokens);
  });

  it("leaves out a fork's copies of its parent's messages", async () => {
    writeHistory(history(), sessions);

    await expect(sessionUsage("ses_fork", "current")).resolves.toBeUndefined();
  });

  it("has no tokens for an unknown session or without a database", async () => {
    await expect(sessionUsage("ses_root", "tree")).resolves.toBeUndefined();
    writeHistory(history(), sessions);

    await expect(sessionUsage("ses_missing", "tree")).resolves.toBeUndefined();
    await expect(sessionUsage("ses_missing", "current")).resolves.toBeUndefined();
  });

  it("agrees with Usage's This session on the same database, with subagents", async () => {
    writeHistory(history(), sessions);

    for (const sessionID of ["ses_root", "ses_fork", "ses_child"]) {
      const report = await usageReport({ range: "session", sessionID }, NOW);
      const sidebar = await sessionUsage(sessionID, "tree");
      const { cachedInput, uncachedInput, output } = report.totals.tokens;
      expect(sidebar ?? { input: 0, cachedInput: 0, output: 0 }, sessionID).toMatchObject({
        input: uncachedInput,
        cachedInput,
        output,
      });
    }
  });
});

describe("usage report compactions", () => {
  // `null` is a model row without a price.
  it.each<{
    name: string;
    messages: () => SessionDatabaseMessage[];
    tokens: number;
    models: Array<[string, string, number | null, number]>;
  }>([
    {
      name: "a completed compaction counts with its own model",
      messages: () => [
        message({ created: at(0, 8), tokens: { input: M } }),
        message({ type: "compaction", created: at(0, 9), tokens: { input: 5 * M, output: M } }),
      ],
      tokens: 7 * M,
      models: [["anthropic", "claude-test", 2 + 10 + 10, 7 * M]],
    },
    {
      // It names no model, so its tokens stay unpriced: no guess from the messages before it.
      name: "a failed compaction counts its tokens as unpriced",
      messages: () => [
        message({ created: at(0, 8), tokens: { input: M } }),
        message({ modelID: "claude-plain", created: at(0, 9), tokens: { input: M } }),
        message({
          type: "compaction",
          status: "failed",
          providerID: undefined,
          modelID: undefined,
          created: at(0, 10),
          tokens: { input: 3 * M },
        }),
      ],
      tokens: 5 * M,
      models: [
        ["anthropic", "claude-test", 2, M],
        ["anthropic", "claude-plain", 1, M],
        ["unknown", "unknown", null, 3 * M],
      ],
    },
    {
      name: "running and usage-free compactions count nothing",
      messages: () => [
        message({ type: "compaction", status: "running", created: at(0, 9) }),
        message({ type: "compaction", status: "failed", created: at(0, 10) }),
      ],
      tokens: 0,
      models: [],
    },
  ])("$name", async (item) => {
    writeHistory(item.messages());

    const report = await usageReport({ range: "today" }, NOW);

    expect(report.totals.tokens.processed).toBe(item.tokens);
    expect(
      report.models.map((model) => [
        model.providerID,
        model.modelID,
        model.priced ? Number(model.costUsd.toFixed(9)) : null,
        model.tokens,
      ]),
    ).toEqual(item.models);
  });
});

describe("usage report cost", () => {
  it("prices known models, leaves the rest unpriced, and breaks cost down by provider and model", async () => {
    writeHistory([
      message({ created: at(0, 8), tokens: { input: M } }),
      // The same model through Copilot is priced at its maker's price.
      message({ providerID: "github-copilot", created: at(0, 9), tokens: { output: M } }),
      message({
        providerID: "acme",
        modelID: "mystery-1",
        created: at(0, 10),
        tokens: { input: 3 * M },
      }),
    ]);

    const report = await usageReport({ range: "today" }, NOW);

    expect(report.totals).toMatchObject({
      costUsd: expect.closeTo(12, 10),
      sessions: 1,
      unpricedTokens: 3 * M,
      unpricedShare: 0.6,
    });
    const row = (costUsd: number, tokens: number, unpricedTokens: number) => ({
      costUsd: expect.closeTo(costUsd, 10),
      costShare: expect.closeTo(costUsd / 12, 10),
      tokens,
      tokenShare: tokens / (5 * M),
      unpricedTokens,
    });
    expect(report.providers).toEqual([
      { providerID: "github-copilot", sessions: 1, ...row(10, M, 0) },
      { providerID: "anthropic", sessions: 1, ...row(2, M, 0) },
      { providerID: "acme", sessions: 1, ...row(0, 3 * M, 3 * M) },
    ]);
    expect(report.models).toMatchObject([
      { providerID: "github-copilot", modelID: "claude-test", priced: true, ...row(10, M, 0) },
      { providerID: "anthropic", modelID: "claude-test", priced: true, ...row(2, M, 0) },
      { providerID: "acme", modelID: "mystery-1", priced: false, ...row(0, 3 * M, 3 * M) },
    ]);
    // Plain JSON: the report travels over the RPC as it is.
    expect(report).toStrictEqual(JSON.parse(JSON.stringify(report)));
  });

  const allKinds = { input: M, cacheRead: M, cacheWrite: M, output: M, reasoning: M };

  it.each([
    {
      providerID: "anthropic",
      modelID: "claude-test",
      costByType: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 + 10 },
      cacheSavingsUsd: 2 - 0.2,
    },
    // Without cache rates, cache tokens cost as plain input, so the cache saves nothing.
    {
      providerID: "anthropic",
      modelID: "claude-plain",
      costByType: { input: 1, cacheRead: 1, cacheWrite: 1, output: 4 + 4 },
      cacheSavingsUsd: 0,
    },
    {
      providerID: "acme",
      modelID: "mystery-1",
      costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      cacheSavingsUsd: 0,
    },
  ])("splits $modelID cost by token type and counts cache savings", async (item) => {
    writeHistory([
      message({
        providerID: item.providerID,
        modelID: item.modelID,
        created: at(0, 8),
        tokens: allKinds,
      }),
    ]);

    const { totals, models } = await usageReport({ range: "today" }, NOW);

    expect(totals.tokens).toEqual({
      processed: 5 * M,
      cachedInput: M,
      uncachedInput: 2 * M,
      output: 2 * M,
    });
    const tokensByType = { input: M, cacheRead: M, cacheWrite: M, output: 2 * M };
    const { input, cacheRead, cacheWrite, output } = item.costByType;
    const costByType = {
      input: expect.closeTo(input, 10),
      cacheRead: expect.closeTo(cacheRead, 10),
      cacheWrite: expect.closeTo(cacheWrite, 10),
      output: expect.closeTo(output, 10),
    };
    // The report and its one model split the same way.
    for (const split of [totals, models[0]]) {
      expect(split?.tokensByType).toEqual(tokensByType);
      expect(split?.costByType).toEqual(costByType);
    }
    expect(totals.costUsd).toBeCloseTo(input + cacheRead + cacheWrite + output, 10);
    expect(totals.cacheSavingsUsd).toBeCloseTo(item.cacheSavingsUsd, 10);
  });

  it("prices a message without uncached input: all its input came from the cache", async () => {
    writeHistory([message({ created: at(0, 8), tokens: { cacheRead: M, output: M } })]);

    const { totals, models } = await usageReport({ range: "today" }, NOW);

    expect(totals.tokens).toEqual({
      processed: 2 * M,
      cachedInput: M,
      uncachedInput: 0,
      output: M,
    });
    expect(models[0]?.tokensByType).toEqual({ input: 0, cacheRead: M, cacheWrite: 0, output: M });
    expect(models[0]?.costByType).toEqual({
      input: 0,
      cacheRead: expect.closeTo(0.2, 10),
      cacheWrite: 0,
      output: expect.closeTo(10, 10),
    });
    // Read from the cache at 0.2 instead of 2 per 1M input tokens.
    expect(totals.cacheSavingsUsd).toBeCloseTo(2 - 0.2, 10);
  });

  it("lists each model's own days with usage", async () => {
    writeHistory([
      message({ created: at(-3, 8), tokens: { input: M } }),
      message({ created: at(0, 8), tokens: { input: M } }),
      message({ created: at(0, 9), tokens: { output: M } }),
      message({ modelID: "claude-plain", created: at(-1, 8), tokens: { input: M } }),
    ]);

    const report = await usageReport({ range: "7d" }, NOW);

    expect(report.models.map(({ modelID, days }) => [modelID, days])).toEqual([
      [
        "claude-test",
        [
          { date: "2026-03-12", costUsd: expect.closeTo(2, 10), tokens: M },
          { date: "2026-03-15", costUsd: expect.closeTo(2 + 10, 10), tokens: 2 * M },
        ],
      ],
      ["claude-plain", [{ date: "2026-03-14", costUsd: expect.closeTo(1, 10), tokens: M }]],
    ]);
  });

  const mixedHistory = () => [
    message({ created: at(0, 8), tokens: { input: M } }),
    message({ providerID: "github-copilot", created: at(-1, 9), tokens: { output: M } }),
    message({ modelID: "claude-plain", created: at(-2, 10), tokens: { output: M / 2 } }),
    message({ providerID: "acme", modelID: "mystery-1", created: at(0, 11), tokens: { input: M } }),
  ];
  const unpricedHistory = () => [
    message({ providerID: "acme", modelID: "mystery-1", created: at(0, 8), tokens: { input: M } }),
    message({ providerID: "acme", modelID: "mystery-2", created: at(-1, 8), tokens: { input: M } }),
  ];

  it.each([
    { history: "priced and unpriced", messages: mixedHistory, costShares: 1 },
    // With nothing priced there is no cost to share: every cost share is 0.
    { history: "unpriced only", messages: unpricedHistory, costShares: 0 },
  ])("gives shares of 100% across providers, models and days ($history)", async (item) => {
    writeHistory(item.messages());

    const report = await usageReport({ range: "7d" }, NOW);

    for (const rows of [report.providers, report.models, report.days]) {
      expect(sum(rows, "costShare")).toBeCloseTo(item.costShares, 10);
      expect(sum(rows, "tokenShare")).toBeCloseTo(1, 10);
    }
  });
});

describe("usage report provider names", () => {
  it("adds OpenCode's names for the report's providers, each on one line", async () => {
    writeHistory([
      message({ providerID: "moonshotai", modelID: "kimi-k3", created: at(0, 8) }),
      message({ providerID: "zai-coding-plan", modelID: "glm-5", created: at(0, 9) }),
      message({ providerID: "acme", modelID: "mystery-1", created: at(0, 10) }),
    ]);
    const report = await usageReport({ range: "today" }, NOW);

    const named = withProviderNames(report, [
      { id: "moonshotai", name: "Moonshot AI" },
      { id: "zai-coding-plan", name: " Z.AI\nCoding Plan " },
      // An empty name is left out, and so is a provider the report doesn't have.
      { id: "acme", name: " " },
      { id: "openai", name: "OpenAI" },
    ]);

    expect(named.providerNames).toEqual({
      moonshotai: "Moonshot AI",
      "zai-coding-plan": "Z.AI Coding Plan",
    });
    expect(named.providers).toBe(report.providers);
    // The shared report is not changed: the next identical question gets it as it was.
    expect(report).not.toHaveProperty("providerNames");
  });
});

describe("usage report price list", () => {
  it("prices with the configured price list", async () => {
    writeHistory([message({ created: at(0, 8), tokens: { input: M } })]);

    // claude-test has a price only in the downloaded test list, not in the bundled one.
    const pricing = { source: "bundled" as "bundled" | "runtime", autoRefreshDays: 7 };
    usePricingSettings(() => pricing);
    const bundled = await usageReport({ range: "today" }, NOW);
    pricing.source = "runtime";
    const runtime = await usageReport({ range: "today" }, NOW);

    expect(bundled.totals).toMatchObject({ costUsd: 0, unpricedTokens: M });
    expect(runtime.totals).toMatchObject({ costUsd: 2, unpricedTokens: 0 });
  });
});

/**
 * Writes `count` messages a minute apart, ending a minute before `NOW`, over 600 sessions (every
 * other one a subagent). SQL makes the rows, so the test keeps no big array alive. Each message
 * uses 4 tokens.
 */
function writeLongHistory(count: number): void {
  const sessionID = (index: number) => `ses_${String(index).padStart(4, "0")}`;
  writeHistory(
    [],
    Array.from({ length: 600 }, (_, index) => ({
      id: sessionID(index),
      ...(index % 2 === 1 ? { parentID: sessionID(index - 1) } : {}),
      created: 0,
    })),
  );
  const database = new DatabaseSync(databasePath());
  try {
    database
      .prepare(`
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < :count)
        INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
        SELECT printf('msg_%06d', i), printf('ses_%04d', i % 600), 'assistant', i,
          :start + i * 60000, :start + i * 60000,
          json_object(
            'model', json_object('providerID', 'anthropic', 'id', 'claude-test'),
            'tokens', json_object('input', 1, 'output', 1, 'reasoning', 0,
              'cache', json_object('read', 1, 'write', 1)),
            'time', json_object('created', :start + i * 60000))
        FROM n`)
      .run({ count, start: NOW - count * 60_000 });
  } finally {
    database.close();
  }
}

describe("usage report reading", () => {
  it("lets other work run while it reads a long history", async () => {
    const count = 60_000;
    writeLongHistory(count);
    // How long the report holds the event loop between two timer ticks, in main-thread CPU
    // time: unlike wall time, it leaves out the time a busy machine gives other processes.
    let ticks = 0;
    let longestHoldMs = 0;
    let cpuAtLastTick = process.threadCpuUsage();
    const measureHold = () => {
      const used = process.threadCpuUsage(cpuAtLastTick);
      longestHoldMs = Math.max(longestHoldMs, (used.user + used.system) / 1000);
      cpuAtLastTick = process.threadCpuUsage();
    };
    const timer = setInterval(() => {
      ticks += 1;
      measureHold();
    }, 1);

    try {
      const report = await usageReport({ range: "90d" }, NOW);
      measureHold();
      expect(report.totals.tokens.processed).toBe(4 * count);
      expect(report.totals.sessions).toBe(300);
    } finally {
      clearInterval(timer);
    }

    expect(ticks).toBeGreaterThan(50);
    expect(longestHoldMs).toBeLessThan(50);
  });

  it("answers identical questions with one report for 30 s", async () => {
    writeHistory([message({ created: at(0, 8), tokens: { output: 1 } })]);

    // Both requests start before either finishes.
    const [first, same] = await Promise.all([
      usageReport({ range: "today" }, NOW),
      usageReport({ range: "today" }, NOW + 1),
    ]);
    const otherRange = await usageReport({ range: "7d" }, NOW);
    expect(same).toBe(first);
    expect(otherRange).not.toBe(first);

    writeHistory([
      message({ created: at(0, 8), tokens: { output: 1 } }),
      message({ created: at(0, 9), tokens: { output: 2 } }),
    ]);
    expect(await usageReport({ range: "today" }, NOW + 29_999)).toBe(first);
    const later = await usageReport({ range: "today" }, NOW + 30_000);
    expect(later.totals.tokens.processed).toBe(1 + 2);
  });

  it.each([
    { range: "today" as const, days: 1 },
    { range: "7d" as const, days: 7 },
  ])("starts a new $range report after local midnight", async ({ range, days }) => {
    writeHistory([message({ created: at(0, 8), tokens: { output: 1 } })]);

    const before = await usageReport({ range }, at(0, 23, 59, 59));
    const after = await usageReport({ range }, at(1, 0, 0, 1));

    expect(before.sinceMs).toBe(at(1 - days, 0));
    expect(after.sinceMs).toBe(at(2 - days, 0));
    expect(after.days.at(-1)?.date).toBe("2026-03-16");
    expect(after.totals.tokens.processed).toBe(range === "today" ? 0 : 1);
  });

  it("does not keep a failed report", async () => {
    writeHistory([message({ created: at(0, 8) })]);
    const query: UsageQuery = { range: "session", sessionID: "ses_new" };
    await expect(usageReport(query, NOW)).rejects.toThrow("Session not found: ses_new");

    writeHistory([message({ sessionID: "ses_new", created: at(0, 8), tokens: { output: 1 } })]);

    expect((await usageReport(query, NOW)).totals.tokens.processed).toBe(1);
  });
});
