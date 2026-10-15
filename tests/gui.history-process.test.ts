import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HistoryHelperClient } from "../src/gui/history-client.js";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { SqlJsDatabaseAdapter } from "../src/dashboard/sqljs-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import type { ProviderResultForSnapshot } from "../src/dashboard/quota-snapshot-bridge.js";
import { openAIAccounting } from "../src/providers/accounting-adapters.js";
import type { ResetClaim } from "../src/dashboard/reset-events.js";
import type { StoredResetEvent } from "../src/lib/quota-reset-transition.js";

let root: string;
const clients: HistoryHelperClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), "gui-history-process-"));
  const data = join(root, "data", "opencode");
  await mkdir(data, { recursive: true });
  const env = {
    HOME: root,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_CONFIG_DIR: "",
  };
  const make = () => {
    const client = new HistoryHelperClient({
      nodeBinary: process.execPath,
      helperPath: fileURLToPath(new URL("../dist/gui/history-helper.js", import.meta.url)),
      env,
      timeoutMs: 5000,
    });
    clients.push(client);
    return client;
  };
  return { data, make };
}
function observation(id: string, observedAt: number): ProviderResultForSnapshot {
  const accounting = openAIAccounting({
    success: true,
    label: "OpenAI",
    windows: { hourly: { percentRemaining: 40 } },
  });
  accounting.rows[0].account = { kind: "opaque", digest: (id === "b" ? "b" : "a").repeat(64) };
  return {
    providerId: "openai",
    result: {
      attempted: true,
      accounting,
      accountIdentity: accounting.rows[0].account,
      observation: { id, observedAt },
      entries: [{ name: "5h", percentRemaining: 40 }],
      errors: [],
    },
  };
}
const pricing = { source: "bundled" as const, autoRefresh: 0 };

describe("installed helper protocol with real SQLite processes", () => {
  it("upgrades two writers concurrently and claims one durable reset across channels and restart", async () => {
    const { data, make } = await setup();
    const file = join(data, "quota-dashboard.db");
    const db = await openNativeDashboardDatabase(file);
    const api = new DashboardApi(db);
    const now = Date.now();
    function resetObservation(id: string, before: boolean): ProviderResultForSnapshot {
      const accounting = openAIAccounting({
        success: true,
        label: "OpenAI",
        windows: {
          weekly: {
            percentRemaining: before ? 25 : 100,
            resetTimeIso: new Date(now + (before ? -1000 : 604800000)).toISOString(),
          },
        },
      });
      accounting.rows[0].account = { kind: "opaque", digest: "a".repeat(64) };
      return {
        providerId: "openai",
        result: {
          attempted: true,
          entries: [{ name: "Weekly", percentRemaining: before ? 25 : 100 }],
          errors: [],
          accounting,
          observation: { id, observedAt: now - (before ? 2000 : 0) },
        },
      };
    }
    api.captureSnapshot("openai", {
      accounting: resetObservation("before", true).result.accounting,
      observation: { id: "before", observedAt: now - 2000 },
      accountingOnly: true,
    });
    // Exercise a real v2 fixture upgrade, not only steady-state v3 contention.
    db.exec("DROP TABLE reset_events; DELETE FROM schema_version WHERE version=3;");
    db.close();
    const a = make(),
      b = make(),
      current = resetObservation("after", false);
    await Promise.all([
      a
        .request({ operation: "record", providerResults: [current], now, pricing })
        .catch((error) => {
          throw new Error("writer A: " + error.message);
        }),
      b
        .request({ operation: "record", providerResults: [current], now, pricing })
        .catch((error) => {
          throw new Error("writer B: " + error.message);
        }),
    ]);
    const backups = (await readdir(data)).filter((name) => name.includes("pre-v3"));
    expect(backups).toHaveLength(1);
    const backup = await openNativeDashboardDatabase(join(data, backups[0], "history.sqlite"));
    expect(backup.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect(
      backup.prepare("SELECT max(version) AS version FROM schema_version").get(),
    ).toMatchObject({ version: 2 });
    backup.close();
    const verified = await openNativeDashboardDatabase(file);
    expect(verified.prepare("PRAGMA integrity_check").get()).toMatchObject({
      integrity_check: "ok",
    });
    verified.close();
    const events = await a.request<StoredResetEvent[]>({
      operation: "reset-events",
      providerId: "openai",
    });
    expect(events).toHaveLength(1);
    const watched = [{ providerId: "openai", windowId: "weekly" }];
    const claims = await Promise.all([
      a.request<ResetClaim[]>({
        operation: "reset-claim",
        enabled: true,
        watched,
        channel: "desktop",
        consumerId: "a",
        now,
      }),
      b.request<ResetClaim[]>({
        operation: "reset-claim",
        enabled: true,
        watched,
        channel: "plugin",
        consumerId: "b",
        now,
      }),
    ]);
    expect(claims.flat()).toHaveLength(1);
    const index = claims[0].length ? 0 : 1,
      claim = claims[index][0],
      winner = index ? b : a;
    expect(
      await winner.request({
        operation: "reset-settle",
        id: claim.event.id,
        leaseToken: claim.leaseToken,
        channel: index ? "plugin" : "desktop",
        delivered: true,
        now,
      }),
    ).toBe(true);
    a.dispose();
    b.dispose();
    const restarted = make();
    expect(
      (await restarted.request<StoredResetEvent[]>({ operation: "reset-events" }))[0].state,
    ).toBe("delivered");
    expect(
      await restarted.request({
        operation: "reset-claim",
        enabled: true,
        watched,
        channel: "desktop",
        consumerId: "restart",
        now,
      }),
    ).toEqual([]);
  });
  it("preserves two concurrent writers, a WASM reader, restart and a legacy reader", async () => {
    const { data, make } = await setup();
    const file = join(data, "quota-dashboard.db");
    const seed = await openNativeDashboardDatabase(file);
    new DashboardApi(seed).captureSnapshot("legacy", { percentRemaining: 60, limits: [] });
    seed.close();
    const reader = await SqlJsDatabaseAdapter.open(file);
    const api = new DashboardApi(reader);
    expect(api.listProviders()).toContain("legacy");
    const now = Date.now();
    const shared = observation("shared-observation", now);
    const a = make(),
      b = make();
    const results = await Promise.all([
      a.request<{ diagnostics: string[] }>({
        operation: "record",
        providerResults: [shared, observation("a", now)],
        now,
        pricing,
      }),
      b.request<{ diagnostics: string[] }>({
        operation: "record",
        providerResults: [shared, observation("b", now)],
        now,
        pricing,
      }),
    ]);
    expect(
      results.every((r) => !r.diagnostics.some((d) => d.startsWith("History write failed"))),
    ).toBe(true);
    expect(api.getQuotaHistory("openai")).toHaveLength(3);
    expect(api.getAccountingHistory("openai")).toHaveLength(3);
    expect(
      api.getAccountingHistory("openai", 7, {
        accountIdentity: "b".repeat(64),
        windowId: "hourly",
      }),
    ).toHaveLength(1);
    a.dispose();
    b.dispose();
    await make().request({ operation: "record", providerResults: [shared], now, pricing });
    const reopened = await SqlJsDatabaseAdapter.open(file);
    expect(new DashboardApi(reopened).getQuotaHistory("openai")).toHaveLength(3);
    expect(new DashboardApi(reopened).getAccountingHistory("openai")).toHaveLength(3);
    expect(new DashboardApi(reopened).getCurrentQuota("legacy").percentRemaining).toBe(60);
    reopened.close();
    reader.close();
  });

  it("aggregates real time-window fixtures and reports corrupt usage as unavailable", async () => {
    const { data, make } = await setup();
    const now = Date.now();
    const db = await openNativeDashboardDatabase(join(data, "opencode.db"));
    db.exec(
      "CREATE TABLE session (id TEXT, title TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER)",
    );
    db.exec(
      "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    for (const [i, age] of [0.5, 2, 10, 40].entries()) {
      const timestamp = now - age * 86_400_000;
      insert.run(
        `msg_${i}`,
        `ses_${i}`,
        timestamp,
        timestamp,
        JSON.stringify({
          role: "assistant",
          providerID: "fixture",
          modelID: "no-price",
          tokens: { input: 10, output: 2, cache: { read: 0, write: 0 } },
          time: { created: timestamp },
        }),
      );
    }
    db.close();
    const helper = make();
    const windows = await helper.request<any[]>({
      operation: "aggregate",
      windows: ["day", "week", "month", "all"],
      now,
      pricing,
    });
    expect(windows.map((w) => w.aggregate.totals.messageCount)).toEqual([1, 2, 3, 4]);
    expect(windows.every((w) => w.aggregate.window.untilMs === now)).toBe(true);
    const project = join(root, ".claude", "projects", "fixture");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "broken.jsonl"), "{incomplete");
    const unknown = await helper.request<any[]>({
      operation: "aggregate",
      windows: ["day"],
      now,
      pricing,
    });
    expect(unknown).toEqual([{ window: "day", error: "Usage unavailable" }]);
  });
});
