import { describe, expect, it } from "vitest";

import { formatTokens, parseSessionsArgs, runCliSessionsCommand } from "../src/lib/cli-sessions.js";
import type { SessionUsageDeps } from "../src/lib/session-usage.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 86_400_000;

function capture() {
  let text = "";
  return { stream: { write: (chunk: string) => ((text += chunk), true) }, read: () => text };
}

const deps: Partial<SessionUsageDeps> = {
  storeExists: (source) => source !== "opencode",
  readClaude: async () => [
    {
      id: "a",
      sessionID: "claude-session-1",
      role: "assistant",
      providerID: "anthropic",
      modelID: "claude-sonnet",
      directory: "/work/token-watcher",
      subagent: false,
      tokens: { input: 100, output: 400, reasoning: 0, cache: { read: 1500, write: 0 } },
      time: { created: Date.parse("2026-10-13T09:00:00Z") },
    },
  ],
  readCodex: async () => [],
  price: () => null,
};

describe("parseSessionsArgs", () => {
  it("defaults to the last 28 days", () => {
    expect(parseSessionsArgs([], NOW)).toMatchObject({
      ok: true,
      json: false,
      sinceMs: NOW - 28 * DAY,
      untilMs: undefined,
      limit: 10,
    });
  });

  it("accepts dates, day counts and inline values", () => {
    expect(parseSessionsArgs(["--since", "7d", "--json"], NOW)).toMatchObject({
      sinceMs: NOW - 7 * DAY,
      json: true,
    });
    expect(
      parseSessionsArgs(["--since=2026-10-01", "--until", "2026-10-10", "--limit=3"], NOW),
    ).toMatchObject({
      sinceMs: Date.parse("2026-10-01T00:00:00Z"),
      untilMs: Date.parse("2026-10-11T00:00:00Z") - 1,
      limit: 3,
    });
  });

  it("rejects bad input", () => {
    expect(parseSessionsArgs(["--since", "2026-13-01"], NOW).ok).toBe(false);
    expect(parseSessionsArgs(["--since"], NOW).ok).toBe(false);
    expect(parseSessionsArgs(["--limit", "-1"], NOW).ok).toBe(false);
    expect(parseSessionsArgs(["--bogus"], NOW).ok).toBe(false);
    expect(
      parseSessionsArgs(["--since", "2026-10-10", "--until", "2026-10-01"], NOW),
    ).toMatchObject({ ok: false, error: "--until is before --since." });
  });
});

describe("formatTokens", () => {
  it("abbreviates large counts", () => {
    expect([formatTokens(950), formatTokens(12_300), formatTokens(4_100_000)]).toEqual([
      "950",
      "12.3k",
      "4.1M",
    ]);
  });
});

describe("runCliSessionsCommand", () => {
  it("prints coverage, trends, sessions and n/a for unavailable values", async () => {
    const out = capture();
    const code = await runCliSessionsCommand({ argv: [], nowMs: NOW, deps, stdout: out.stream });
    const text = out.read();

    expect(code).toBe(0);
    expect(text).toContain("Session usage 2026-09-20 to now (UTC)");
    expect(text).toContain("claude-code  1 sessions, 1 responses");
    expect(text).toContain("opencode     no local store found");
    expect(text).toContain("codex        0 sessions, 0 responses, subagents not marked");
    expect(text).toMatch(/2026-10-12\s+claude-code\s+1\s+1\s+2\.0k\s+93\.8%/);
    expect(text).toMatch(/claude-code\s+claude-sess\S*\s+token-watcher/);
    expect(text).toContain("n/a means the value is not available, not zero.");
  });

  it("prints the full report as JSON", async () => {
    const out = capture();
    await runCliSessionsCommand({ argv: ["--json"], nowMs: NOW, deps, stdout: out.stream });
    const report = JSON.parse(out.read());
    expect(report.sessions[0]).toMatchObject({
      sessionID: "claude-session-1",
      costUsd: null,
      unpricedTokens: 2000,
    });
    expect(report.coverage.map((c: { status: string }) => c.status)).toEqual([
      "read",
      "not-found",
      "read",
    ]);
  });

  it("exits 1 with usage on a bad option", async () => {
    const err = capture();
    const code = await runCliSessionsCommand({ argv: ["--nope"], nowMs: NOW, stderr: err.stream });
    expect(code).toBe(1);
    expect(err.read()).toContain("Unknown option: --nope");
  });
});
