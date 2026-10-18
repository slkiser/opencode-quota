import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { iterClaudeCodeCliMessages } from "../src/lib/claude-code-cli-storage.js";

describe("iterClaudeCodeCliMessages", () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "claude-cli-projects-test-"));
  });

  afterEach(() => {
    rmSync(projectsDir, { recursive: true, force: true });
  });

  function writeTranscript(projectName: string, sessionId: string, lines: unknown[]): string {
    const projectDir = join(projectsDir, projectName);
    mkdirSync(projectDir, { recursive: true });
    const filePath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return filePath;
  }

  it("exposes stable provider completion ids and verifies final usage only in opt-in event mode", async () => {
    writeTranscript("fixture", "session", [
      {
        type: "assistant",
        uuid: "chunk-a",
        timestamp: "2026-10-15T12:00:00Z",
        message: {
          id: "completion-a",
          model: "claude-sonnet-4-6",
          stop_reason: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        uuid: "chunk-b",
        timestamp: "2026-10-15T12:00:01Z",
        message: {
          id: "completion-a",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      {
        type: "assistant",
        uuid: "zero-real",
        timestamp: "2026-10-15T12:00:02Z",
        message: {
          id: "completion-zero",
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "assistant",
        uuid: "synthetic",
        timestamp: "2026-10-15T12:00:02Z",
        message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } },
      },
    ]);
    const events = await iterClaudeCodeCliMessages({
      projectsDir,
      completionEvents: true,
      strictReads: true,
    });
    expect(events.map((event) => event.id)).toEqual([
      "completion-a",
      "completion-a",
      "completion-zero",
    ]);
    expect(events.map((event) => event.usageComplete)).toEqual([false, true, true]);
    const legacy = await iterClaudeCodeCliMessages({ projectsDir });
    // Legacy reads keep one message per response: the last chunk, with the final usage.
    expect(legacy.map((event) => event.id)).toEqual(["chunk-b"]);
    expect(legacy[0]!.tokens).toEqual({ input: 10, output: 5, cache: { read: 0, write: 0 } });
    expect(legacy.every((event) => event.usageComplete === undefined)).toBe(true);
  });

  it("does not guess a stable streamed completion from an unrelated chunk UUID", async () => {
    writeTranscript("fixture", "uncertain", [
      {
        type: "assistant",
        uuid: "chunk-without-message-id",
        timestamp: "2026-10-15T12:00:00Z",
        message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    await expect(
      iterClaudeCodeCliMessages({ projectsDir, completionEvents: true, strictReads: true }),
    ).rejects.toThrow("completion identity/time unavailable");
    expect(await iterClaudeCodeCliMessages({ projectsDir })).toHaveLength(1);
  });

  it("returns [] when the projects directory does not exist", async () => {
    const messages = await iterClaudeCodeCliMessages({
      projectsDir: join(projectsDir, "does-not-exist"),
    });
    expect(messages).toEqual([]);
  });

  it("parses assistant turns into OpenCodeMessage-shaped records", async () => {
    writeTranscript("-Users-alice-repo", "session-1", [
      { type: "user", sessionId: "session-1", timestamp: "2026-07-01T00:00:00.000Z" },
      {
        type: "assistant",
        uuid: "msg-1",
        sessionId: "session-1",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          model: "claude-sonnet-4-6",
          usage: {
            input_tokens: 2,
            output_tokens: 324,
            cache_read_input_tokens: 19541,
            cache_creation_input_tokens: 21522,
          },
        },
      },
    ]);

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(messages).toEqual([
      {
        id: "msg-1",
        sessionID: "session-1",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
        tokens: {
          input: 2,
          output: 324,
          cache: { read: 19541, write: 21522 },
        },
        time: { created: Date.parse("2026-07-01T00:00:01.000Z") },
        subagent: false,
      },
    ]);
  });

  it("ignores non-assistant lines, malformed JSON, and blank lines", async () => {
    const projectDir = join(projectsDir, "-Users-alice-repo");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session-2.jsonl"),
      [
        JSON.stringify({ type: "user", sessionId: "session-2" }),
        "not json at all {{{",
        "",
        JSON.stringify({
          type: "assistant",
          uuid: "msg-2",
          sessionId: "session-2",
          timestamp: "2026-07-02T00:00:00.000Z",
          message: { model: "claude-opus-4-6", usage: { input_tokens: 5, output_tokens: 10 } },
        }),
      ].join("\n"),
    );

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe("msg-2");
  });

  it("filters by sinceMs/untilMs based on the entry timestamp", async () => {
    writeTranscript("-Users-alice-repo", "session-3", [
      {
        type: "assistant",
        uuid: "old",
        sessionId: "session-3",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: "assistant",
        uuid: "in-window",
        sessionId: "session-3",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: "assistant",
        uuid: "future",
        sessionId: "session-3",
        timestamp: "2027-01-01T00:00:00.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    const messages = await iterClaudeCodeCliMessages({
      projectsDir,
      sinceMs: Date.parse("2026-06-01T00:00:00.000Z"),
      untilMs: Date.parse("2026-08-01T00:00:00.000Z"),
    });

    expect(messages.map((m) => m.id)).toEqual(["in-window"]);
  });

  it("skips a transcript file whose mtime predates the sinceMs window", async () => {
    const filePath = writeTranscript("-Users-alice-repo", "session-4", [
      {
        type: "assistant",
        uuid: "should-be-pruned",
        sessionId: "session-4",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);
    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(filePath, oldTime, oldTime);

    const messages = await iterClaudeCodeCliMessages({
      projectsDir,
      sinceMs: Date.parse("2026-06-01T00:00:00.000Z"),
    });

    expect(messages).toEqual([]);
  });

  it("skips synthetic zero-usage notices (e.g. rate-limit banners)", async () => {
    writeTranscript("-Users-alice-repo", "session-6", [
      {
        type: "assistant",
        uuid: "synthetic-rate-limit",
        sessionId: "session-6",
        timestamp: "2026-07-01T00:00:00.000Z",
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: "assistant",
        uuid: "real-turn",
        sessionId: "session-6",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(messages.map((m) => m.id)).toEqual(["real-turn"]);
  });

  it("falls back to the filename as sessionID when a line has no sessionId", async () => {
    writeTranscript("-Users-alice-repo", "session-5", [
      {
        type: "assistant",
        uuid: "msg-5",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: { model: "claude-opus-4-6", usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ]);

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(messages[0]!.sessionID).toBe("session-5");
  });
  it("makes incomplete transcripts an unavailable strict read rather than zero usage", async () => {
    const project = join(projectsDir, "broken");
    mkdirSync(project);
    writeFileSync(join(project, "partial.jsonl"), "{unfinished");
    await expect(iterClaudeCodeCliMessages({ projectsDir, strictReads: true })).rejects.toThrow();
    expect(await iterClaudeCodeCliMessages({ projectsDir })).toEqual([]);
  });
  it("ignores non-directory metadata while preserving strict transcript errors", async () => {
    writeFileSync(join(projectsDir, ".DS_Store"), "metadata");
    expect(await iterClaudeCodeCliMessages({ projectsDir, strictReads: true })).toEqual([]);
  });

  it("collapses a response written as several content-block lines into one message", async () => {
    const usage = { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 1000 };
    writeTranscript("-Users-alice-repo", "blocks", [
      ...["thinking", "text", "tool"].map((block, i) => ({
        type: "assistant",
        uuid: `${block}-line`,
        sessionId: "blocks",
        timestamp: `2026-07-01T00:00:0${i}.000Z`,
        message: { id: "msg_one", model: "claude-opus-4-6", usage },
      })),
      {
        type: "assistant",
        uuid: "second-response",
        sessionId: "blocks",
        timestamp: "2026-07-01T00:00:05.000Z",
        message: { id: "msg_two", model: "claude-opus-4-6", usage },
      },
    ]);

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(messages.map((m) => m.id)).toEqual(["tool-line", "second-response"]);
    expect(messages.reduce((sum, m) => sum + (m.tokens?.output ?? 0), 0)).toBe(80);
  });

  it("reads subagent transcripts and marks them with their parent session", async () => {
    writeTranscript("-Users-alice-repo", "parent", [
      {
        type: "assistant",
        uuid: "main",
        sessionId: "parent",
        cwd: "/Users/alice/repo",
        timestamp: "2026-07-01T00:00:00.000Z",
        message: {
          id: "msg_main",
          model: "claude-opus-4-6",
          usage: { input_tokens: 5, output_tokens: 5 },
        },
      },
    ]);
    const subagentDir = join(projectsDir, "-Users-alice-repo", "parent", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(
      join(subagentDir, "agent-a1.jsonl"),
      JSON.stringify({
        type: "assistant",
        uuid: "sub",
        sessionId: "parent",
        isSidechain: true,
        cwd: "/Users/alice/repo",
        timestamp: "2026-07-01T00:00:01.000Z",
        message: {
          id: "msg_sub",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }) + "\n",
    );
    // Other files in a session directory are not transcripts.
    mkdirSync(join(projectsDir, "-Users-alice-repo", "parent", "tool-results"), {
      recursive: true,
    });
    writeFileSync(
      join(projectsDir, "-Users-alice-repo", "parent", "tool-results", "x.jsonl"),
      "{}\n",
    );

    const messages = await iterClaudeCodeCliMessages({ projectsDir });

    expect(
      messages
        .map((m) => [m.id, m.sessionID, m.subagent, m.parentSessionID, m.directory])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["main", "parent", false, undefined, "/Users/alice/repo"],
      ["sub", "parent", true, "parent", "/Users/alice/repo"],
    ]);
  });
});
