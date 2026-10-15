/** Real SQLite runtimes: run with both system Node and Bun after build. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardApi } from "../dist/dashboard/api.js";
import { BunSqliteDatabaseAdapter } from "../dist/dashboard/bun-sqlite-database.js";
import { openNativeDashboardDatabase } from "../dist/dashboard/native-database.js";
import { SqlJsDatabaseAdapter } from "../dist/dashboard/sqljs-database.js";
import { openAIAccounting } from "../dist/providers/accounting-adapters.js";
import { recordQuotaObservations } from "../dist/dashboard/quota-snapshot-bridge.js";
const root = await mkdtemp(join(tmpdir(), "quota-history-compat-"));
const open = process.versions.bun
  ? (path) => BunSqliteDatabaseAdapter.open(path)
  : openNativeDashboardDatabase;
let db;
try {
  const file = join(root, "history.db");
  db = await open(file);
  db.exec(await readFile(new URL("../dist/dashboard/schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO quota_snapshots(provider,captured_at,quota_data) VALUES(?,?,?)").run(
    "openai",
    Date.now(),
    JSON.stringify({ percentRemaining: 70, limits: [] }),
  );
  db.close();
  db = await open(file);
  const api = new DashboardApi(db);
  for (const account of ["a", "b", "a"]) {
    const accounting = openAIAccounting({
      success: true,
      label: "OpenAI",
      windows: { weekly: { percentRemaining: 25 } },
    });
    accounting.rows[0].account = { kind: "opaque", digest: account.repeat(64) };
    assert.deepEqual(
      recordQuotaObservations(api, [
        {
          providerId: "openai",
          result: {
            attempted: true,
            entries: [{ name: "Weekly", percentRemaining: 25 }],
            errors: [],
            accounting,
            accountIdentity: accounting.rows[0].account,
            observation: { id: account, observedAt: Date.now() },
          },
        },
      ]),
      [],
    );
  }
  assert.equal(api.getQuotaHistory("openai", 7, "unknown").length, 1);
  assert.equal(api.getAccountingHistory("openai").length, 2);
  assert.equal(
    api.getAccountingHistory("openai", 7, { accountIdentity: "b".repeat(64), windowId: "weekly" })
      .length,
    1,
  );
  assert.equal((await readdir(root)).filter((name) => name.includes("pre-v2")).length, 1);
  db.close();
  db = null;
  const reader = await SqlJsDatabaseAdapter.open(file);
  try {
    assert.equal(new DashboardApi(reader).getAccountingHistory("openai").length, 2);
  } finally {
    reader.close();
  }
  console.log(
    `History compatibility passed: ${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}, v1 backup/upgrade, account/window isolation, dedup, legacy and WASM reads.`,
  );
} finally {
  db?.close();
  await rm(root, { recursive: true, force: true });
}
