import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { HistoryHelperClient } from "../src/gui/history-client.js";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { SqlJsDatabaseAdapter } from "../src/dashboard/sqljs-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import type { ProviderResultForSnapshot } from "../src/dashboard/quota-snapshot-bridge.js";

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
const pricing = { source: "bundled" as const, autoRefresh: 0 };

describe("installed helper protocol with real SQLite processes", () => {
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
    a.dispose();
    b.dispose();
    await make().request({ operation: "record", providerResults: [shared], now, pricing });
    const reopened = await SqlJsDatabaseAdapter.open(file);
    expect(new DashboardApi(reopened).getQuotaHistory("openai")).toHaveLength(3);
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
