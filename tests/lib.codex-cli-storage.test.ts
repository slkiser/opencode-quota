import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getCodexCliSessionsDir, iterCodexCliMessages } from "../src/lib/codex-cli-storage.js";

function usage(input: number, cached: number, output: number, reasoning: number, cacheWrite = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function meta(id: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-10-15T12:00:00Z",
    type: "session_meta",
    payload: { id, model_provider: "openai", ...extra },
  };
}

function turn(turnId: string, model: string, timestamp = "2026-10-15T12:00:01Z") {
  return { timestamp, type: "turn_context", payload: { turn_id: turnId, model } };
}

function record(
  threadId: string,
  turnId: string,
  responseId: string,
  u: ReturnType<typeof usage>,
  timestamp = "2026-10-15T12:00:02Z",
) {
  return {
    timestamp,
    type: "token_usage_record",
    payload: { thread_id: threadId, turn_id: turnId, response_id: responseId, usage: u },
  };
}

function tokenCount(
  last: ReturnType<typeof usage>,
  total: ReturnType<typeof usage>,
  timestamp = "2026-10-15T12:00:02Z",
) {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  };
}

function sum(messages: Awaited<ReturnType<typeof iterCodexCliMessages>>) {
  return messages.reduce(
    (acc, m) =>
      acc +
      (m.tokens?.input ?? 0) +
      (m.tokens?.output ?? 0) +
      (m.tokens?.reasoning ?? 0) +
      (m.tokens?.cache?.read ?? 0) +
      (m.tokens?.cache?.write ?? 0),
    0,
  );
}

describe("iterCodexCliMessages", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "codex-cli-sessions-test-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  function writeRollout(name: string, lines: unknown[], day = "2026/10/15"): string {
    const dir = join(sessionsDir, ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return filePath;
  }

  it("uses per-response records, maps subsets into exclusive buckets and ignores token_count", async () => {
    const first = usage(1000, 600, 200, 50, 100);
    const second = usage(500, 400, 80, 0);
    writeRollout("a", [
      meta("thread-a"),
      turn("turn-1", "gpt-6.1-sol"),
      record("thread-a", "turn-1", "resp-1", first),
      tokenCount(first, first),
      tokenCount(first, first),
      turn("turn-2", "gpt-6-luna", "2026-10-15T12:01:00Z"),
      record("thread-a", "turn-2", "resp-2", second, "2026-10-15T12:01:05Z"),
    ]);

    const messages = await iterCodexCliMessages({ sessionsDir });

    expect(messages).toEqual([
      {
        id: "codex:resp-1",
        sessionID: "thread-a",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-6.1-sol",
        tokens: { input: 300, output: 150, reasoning: 50, cache: { read: 600, write: 100 } },
        time: { created: Date.parse("2026-10-15T12:00:02Z") },
        subagent: false,
      },
      {
        id: "codex:resp-2",
        sessionID: "thread-a",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-6-luna",
        tokens: { input: 100, output: 80, reasoning: 0, cache: { read: 400, write: 0 } },
        time: { created: Date.parse("2026-10-15T12:01:05Z") },
        subagent: false,
      },
    ]);
    // Exclusive buckets add back up to Codex's own total_tokens.
    expect(sum(messages)).toBe(first.total_tokens + second.total_tokens);
  });

  it("falls back to cumulative token_count deltas, skipping repeats and covering missed events", async () => {
    const a = usage(100, 40, 20, 5);
    const b = usage(200, 150, 30, 10);
    const c = usage(300, 200, 50, 0);
    const cumulative = (...parts: ReturnType<typeof usage>[]) =>
      parts.reduce((acc, p) => {
        const out = { ...acc };
        for (const key of Object.keys(p) as (keyof typeof p)[]) out[key] = acc[key] + p[key];
        return out;
      });
    writeRollout("legacy", [
      meta("thread-legacy"),
      turn("t1", "gpt-6-luna"),
      tokenCount(a, a),
      tokenCount(a, a),
      // `b` was never emitted; the next total still includes it.
      tokenCount(c, cumulative(a, b, c), "2026-10-15T12:05:00Z"),
    ]);

    const messages = await iterCodexCliMessages({ sessionsDir });

    expect(messages.map((m) => m.id)).toEqual([
      `codex:thread-legacy:${a.total_tokens}`,
      `codex:thread-legacy:${cumulative(a, b, c).total_tokens}`,
    ]);
    expect(messages.every((m) => m.modelID === "gpt-6-luna")).toBe(true);
    expect(sum(messages)).toBe(cumulative(a, b, c).total_tokens);
    expect(messages[1].tokens).toEqual({
      input: 300 + 200 - 150 - 200,
      output: 30 + 50 - 10,
      reasoning: 10,
      cache: { read: 350, write: 0 },
    });
  });

  it("counts a response copied into a resumed rollout once", async () => {
    const u = usage(100, 0, 10, 0);
    writeRollout("original", [
      meta("thread-r"),
      turn("t1", "gpt-6-luna"),
      record("thread-r", "t1", "resp-x", u),
    ]);
    writeRollout(
      "resumed",
      [
        meta("thread-r"),
        turn("t1", "gpt-6-luna"),
        record("thread-r", "t1", "resp-x", u),
        record("thread-r", "t1", "resp-y", u, "2026-10-16T09:00:00Z"),
      ],
      "2026/10/16",
    );

    const messages = await iterCodexCliMessages({ sessionsDir });

    expect(messages.map((m) => m.id)).toEqual(["codex:resp-x", "codex:resp-y"]);
  });

  it("keeps subagent threads as their own sessions", async () => {
    writeRollout("parent", [
      meta("parent"),
      turn("t1", "gpt-6.1-sol"),
      record("parent", "t1", "p1", usage(50, 0, 5, 0)),
    ]);
    writeRollout("child", [
      meta("child", {
        parent_thread_id: "parent",
        thread_source: "guardian_review",
        source: { subagent: {} },
        cwd: "/work/repo",
      }),
      turn("t1", "codex-auto-review"),
      record("child", "t1", "c1", usage(20, 0, 2, 0)),
    ]);

    const messages = await iterCodexCliMessages({ sessionsDir });

    expect(
      messages.map((m) => [m.sessionID, m.modelID, m.subagent, m.parentSessionID, m.directory]),
    ).toEqual([
      ["child", "codex-auto-review", true, "parent", "/work/repo"],
      ["parent", "gpt-6.1-sol", false, undefined, undefined],
    ]);
  });

  it("filters by since/until and prunes rollouts older than sinceMs by mtime", async () => {
    const old = writeRollout("old", [
      meta("old"),
      turn("t", "m"),
      record("old", "t", "o1", usage(10, 0, 1, 0), "2026-10-01T00:00:00Z"),
    ]);
    const oldTime = new Date("2026-10-01T00:00:00Z");
    utimesSync(old, oldTime, oldTime);
    writeRollout("window", [
      meta("w"),
      turn("t", "m"),
      record("w", "t", "early", usage(10, 0, 1, 0), "2026-10-15T08:00:00Z"),
      record("w", "t", "inside", usage(10, 0, 1, 0), "2026-10-15T12:00:00Z"),
      record("w", "t", "late", usage(10, 0, 1, 0), "2026-10-15T18:00:00Z"),
    ]);

    const messages = await iterCodexCliMessages({
      sessionsDir,
      sinceMs: Date.parse("2026-10-15T10:00:00Z"),
      untilMs: Date.parse("2026-10-15T14:00:00Z"),
    });

    expect(messages.map((m) => m.id)).toEqual(["codex:inside"]);
  });

  it("skips malformed lines unless strictReads is set", async () => {
    const dir = join(sessionsDir, "2026", "10", "15");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-bad.jsonl"),
      [
        JSON.stringify(meta("bad")),
        "{not json",
        JSON.stringify(record("bad", "t", "r1", usage(10, 0, 1, 0))),
      ].join("\n"),
    );

    expect((await iterCodexCliMessages({ sessionsDir })).map((m) => m.id)).toEqual(["codex:r1"]);
    await expect(iterCodexCliMessages({ sessionsDir, strictReads: true })).rejects.toThrow();
  });

  it("yields nothing for missing directories, rollouts without metadata or usage, and unknown lines", async () => {
    expect(await iterCodexCliMessages({ sessionsDir: join(sessionsDir, "missing") })).toEqual([]);
    expect(
      await iterCodexCliMessages({ sessionsDir: join(sessionsDir, "missing"), strictReads: true }),
    ).toEqual([]);

    writeRollout("no-meta", [record("x", "t", "r", usage(10, 0, 1, 0))]);
    writeRollout("no-usage", [
      meta("quiet"),
      turn("t", "m"),
      { type: "response_item", payload: {} },
    ]);
    writeRollout("zero", [meta("zero"), record("zero", "t", "z", usage(0, 0, 0, 0))]);

    expect(await iterCodexCliMessages({ sessionsDir })).toEqual([]);
  });

  it("resolves the sessions directory from CODEX_HOME", () => {
    const previous = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = "/opt/codex-home";
      expect(getCodexCliSessionsDir()).toBe(join("/opt/codex-home", "sessions"));
      delete process.env.CODEX_HOME;
      expect(getCodexCliSessionsDir()).toMatch(/\.codex[\\/]sessions$/);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
