import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { openOpenCodeSqliteReadOnly } from "../src/lib/opencode-sqlite.js";

const runtimePaths = vi.hoisted(() => ({ dataDirs: [] as string[] }));

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({ dataDirs: runtimePaths.dataDirs }),
}));

async function importNodeSqlite(): Promise<typeof import("node:sqlite") | null> {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

describe("opencode sqlite adapter", () => {
  it("reads an OpenCode SQLite database through node:sqlite on Node runtimes", async () => {
    const sqlite = await importNodeSqlite();

    if (!sqlite) {
      console.warn(
        "Skipping node:sqlite adapter coverage because this Node runtime does not provide node:sqlite.",
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "opencode-sqlite-"));
    const dbPath = join(dir, "opencode.db");

    try {
      const writer = new sqlite.DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE usage (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          tokens INTEGER NOT NULL
        );
        INSERT INTO usage (provider, tokens) VALUES ('copilot', 42), ('qwen', 7);
      `);
      writer.close();

      const conn = await openOpenCodeSqliteReadOnly(dbPath);

      try {
        expect(
          conn.get<{ provider: string; tokens: number }>(
            "SELECT provider, tokens FROM usage WHERE id = ?",
            [1],
          ),
        ).toEqual({
          provider: "copilot",
          tokens: 42,
        });
        expect(
          conn.all<{ provider: string }>(
            "SELECT provider FROM usage WHERE tokens >= ? ORDER BY id",
            [7],
          ),
        ).toEqual([{ provider: "copilot" }, { provider: "qwen" }]);
      } finally {
        conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads authoritative completed assistant rows by completion time", async () => {
    const sqlite = await importNodeSqlite();

    if (!sqlite) {
      console.warn(
        "Skipping completed accounting integration coverage because this Node runtime does not provide node:sqlite.",
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "opencode-accounting-"));
    const dbPath = join(dir, "opencode.db");
    const cutoff = Date.parse("2026-07-16T00:00:00.000Z");

    try {
      runtimePaths.dataDirs = [dir];
      const writer = new sqlite.DatabaseSync(dbPath);
      writer.exec(`
        CREATE TABLE "message" (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          data TEXT NOT NULL
        );
      `);
      const insert = writer.prepare(
        `INSERT INTO "message" (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`,
      );
      const add = (
        id: string,
        role: "assistant" | "user",
        created: number,
        completed?: number,
      ): void => {
        insert.run(
          id,
          "ses_accounting",
          created,
          completed ?? created,
          JSON.stringify({
            role,
            providerID: "qwen-code",
            modelID: "qwen-plus",
            time: completed === undefined ? { created } : { created, completed },
          }),
        );
      };

      add("normal-response", "assistant", cutoff + 100, cutoff + 200);
      add("unfinished-response", "assistant", cutoff + 300);
      add("before-tool", "assistant", cutoff + 400, cutoff + 500);
      add("after-tool", "assistant", cutoff + 600, cutoff + 700);
      add("cross-cutoff", "assistant", cutoff - 60_000, cutoff + 50);
      add("user-row", "user", cutoff + 800, cutoff + 900);
      add("after-window", "assistant", cutoff + 1_100, cutoff + 1_200);
      writer.close();

      const { iterCompletedAssistantMessages } = await import("../src/lib/opencode-storage.js");
      const messages = await iterCompletedAssistantMessages({
        completedSinceMs: cutoff,
        completedUntilMs: cutoff + 1_000,
      });

      expect(messages.map((message) => message.id)).toEqual([
        "cross-cutoff",
        "normal-response",
        "before-tool",
        "after-tool",
      ]);
      expect(messages.every((message) => typeof message.time?.completed === "number")).toBe(true);
    } finally {
      runtimePaths.dataDirs = [];
      await rm(dir, { recursive: true, force: true });
    }
  });
});
