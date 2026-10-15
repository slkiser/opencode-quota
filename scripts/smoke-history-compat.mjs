import { syncLocalQuotaEstimate } from "../dist/lib/quota-providers-local.js";
import { validateQuotaDefinitions } from "../dist/lib/quota-provider-definitions.js";
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
import {
  getResetEvents,
  claimResetEvents,
  settleResetEvent,
} from "../dist/dashboard/reset-events.js";
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
  const now = Date.now();
  const local = validateQuotaDefinitions([
    {
      id: "custom-smoke",
      providerId: "fixture",
      label: "Local",
      mode: "local-estimate",
      windows: [
        { id: "hour", type: "rolling", durationMinutes: 60, requestLimit: 10, usdBudget: 10 },
      ],
    },
  ])[0];
  const completion = {
    id: "source-a",
    sessionID: "ses_fixture",
    role: "assistant",
    providerID: "fixture",
    modelID: "fixture",
    time: { created: now - 2000, completed: now - 1000 },
    tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } },
  };
  const estimate = await syncLocalQuotaEstimate(db, local, now, {
    readOpenCode: async () => [completion],
    price: () => 2,
  });
  assert.equal(estimate.entries[0].percentRemaining, 90);
  assert.equal(estimate.entries[1].percentRemaining, 80);
  await syncLocalQuotaEstimate(db, local, now, {
    readOpenCode: async () => [{ ...completion, id: "canonical-copy" }],
    price: () => 2,
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM custom_estimate_events").get().n, 1);
  for (const before of [true, false, false]) {
    const accounting = openAIAccounting({
      success: true,
      label: "Reset fixture",
      windows: {
        weekly: {
          percentRemaining: before ? 25 : 100,
          resetTimeIso: new Date(now + (before ? -1000 : 604800000)).toISOString(),
        },
      },
    });
    accounting.rows[0].account = { kind: "opaque", digest: "c".repeat(64) };
    recordQuotaObservations(api, [
      {
        providerId: "reset-fixture",
        result: {
          attempted: true,
          entries: [],
          errors: [],
          accounting,
          observation: {
            id: before ? "reset-before" : "reset-after",
            observedAt: now - (before ? 2000 : 0),
          },
        },
      },
    ]);
  }
  assert.equal(getResetEvents(db, "reset-fixture").length, 1);
  const claimOptions = {
    enabled: true,
    watched: [{ providerId: "reset-fixture", windowId: "weekly" }],
    channel: "desktop",
    consumerId: "compat",
    now,
  };
  const claim = claimResetEvents(db, claimOptions)[0];
  assert.equal(claimResetEvents(db, { ...claimOptions, channel: "plugin" }).length, 0);
  assert.equal(
    settleResetEvent(db, {
      id: claim.event.id,
      leaseToken: claim.leaseToken,
      channel: "desktop",
      delivered: true,
      now,
    }),
    true,
  );
  assert.equal(getResetEvents(db, "reset-fixture")[0].state, "delivered");
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
