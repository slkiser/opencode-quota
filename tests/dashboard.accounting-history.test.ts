import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import { SqlJsDatabaseAdapter } from "../src/dashboard/sqljs-database.js";
import { recordQuotaObservations } from "../src/dashboard/quota-snapshot-bridge.js";
import { openAIAccounting } from "../src/providers/accounting-adapters.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function open(file: string, backend: string) {
  if (backend === "native") return openNativeDashboardDatabase(file);
  const Database = (await import("better-sqlite3")).default;
  return new Database(file);
}
function fixture(id: string, account: string, now: number) {
  const accounting = openAIAccounting({
    success: true,
    label: "OpenAI",
    windows: { weekly: { percentRemaining: 25 } },
  });
  for (const row of accounting.rows) row.account = { kind: "opaque", digest: account };
  return {
    providerId: "openai",
    result: {
      attempted: true,
      entries: [{ name: "Weekly", percentRemaining: 25 }],
      errors: [],
      accounting,
      accountIdentity: { kind: "opaque" as const, digest: account },
      observation: { id, observedAt: now },
    },
  };
}
describe.each(["native", "better-sqlite3"])("additive history migration: %s", (backend) => {
  it("rolls back partial migration DDL while retaining the v1 data and backup", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-v2-history-"));
    const db = await open(join(root, "history.db"), backend);
    db.exec(await readFile(new URL("../src/dashboard/schema.sql", import.meta.url), "utf8"));
    const wrapped = {
      prepare: (sql: string) => db.prepare(sql),
      close: () => db.close(),
      exec: (sql: string) => {
        if (sql.includes("idx_accounting_identity_time")) {
          db.exec(sql.split("CREATE INDEX")[0]);
          throw new Error("injected migration failure");
        }
        return db.exec(sql);
      },
    };
    expect(() => new DashboardApi(wrapped)).toThrow("injected migration failure");
    expect(db.prepare("SELECT max(version) AS version FROM schema_version").get()).toMatchObject({
      version: 1,
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='accounting_observations'").get(),
    ).toBeUndefined();
    expect((await readdir(root)).filter((name) => name.includes("pre-v2"))).toHaveLength(1);
    new DashboardApi(db); // recovery retries cleanly
    expect(db.prepare("SELECT max(version) AS version FROM schema_version").get()).toMatchObject({
      version: 4,
    });
    db.close();
  });
  it("backs up v1, repeats safely, retains unknown rows, separates accounts/windows and permits legacy rollback", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-v2-history-"));
    const file = join(root, "history.db");
    let db = await open(file, backend);
    db.exec(await readFile(new URL("../src/dashboard/schema.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO quota_snapshots(provider, captured_at, quota_data) VALUES(?,?,?)").run(
      "openai",
      Date.now(),
      JSON.stringify({ percentRemaining: 70, limits: [] }),
    );
    db.close();
    // Upgrade a copy of actual v1 data, preserving an independently readable backup.
    db = await open(file, backend);
    const api = new DashboardApi(db);
    const backups = (await readdir(root)).filter((name) => name.includes("pre-v2"));
    expect(backups).toHaveLength(1);
    expect((await stat(join(root, backups[0]))).mode & 0o077).toBe(0);
    const backup = await open(join(root, backups[0], "history.sqlite"), backend);
    expect(
      backup.prepare("SELECT max(version) AS version FROM schema_version").get(),
    ).toMatchObject({ version: 1 });
    expect(backup.prepare("SELECT count(*) AS count FROM quota_snapshots").get()).toMatchObject({
      count: 1,
    });
    backup.close();
    new DashboardApi(db);
    expect((await readdir(root)).filter((name) => name.includes("pre-v2"))).toHaveLength(1);
    const a = fixture("a", "a".repeat(64), Date.now());
    const b = fixture("b", "b".repeat(64), Date.now());
    recordQuotaObservations(api, [a, b, a]);
    expect(api.getAccountingHistory("openai")).toHaveLength(2);
    expect(
      api.getAccountingHistory("openai", 7, {
        accountIdentity: "a".repeat(64),
        windowId: "weekly",
      }),
    ).toHaveLength(1);
    expect(
      api.getAccountingHistory("openai", 7, {
        accountIdentity: "a".repeat(64),
        windowId: "hourly",
      }),
    ).toEqual([]);
    expect(api.getQuotaHistory("openai", 7, "unknown")).toHaveLength(1);
    expect(api.getQuotaHistory("openai", 7, "a".repeat(64))).toHaveLength(1);
    // Pre-v2 reader SQL and writers continue using unchanged tables/columns.
    expect(
      db.prepare("SELECT count(*) AS count FROM quota_snapshots WHERE provider=?").get("openai"),
    ).toMatchObject({ count: 3 });
    db.prepare("INSERT INTO quota_snapshots(provider,captured_at,quota_data) VALUES(?,?,?)").run(
      "legacy-writer",
      Date.now(),
      JSON.stringify({ percentRemaining: 90 }),
    );
    db.close();
    const reader = await SqlJsDatabaseAdapter.open(file);
    const readApi = new DashboardApi(reader);
    expect(
      readApi.getAccountingHistory("openai", 7, { accountIdentity: "b".repeat(64) }),
    ).toHaveLength(1);
    expect(readApi.getCurrentQuota("legacy-writer")).toEqual({ percentRemaining: 90 });
    reader.close();
  });
  it("rolls back rich and legacy writes atomically when an inserted row fails", async () => {
    root = await mkdtemp(join(tmpdir(), "quota-v2-history-"));
    const db = await open(join(root, "history.db"), backend);
    const api = new DashboardApi(db);
    db.exec(
      "CREATE TRIGGER reject_rich BEFORE INSERT ON accounting_observations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
    );
    expect(recordQuotaObservations(api, [fixture("a", "a".repeat(64), Date.now())])).toEqual([
      "History write failed for openai",
    ]);
    expect(api.getQuotaHistory("openai")).toEqual([]);
    expect(api.getAccountingHistory("openai")).toEqual([]);
    db.close();
  });
});
it("persists typed value-only data without fabricating a legacy percentage row", async () => {
  root = await mkdtemp(join(tmpdir(), "quota-v2-history-"));
  const db = await openNativeDashboardDatabase(join(root, "history.db"));
  const api = new DashboardApi(db);
  const value = fixture("value", "a".repeat(64), Date.now());
  value.result.entries = [];
  value.result.accounting.rows[0].value = {
    kind: "quantity",
    quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
  };
  recordQuotaObservations(api, [value, value]);
  expect(api.getQuotaHistory("openai")).toEqual([]);
  expect(api.getAccountingHistory("openai")[0].row.value).toEqual({
    kind: "quantity",
    quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
  });
  expect(api.getAccountingHistory("openai")).toHaveLength(1);
  db.close();
});
