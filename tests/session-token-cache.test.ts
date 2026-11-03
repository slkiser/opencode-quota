import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const paths = vi.hoisted(() => ({ dataDirs: [] as string[] }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirCandidates: () => ({ dataDirs: paths.dataDirs }),
}));

import * as sqlite from "../src/lib/opencode-sqlite.js";
import { getOpenCodeStorageRevision } from "../src/lib/opencode-storage.js";
import {
  getSessionTokenSummary,
  getSessionTreeTokenSummary,
  SessionNotFoundError,
} from "../src/lib/quota-stats.js";

const nodeSqlite = await import("node:sqlite").catch(() => null);

describe.skipIf(nodeSqlite === null)("session token summary cache", () => {
  let dir: string;
  let dbPath: string;
  let writer: DatabaseSync;
  let historyReads: number;

  function addSession(id: string, parentID: string | null = null): void {
    writer.prepare('INSERT INTO "session" VALUES (?, ?, ?, 1, 1)').run(id, id, parentID);
  }

  function addMessage(id: string, sessionID: string, input: number): void {
    writer.prepare('INSERT INTO "message" VALUES (?, ?, 1, 1, ?)').run(
      id,
      sessionID,
      JSON.stringify({
        role: "assistant",
        modelID: "gpt-5",
        tokens: { input, output: 2, cache: { read: 3 } },
      }),
    );
  }

  function updateInput(id: string, input: number): void {
    // No session timestamp or message timestamp changes: these cannot be used as revisions.
    writer
      .prepare(`UPDATE "message" SET data = json_set(data, '$.tokens.input', ?) WHERE id = ?`)
      .run(input, id);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quota-session-cache-"));
    dbPath = join(dir, "opencode.db");
    paths.dataDirs = [dir];
    if (!nodeSqlite) throw new Error("node:sqlite unavailable");
    writer = new nodeSqlite.DatabaseSync(dbPath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE "session" (id TEXT PRIMARY KEY, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE "message" (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    addSession("ses_root");
    addMessage("msg_root", "ses_root", 10);
    historyReads = 0;
    // Totals read within 2 s of a write are never reused; a clock 10 s ahead lets these tests'
    // fresh writes count as settled.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10_000 });
    const originalOpen = sqlite.openOpenCodeSqliteReadOnly;
    vi.spyOn(sqlite, "openOpenCodeSqliteReadOnly").mockImplementation(async (path) => {
      const conn = await originalOpen(path);
      const originalAll = conn.all.bind(conn);
      conn.all = (sql, args) => {
        if (sql.includes('FROM "message"')) historyReads++;
        return originalAll(sql, args);
      };
      return conn;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    writer.close();
    paths.dataDirs = [];
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses unchanged totals and keeps caller mutations out of the cache", async () => {
    const first = await getSessionTokenSummary("ses_root");
    expect(first).toMatchObject({
      totalInput: 10,
      totalCachedInput: 3,
      totalCombinedInput: 13,
      totalOutput: 2,
    });
    if (first) first.models[0].input = 999;
    const second = await getSessionTokenSummary("ses_root");
    expect(second?.models[0].input).toBe(10);
    if (second) second.models[0].input = 888;
    expect((await getSessionTokenSummary("ses_root"))?.models[0].input).toBe(10);
    expect(historyReads).toBe(1);
  });

  it("invalidates on WAL edits, inserts, deletions and checkpoint truncation", async () => {
    addMessage("msg_later", "ses_root", 20);
    const databaseBefore = statSync(dbPath);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(30);
    updateInput("msg_root", 15);
    expect(statSync(dbPath).mtimeMs).toBe(databaseBefore.mtimeMs);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(35);
    addMessage("msg_new", "ses_root", 40);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(75);
    writer.prepare('DELETE FROM "message" WHERE id = ?').run("msg_later");
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(55);
    const revision = getOpenCodeStorageRevision();
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(getOpenCodeStorageRevision()?.key).not.toBe(revision?.key);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(55);
    expect(historyReads).toBe(5);
  });

  it("separates scopes and includes new, edited, reparented and deleted descendants", async () => {
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
    expect((await getSessionTreeTokenSummary("ses_root"))?.totalInput).toBe(10);
    await getSessionTreeTokenSummary("ses_root");
    expect(historyReads).toBe(2);
    addSession("ses_child", "ses_root");
    addSession("ses_leaf", "ses_child");
    addMessage("msg_child", "ses_child", 20);
    addMessage("msg_leaf", "ses_leaf", 30);
    expect((await getSessionTreeTokenSummary("ses_root"))?.totalInput).toBe(60);
    updateInput("msg_leaf", 35);
    expect((await getSessionTreeTokenSummary("ses_root"))?.totalInput).toBe(65);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
    writer.exec(`UPDATE "session" SET parent_id = NULL WHERE id = 'ses_leaf'`);
    expect((await getSessionTreeTokenSummary("ses_root"))?.totalInput).toBe(30);
    writer.exec(`DELETE FROM "session" WHERE id = 'ses_child'`);
    expect((await getSessionTreeTokenSummary("ses_root"))?.totalInput).toBe(10);
  });

  it("caches empty results but never caches missing-session failures", async () => {
    addSession("ses_empty");
    expect(await getSessionTokenSummary("ses_empty")).toBeNull();
    expect(await getSessionTokenSummary("ses_empty")).toBeNull();
    expect(historyReads).toBe(1);
    addMessage("msg_empty", "ses_empty", 7);
    expect((await getSessionTokenSummary("ses_empty"))?.totalInput).toBe(7);
    await expect(getSessionTokenSummary("ses_missing")).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
    addSession("ses_missing");
    expect(await getSessionTokenSummary("ses_missing")).toBeNull();
    writer.exec(`DELETE FROM "session" WHERE id = 'ses_empty'`);
    await expect(getSessionTokenSummary("ses_empty")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("expires nearby reuse and bounds the number of retained sessions", async () => {
    vi.useFakeTimers({ now: Date.now() });
    await getSessionTokenSummary("ses_root");
    vi.advanceTimersByTime(29_999);
    await getSessionTokenSummary("ses_root");
    expect(historyReads).toBe(1);
    vi.advanceTimersByTime(1);
    await getSessionTokenSummary("ses_root");
    expect(historyReads).toBe(2);
    for (let index = 0; index < 33; index++) addSession(`ses_${index}`);
    for (let index = 0; index < 33; index++) await getSessionTokenSummary(`ses_${index}`);
    const readsBefore = historyReads;
    await getSessionTokenSummary("ses_32");
    expect(historyReads).toBe(readsBefore);
    await getSessionTokenSummary("ses_0");
    expect(historyReads).toBe(readsBefore + 1);
  });

  it("does not cache a summary when storage changes during its read", async () => {
    const open = sqlite.openOpenCodeSqliteReadOnly;
    vi.mocked(sqlite.openOpenCodeSqliteReadOnly).mockImplementationOnce(async (path) => {
      // The original implementation is wrapped below to change storage just after reading rows.
      const conn = await open(path);
      const all = conn.all.bind(conn);
      conn.all = (sql, args) => {
        const rows = all(sql, args);
        updateInput("msg_root", 42);
        return rows;
      };
      return conn;
    });
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(42);
    expect(historyReads).toBe(2);
  });

  it("does not reuse totals for a different or missing database", async () => {
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
    paths.dataDirs = [join(dir, "missing")];
    expect(getOpenCodeStorageRevision()).toBeNull();
    await expect(getSessionTokenSummary("ses_root")).rejects.toBeInstanceOf(SessionNotFoundError);
    paths.dataDirs = [dir];
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
  });

  it("detects rollback-journal writes even when modification time is restored", async () => {
    writer.exec("PRAGMA journal_mode = DELETE");
    const before = statSync(dbPath);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(10);
    updateInput("msg_root", 21);
    utimesSync(dbPath, before.atime, before.mtime);
    expect((await getSessionTokenSummary("ses_root"))?.totalInput).toBe(21);
    expect(historyReads).toBe(2);
  });

  it("changes the revision when only a file timestamp changes", () => {
    writer.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const walPath = `${dbPath}-wal`;
    const wal = statSync(walPath);
    const revision = getOpenCodeStorageRevision();
    utimesSync(walPath, wal.atime, new Date(wal.mtimeMs + 5_000));
    expect(statSync(walPath).size).toBe(wal.size);
    expect(getOpenCodeStorageRevision()?.key).not.toBe(revision?.key);
  });

  it("does not reuse totals read within 2 s of the last write", async () => {
    const newestChangeMs = getOpenCodeStorageRevision()?.newestChangeMs ?? 0;
    vi.setSystemTime(newestChangeMs + 1_999);
    await getSessionTokenSummary("ses_root");
    await getSessionTokenSummary("ses_root");
    expect(historyReads).toBe(2);
    vi.setSystemTime(newestChangeMs + 2_000);
    await getSessionTokenSummary("ses_root");
    await getSessionTokenSummary("ses_root");
    expect(historyReads).toBe(3);
  });
});
