import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { sessionUsage } from "../src/core/usage.js";
import * as storage from "../src/lib/opencode-storage.js";
import { writeSessionDatabase } from "./helpers/session-database.js";

let root: string;
let databasePath: string;
let writer: DatabaseSync | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-quota-session-reuse-"));
  databasePath = join(root, "opencode.db");
  vi.stubEnv("OPENCODE_DB", databasePath);
  // Reads within 2 s of a database write are never kept; a clock 10 s ahead lets these tests'
  // fresh writes count as settled.
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10_000);
});

afterEach(async () => {
  writer?.close();
  writer = undefined;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function writeHistory(count = 1): void {
  writeSessionDatabase(databasePath, {
    sessions: [
      { id: "ses_root", created: 0 },
      { id: "ses_child", parentID: "ses_root", created: 1 },
    ],
    messages: Array.from({ length: count }, (_, index) => ({
      id: `msg_${index}`,
      sessionID: "ses_root",
      created: index,
      providerID: "anthropic",
      modelID: "test-model",
      tokens: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, reasoning: 5 },
    })),
  });
}

function openWriter(wal = false): DatabaseSync {
  writer = new DatabaseSync(databasePath);
  if (wal) writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  return writer;
}

async function lastWriteMs(): Promise<number> {
  let newestNs = 0n;
  for (const file of [databasePath, `${databasePath}-wal`]) {
    const info = await stat(file, { bigint: true }).catch(() => undefined);
    if (info && info.mtimeNs > newestNs) newestNs = info.mtimeNs;
    if (info && info.ctimeNs > newestNs) newestNs = info.ctimeNs;
  }
  return Number(newestNs / 1_000_000n);
}

function addChildMessage(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO session_message
    SELECT 'msg_child', 'ses_child', type, 0, time_created, time_updated, data
    FROM session_message WHERE id = 'msg_0';
  `);
}

describe("session token reuse", () => {
  it("shares nearby and concurrent snapshots without rereading history", async () => {
    writeHistory(501);
    const readPages = vi.spyOn(storage, "readUsageMessagePages");

    const [first, concurrent] = await Promise.all([
      sessionUsage("ses_root", "current"),
      sessionUsage("ses_root", "current"),
    ]);
    const repeat = await sessionUsage("ses_root", "current");

    expect(first).toEqual({
      input: 501 * 4,
      cachedInput: 501 * 2,
      output: 501 * 9,
      models: [{ modelID: "test-model", input: 501, cacheRead: 501 * 2, cacheWrite: 501 * 3 }],
    });
    expect(concurrent).toBe(first);
    expect(repeat).toBe(first);
    expect(readPages).toHaveBeenCalledTimes(1);
  });

  it("keeps database, session and scope separate", async () => {
    writeHistory();
    addChildMessage(openWriter());
    const readPages = vi.spyOn(storage, "readUsageMessagePages");

    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 4 });
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 8 });
    expect(await sessionUsage("ses_child", "current")).toMatchObject({ input: 4 });
    vi.stubEnv("OPENCODE_DB", join(root, "another.db"));
    expect(await sessionUsage("ses_root", "current")).toBeUndefined();
    expect(readPages).toHaveBeenCalledTimes(4);
  });

  it("recounts added, edited and deleted messages from the WAL without session timestamp changes", async () => {
    writeHistory();
    const database = openWriter(true);
    const readPages = vi.spyOn(storage, "readUsageMessagePages");
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 4, output: 9 });
    const before = await stat(databasePath, { bigint: true });

    database.exec(`
      INSERT INTO session_message
      SELECT 'msg_added', session_id, type, 1, time_created, time_updated, data
      FROM session_message WHERE id = 'msg_0';
    `);
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 8, output: 18 });

    database.exec(`UPDATE session_message SET data = json_set(data,
      '$.tokens.input', 11, '$.tokens.output', 14, '$.model.id', 'changed-model')
      WHERE id = 'msg_0'`);
    expect(await sessionUsage("ses_root", "current")).toEqual({
      input: 18,
      cachedInput: 4,
      output: 28,
      models: [
        { modelID: "changed-model", input: 11, cacheRead: 2, cacheWrite: 3 },
        { modelID: "test-model", input: 1, cacheRead: 2, cacheWrite: 3 },
      ],
    });

    database.exec("DELETE FROM session_message WHERE id = 'msg_0'");
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 4, output: 9 });
    expect(await stat(databasePath, { bigint: true })).toMatchObject({
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    expect(readPages).toHaveBeenCalledTimes(4);
  });

  it("invalidates tree totals when descendants gain messages, change parents or are created", async () => {
    writeHistory();
    const database = openWriter(true);
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 4 });

    addChildMessage(database);
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 8 });
    database.exec(
      "UPDATE session_message SET data = json_set(data, '$.tokens.input', 11) WHERE id = 'msg_child'",
    );
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 18 });
    database.exec("UPDATE session_v2 SET parent_id = NULL WHERE id = 'ses_child'");
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 4 });
    database.exec(`
      INSERT INTO session_v2 VALUES ('ses_grandchild', NULL, 'ses_root', NULL, 2, 2);
      UPDATE session_v2 SET parent_id = 'ses_grandchild' WHERE id = 'ses_child';
    `);
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 18 });
    database.exec("DELETE FROM session_v2 WHERE id = 'ses_child'");
    expect(await sessionUsage("ses_root", "tree")).toMatchObject({ input: 4 });
  });

  it("recounts when only the WAL's timestamp changes", async () => {
    writeHistory();
    const database = openWriter(true);
    database.exec("UPDATE session_message SET data = json_set(data, '$.tokens.input', 11)");
    database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const readPages = vi.spyOn(storage, "readUsageMessagePages");
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 14 });
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 14 });
    expect(readPages).toHaveBeenCalledTimes(1);

    const walPath = `${databasePath}-wal`;
    const before = await stat(walPath);
    await utimes(walPath, before.atime, new Date(before.mtimeMs + 5_000));
    expect((await stat(walPath)).size).toBe(before.size);
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 14 });
    expect(readPages).toHaveBeenCalledTimes(2);
  });

  it("does not keep totals read within 2 s of the last database write", async () => {
    writeHistory();
    const database = openWriter(true);
    database.exec("UPDATE session_message SET data = json_set(data, '$.tokens.input', 11)");
    const readPages = vi.spyOn(storage, "readUsageMessagePages");
    const lastWrite = await lastWriteMs();

    vi.mocked(Date.now).mockReturnValue(lastWrite + 1_999);
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 14 });
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 14 });
    expect(readPages).toHaveBeenCalledTimes(2);

    vi.mocked(Date.now).mockReturnValue(lastWrite + 2_000);
    await sessionUsage("ses_root", "current");
    await sessionUsage("ses_root", "current");
    expect(readPages).toHaveBeenCalledTimes(3);
  });

  it("recounts after 30 seconds and after the clock moves backwards", async () => {
    writeHistory();
    const start = (await lastWriteMs()) + 10_000;
    const now = vi.mocked(Date.now).mockReturnValue(start);
    const readPages = vi.spyOn(storage, "readUsageMessagePages");
    const first = await sessionUsage("ses_root", "current");
    now.mockReturnValue(start + 29_999);
    expect(await sessionUsage("ses_root", "current")).toBe(first);
    now.mockReturnValue(start + 30_000);
    expect(await sessionUsage("ses_root", "current")).toEqual(first);
    now.mockReturnValue(start - 5_000);
    expect(await sessionUsage("ses_root", "current")).toEqual(first);
    expect(readPages).toHaveBeenCalledTimes(3);
  });

  it("does not keep failed reads and notices when a missing database appears", async () => {
    expect(await sessionUsage("ses_root", "current")).toBeUndefined();
    writeHistory();
    const readPages = vi.spyOn(storage, "readUsageMessagePages").mockImplementationOnce(() => {
      throw new Error("temporary read failure");
    });
    expect(await sessionUsage("ses_root", "current")).toBeUndefined();
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 4 });
    expect(readPages).toHaveBeenCalledTimes(2);
  });

  it("lets other work run between actual history pages", async () => {
    writeHistory(501);
    const readPages = storage.readUsageMessagePages;
    const otherWorkRan: boolean[] = [];
    vi.spyOn(storage, "readUsageMessagePages").mockImplementation(async function* (params) {
      for await (const page of readPages(params)) {
        let ran = false;
        setImmediate(() => {
          ran = true;
        });
        yield page;
        otherWorkRan.push(ran);
      }
    });

    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 501 * 4 });
    expect(otherWorkRan).toEqual([true, true, true]);
  });

  it("does not reuse a recount if the database changed between its pages", async () => {
    writeHistory(501);
    const database = openWriter(true);
    const readPages = storage.readUsageMessagePages;
    vi.spyOn(storage, "readUsageMessagePages").mockImplementationOnce(async function* (params) {
      let changed = false;
      for await (const page of readPages(params)) {
        yield page;
        if (!changed) {
          database.exec(
            "UPDATE session_message SET data = json_set(data, '$.tokens.input', 11) WHERE id = 'msg_0'",
          );
          changed = true;
        }
      }
    });

    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 501 * 4 });
    expect(await sessionUsage("ses_root", "current")).toMatchObject({ input: 501 * 4 + 10 });
  });
});
