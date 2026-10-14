import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import { recordQuotaObservations } from "../src/dashboard/quota-snapshot-bridge.js";
import { SqlJsDatabaseAdapter } from "../src/dashboard/sqljs-database.js";
import type { ProviderResultForSnapshot } from "../src/dashboard/quota-snapshot-bridge.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
function observation(id: string, observedAt: number): ProviderResultForSnapshot {
  return {
    providerId: "openai",
    result: {
      attempted: true,
      observation: { id, observedAt },
      entries: [{ name: "5h", percentRemaining: 40 }],
      errors: [],
    },
  };
}
describe("shared plugin/GUI observation recording", () => {
  it("deduplicates across reopen and preserves different fetches in the same millisecond and v1 rows", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-history-"));
    const file = join(root, "history.db");
    let db = await openNativeDashboardDatabase(file);
    let api = new DashboardApi(db);
    api.captureSnapshot("legacy", { percentRemaining: 70, limits: [] });
    const now = Date.now();
    const first = observation("first", now);
    recordQuotaObservations(api, [first]);
    recordQuotaObservations(api, [first]);
    db.close();
    db = await openNativeDashboardDatabase(file);
    api = new DashboardApi(db);
    recordQuotaObservations(api, [first, observation("second", now)]);
    expect(api.getQuotaHistory("openai")).toHaveLength(2);
    expect(api.getQuotaHistory("openai").map((r) => r.timestamp)).toEqual([now, now]);
    expect(api.getQuotaHistory("legacy")[0]).toMatchObject({
      percentRemaining: 70,
      accountIdentity: "unknown",
    });
    db.close();
    // Legacy readers use the unchanged v1 tables and JSON percentage fields.
    const reader = await SqlJsDatabaseAdapter.open(file);
    const history = new DashboardApi(reader);
    expect(history.getQuotaHistory("openai")).toHaveLength(2);
    expect(history.getCurrentQuota("legacy")).toEqual({ percentRemaining: 70, limits: [] });
    reader.close();
  });
  it("persists failures without fabricating percentages; value-only entries stay absent", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-history-"));
    const db = await openNativeDashboardDatabase(join(root, "history.db"));
    const api = new DashboardApi(db);
    const now = Date.now();
    const error = observation("error", now);
    error.result.entries = [];
    error.result.errors = [{ label: "OpenAI", message: "Reauthenticate" }];
    const value = observation("value", now);
    value.providerId = "opencode-go";
    value.result.entries = [{ kind: "value", name: "Spend", value: "$12" }];
    expect(recordQuotaObservations(api, [error, value])).toEqual([]);
    expect(api.getQuotaHistory("openai")[0]).toMatchObject({
      percentUsed: null,
      percentRemaining: null,
      limits: [],
      error: "Reauthenticate",
      accountIdentity: "unknown",
    });
    expect(api.getQuotaHistory("opencode-go")).toEqual([]);
    db.close();
  });
  it("reports a locked writer and leaves an independent reader usable", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-history-"));
    const file = join(root, "history.db");
    const lock = await openNativeDashboardDatabase(file);
    new DashboardApi(lock);
    const writer = await openNativeDashboardDatabase(file);
    writer.exec("PRAGMA busy_timeout = 10");
    const api = new DashboardApi(writer);
    lock.exec("BEGIN IMMEDIATE");
    try {
      expect(recordQuotaObservations(api, [observation("locked", Date.now())])).toEqual([
        "History write failed for openai",
      ]);
      expect(api.getQuotaHistory("openai")).toEqual([]);
    } finally {
      lock.exec("ROLLBACK");
      writer.close();
      lock.close();
    }
  });
  it("orders observations by their actual timestamp even when storage keys collide", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-history-"));
    const db = await openNativeDashboardDatabase(join(root, "history.db"));
    const api = new DashboardApi(db);
    const now = Date.now();
    const latest = observation("latest", now + 1);
    latest.result.entries = [{ name: "5h", percentRemaining: 15 }];
    recordQuotaObservations(api, [
      latest,
      observation("a", now),
      observation("b", now),
      observation("c", now),
    ]);
    expect(api.getCurrentQuota("openai").percentRemaining).toBe(15);
    expect(api.getQuotaHistory("openai").map((r) => r.timestamp)).toEqual([now, now, now, now + 1]);
    db.close();
  });

  it("refuses WAL databases instead of changing a live writer's journal mode", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-history-"));
    const file = join(root, "history.db");
    const db = await openNativeDashboardDatabase(file);
    new DashboardApi(db);
    db.exec("PRAGMA journal_mode = WAL");
    await expect(openNativeDashboardDatabase(file)).rejects.toThrow("WAL mode");
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    db.close();
  });
});
