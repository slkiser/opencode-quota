import { describe, expect, it } from "vitest";

import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
import {
  buildSessionUsageReport,
  utcWeekStart,
  type SessionUsageDeps,
} from "../src/lib/session-usage.js";

function msg(
  over: Partial<OpenCodeMessage> & { id: string; sessionID: string; at?: string },
): OpenCodeMessage {
  const { at, ...rest } = over;
  return {
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-sonnet",
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 70, write: 0 } },
    time: at ? { created: Date.parse(at) } : undefined,
    ...rest,
  };
}

function deps(over: Partial<SessionUsageDeps> = {}): Partial<SessionUsageDeps> {
  return {
    readClaude: async () => [],
    readOpenCode: async () => [],
    readOpenCodeIndex: async () => ({}),
    readCodex: async () => [],
    storeExists: () => true,
    // $1 per 100 tokens for "claude-sonnet"; everything else unpriced.
    price: ({ modelID, tokens }) =>
      modelID === "claude-sonnet"
        ? (tokens.input +
            tokens.output +
            tokens.reasoning +
            tokens.cache_read +
            tokens.cache_write) /
          100
        : null,
    ...over,
  };
}

describe("utcWeekStart", () => {
  it("returns the Monday of the UTC week", () => {
    expect(utcWeekStart(Date.parse("2026-10-18T23:59:00Z"))).toBe("2026-10-12"); // Sunday
    expect(utcWeekStart(Date.parse("2026-10-12T00:00:00Z"))).toBe("2026-10-12"); // Monday
    expect(utcWeekStart(Date.parse("2026-10-19T00:00:00Z"))).toBe("2026-10-19");
  });
});

describe("buildSessionUsageReport", () => {
  it("folds Claude subagent responses into the parent session", async () => {
    const report = await buildSessionUsageReport(
      {},
      deps({
        readClaude: async () => [
          msg({
            id: "a",
            sessionID: "s1",
            at: "2026-10-13T10:00:00Z",
            directory: "/w/repo",
            subagent: false,
          }),
          msg({
            id: "b",
            sessionID: "s1",
            at: "2026-10-13T10:30:00Z",
            directory: "/w/repo",
            subagent: false,
          }),
          msg({
            id: "c",
            sessionID: "s1",
            parentSessionID: "s1",
            subagent: true,
            at: "2026-10-13T10:10:00Z",
            modelID: "claude-haiku",
            tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        ],
      }),
    );

    expect(report.sessions).toHaveLength(1);
    const row = report.sessions[0]!;
    expect(row).toMatchObject({
      source: "claude-code",
      sessionID: "s1",
      directory: "/w/repo",
      responses: 3,
      subagentResponses: 1,
      totalTokens: 210,
      subagentTokens: 10,
      activeMinutes: 30,
      costUsd: 2,
      unpricedTokens: 10,
    });
    expect(row.pricedShare).toBeCloseTo(200 / 210);
    expect(row.models.map((m) => m.model)).toEqual(["claude-sonnet", "claude-haiku"]);
    expect(row.cacheReadShare).toBeCloseTo(140 / 165);
    expect(row.tokensPerResponse).toBe(70);
    expect(report.totals.subagentShare).toBeCloseTo(10 / 210);
  });

  it("folds Codex review threads into their parent and OpenCode children into the root", async () => {
    const report = await buildSessionUsageReport(
      {},
      deps({
        readCodex: async () => [
          msg({ id: "x", sessionID: "parent", subagent: false, at: "2026-10-14T00:00:00Z" }),
          msg({
            id: "y",
            sessionID: "child",
            parentSessionID: "parent",
            subagent: true,
            at: "2026-10-14T00:05:00Z",
          }),
        ],
        readOpenCode: async () => [
          msg({ id: "o1", sessionID: "ses_root", at: "2026-10-14T00:00:00Z" }),
          msg({ id: "o2", sessionID: "ses_grandchild", at: "2026-10-14T00:01:00Z" }),
        ],
        readOpenCodeIndex: async () => ({
          ses_root: { id: "ses_root" },
          ses_child: { id: "ses_child", parentID: "ses_root" },
          ses_grandchild: { id: "ses_grandchild", parentID: "ses_child" },
        }),
      }),
    );

    expect(
      report.sessions.map((s) => [s.source, s.sessionID, s.responses, s.subagentResponses]),
    ).toEqual([
      ["codex", "parent", 2, 1],
      ["opencode", "ses_root", 2, 1],
    ]);
  });

  it("keeps unavailable values null rather than zero", async () => {
    const report = await buildSessionUsageReport(
      {},
      deps({
        readClaude: async () => [
          msg({
            id: "only",
            sessionID: "s",
            modelID: "mystery",
            tokens: { input: 0, output: 40, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        ],
      }),
    );

    const row = report.sessions[0]!;
    expect(row.cacheReadShare).toBeNull(); // no input-side tokens
    expect(row.costUsd).toBeNull(); // unpriced model
    expect(row.unpricedTokens).toBe(40);
    expect(row.pricedShare).toBe(0);
    expect(row.startMs).toBeNull();
    expect(row.activeMinutes).toBeNull();
    expect(report.weekly).toEqual([]); // undated responses are not placed in a week
    expect(report.coverage[0]).toMatchObject({ source: "claude-code", undatedResponses: 1 });
    expect(report.totals.costUsd).toBeNull();
  });

  it("reports subagent share as null when no source marks subagents", async () => {
    const report = await buildSessionUsageReport(
      {},
      deps({
        storeExists: (source) => source === "claude-code",
        readClaude: async () => [msg({ id: "a", sessionID: "s", at: "2026-10-13T00:00:00Z" })],
      }),
    );
    expect(report.totals.subagentShare).toBeNull();
    expect(report.weekly.every((w) => w.subagentShare === null)).toBe(true);
  });

  it("states coverage: not-found and unavailable sources are not zero usage", async () => {
    const report = await buildSessionUsageReport(
      {},
      deps({
        storeExists: (source) => source !== "codex",
        readOpenCode: async () => {
          throw new Error("better-sqlite3 is not installed\nstack line");
        },
        readClaude: async () => [msg({ id: "a", sessionID: "s", at: "2026-10-13T00:00:00Z" })],
      }),
    );

    expect(report.coverage).toEqual([
      {
        source: "claude-code",
        status: "read",
        sessions: 1,
        responses: 1,
        undatedResponses: 0,
        marksSubagents: false,
      },
      {
        source: "opencode",
        status: "unavailable",
        reason: "better-sqlite3 is not installed",
        sessions: 0,
        responses: 0,
        undatedResponses: 0,
        marksSubagents: false,
      },
      {
        source: "codex",
        status: "not-found",
        sessions: 0,
        responses: 0,
        undatedResponses: 0,
        marksSubagents: false,
      },
    ]);
    expect(report.notes.some((n) => n.includes("UA-TW-04"))).toBe(true);
    expect(report.weekly.map((w) => w.source)).toEqual(["all", "claude-code"]);
  });

  it("builds weekly trends and length buckets per source", async () => {
    const long = Array.from({ length: 12 }, (_, i) =>
      msg({ id: `l${i}`, sessionID: "long", at: "2026-10-06T00:00:00Z", subagent: false }),
    );
    const report = await buildSessionUsageReport(
      { sinceMs: 1, untilMs: 2, nowMs: 3 },
      deps({
        readClaude: async () => [
          ...long,
          msg({ id: "s0", sessionID: "short", at: "2026-10-13T00:00:00Z", subagent: false }),
        ],
        readCodex: async () => [
          msg({ id: "c0", sessionID: "cx", at: "2026-10-13T01:00:00Z", subagent: false }),
        ],
      }),
    );

    expect(report).toMatchObject({ generatedAtMs: 3, sinceMs: 1, untilMs: 2 });
    expect(report.weekly.map((w) => [w.weekStart, w.source, w.sessions, w.responses])).toEqual([
      ["2026-10-05", "all", 1, 12],
      ["2026-10-05", "claude-code", 1, 12],
      ["2026-10-12", "all", 2, 2],
      ["2026-10-12", "claude-code", 1, 1],
      ["2026-10-12", "codex", 1, 1],
    ]);
    expect(report.lengthBuckets.map((b) => [b.bucket, b.source, b.sessions])).toEqual([
      ["1-10", "all", 2],
      ["1-10", "claude-code", 1],
      ["1-10", "codex", 1],
      ["11-50", "all", 1],
      ["11-50", "claude-code", 1],
    ]);
    expect(report.totals).toMatchObject({ sessions: 3, responses: 14, totalTokens: 1400 });
  });

  it("is deterministic and never carries titles", async () => {
    const d = deps({
      readOpenCode: async () => [msg({ id: "o", sessionID: "ses_a", at: "2026-10-13T00:00:00Z" })],
      readOpenCodeIndex: async () => ({ ses_a: { id: "ses_a", title: "secret plan" } }),
    });
    const a = await buildSessionUsageReport({ nowMs: 1 }, d);
    const b = await buildSessionUsageReport({ nowMs: 1 }, d);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toContain("secret plan");
  });
});
