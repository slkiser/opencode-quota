import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openOpenCodeSqliteReadOnly } from "../src/lib/opencode-sqlite.js";

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
      console.warn("Skipping node:sqlite adapter coverage because this Node runtime does not provide node:sqlite.");
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
        expect(conn.get<{ provider: string; tokens: number }>("SELECT provider, tokens FROM usage WHERE id = ?", [1])).toEqual({
          provider: "copilot",
          tokens: 42,
        });
        expect(conn.all<{ provider: string }>("SELECT provider FROM usage WHERE tokens >= ? ORDER BY id", [7])).toEqual([
          { provider: "copilot" },
          { provider: "qwen" },
        ]);
      } finally {
        conn.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
