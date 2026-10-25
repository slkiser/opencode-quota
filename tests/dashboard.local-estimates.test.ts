import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openNativeDashboardDatabase } from "../src/dashboard/native-database.js";
import { DashboardApi } from "../src/dashboard/api.js";
import { syncLocalQuotaEstimate } from "../src/lib/quota-providers-local.js";
import {
  validateQuotaDefinitions,
  type LocalQuotaDefinition,
} from "../src/lib/quota-provider-definitions.js";
import type { OpenCodeMessage } from "../src/lib/opencode-storage.js";
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const now = Date.parse("2026-10-15T01:00:00Z");
const definition = () =>
  validateQuotaDefinitions([
    {
      id: "custom-local",
      providerId: "fixture",
      label: "Local",
      mode: "local-estimate",
      sources: ["opencode"],
      windows: [
        { id: "day", label: "Day", type: "utc-day", requestLimit: 2, usdBudget: 10 },
        {
          id: "rolling",
          label: "Rolling",
          type: "rolling",
          durationMinutes: 300,
          requestLimit: 2,
          usdBudget: 10,
        },
      ],
    },
  ])[0] as LocalQuotaDefinition;
const message = (id: string, at = now - 1800000): OpenCodeMessage => ({
  id,
  sessionID: "ses_fixture",
  role: "assistant",
  providerID: "fixture",
  modelID: "fixture-model",
  time: { created: at - 1000, completed: at },
  tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } },
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), "local-journal-"));
  const file = join(root, "history.db"),
    db = await openNativeDashboardDatabase(file);
  new DashboardApi(db);
  return { db, file };
}
const requests = (out: any, id = "day") =>
  out.accounting.rows.find((row: any) => row.id === `${id}-requests`);
const budget = (out: any, id = "day") =>
  out.accounting.rows.find((row: any) => row.id === `${id}-budget`);
describe("durable source-scoped custom estimates", () => {
  it("computes independent UTC and rolling windows and survives restart without recounting", async () => {
    let { db, file } = await setup();
    const def = definition();
    const readOpenCode = async () => [message("old", now - 2 * 3600000), message("new")];
    const first = await syncLocalQuotaEstimate(db, def, now, { readOpenCode, price: () => 1 });
    expect(requests(first).value.remaining).toBe(50);
    expect(requests(first, "rolling").value.remaining).toBe(0);
    expect(budget(first).value.remaining).toBe(90);
    expect(budget(first, "rolling").value.remaining).toBe(80);
    expect(requests(first).window).toMatchObject({
      kind: "fixed",
      fullReset: true,
      startedAtIso: "2026-10-15T00:00:00.000Z",
      endsAtIso: "2026-10-16T00:00:00.000Z",
    });
    expect(requests(first, "rolling").window).toMatchObject({
      kind: "rolling",
      durationMs: 18000000,
    });
    db.close();
    db = await openNativeDashboardDatabase(file);
    new DashboardApi(db);
    const repeat = await syncLocalQuotaEstimate(db, def, now, { readOpenCode, price: () => 1 });
    expect(requests(repeat, "rolling").value.remaining).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM custom_estimate_events").get()).toMatchObject({
      n: 2,
    });
    db.close();
  });
  it("preserves changed canonical copies and genuine identical multiplicity regardless of id order", async () => {
    const { db } = await setup(),
      def = definition();
    await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [message("original")],
      price: () => 1,
    });
    await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [message("zzz-canonical-copy")],
      price: () => 1,
    });
    const repeat = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [message("aaa-genuine-repeat"), message("zzz-canonical-copy")],
      price: () => 1,
    });
    expect(requests(repeat).value.basis.used.quantity.decimal).toBe("2");
    expect(db.prepare("SELECT count(*) AS n FROM custom_estimate_events").get()).toMatchObject({
      n: 2,
    });
    expect(JSON.stringify(db.prepare("SELECT * FROM custom_estimate_aliases").all())).not.toContain(
      "canonical-copy",
    );
    db.close();
  });
  it("updates one completed message without inflation and ignores unfinished/future records", async () => {
    const { db } = await setup(),
      def = definition();
    const original = message("stable");
    await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [original],
      price: () => 1,
    });
    const updated = {
      ...message("stable", now - 1000),
      tokens: { input: 200, output: 100, cache: { read: 0, write: 0 } },
    };
    const incomplete = { ...message("unfinished"), time: { created: now - 1000 } };
    const out = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [updated, incomplete, message("future", now + 1)],
      price: () => 2,
    });
    expect(requests(out).value.basis.used.quantity.decimal).toBe("1");
    expect(budget(out).value.remaining).toBe(80);
    db.close();
  });
  it("retains request counts for missing prices and re-evaluates costs without recounting", async () => {
    const { db } = await setup(),
      def = definition(),
      readOpenCode = async () => [message("price")];
    const unknown = await syncLocalQuotaEstimate(db, def, now, { readOpenCode, price: () => null });
    expect(requests(unknown).value.remaining).toBe(50);
    expect(budget(unknown).value).toMatchObject({ kind: "status", status: "unknown" });
    const priced = await syncLocalQuotaEstimate(db, def, now, { readOpenCode, price: () => 4 });
    expect(budget(priced).value.remaining).toBe(60);
    expect(requests(priced).value.basis.used.quantity.decimal).toBe("1");
    db.close();
  });
  it("keeps sources distinct and collapses repeated Claude provider completion ids while waiting for final usage", async () => {
    const { db } = await setup(),
      def = {
        ...definition(),
        sources: ["opencode", "claude-cli"] as LocalQuotaDefinition["sources"],
      };
    const record = message("same-id");
    const partial = { ...record, time: { created: now - 1000 }, usageComplete: false };
    const first = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [record],
      readClaude: async () => [partial, partial],
      price: () => 1,
    });
    expect(requests(first).value.basis.used.quantity.decimal).toBe("2");
    expect(budget(first).value).toMatchObject({ status: "unknown" });
    const final = { ...partial, usageComplete: true };
    const verified = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [record],
      readClaude: async () => [partial, final, final],
      price: () => 1,
    });
    expect(requests(verified).value.basis.used.quantity.decimal).toBe("2");
    expect(budget(verified).value.remaining).toBe(80);
    db.close();
  });
  it("includes Codex CLI activity in an OpenAI estimate and journals sources independently", async () => {
    const { db } = await setup();
    const def = {
      ...definition(),
      providerId: "openai",
      sources: ["opencode", "codex-cli"] as LocalQuotaDefinition["sources"],
    };
    const openCode = { ...message("same-response"), providerID: "openai" };
    const codex = { ...openCode, id: "codex:same-response", sessionID: "codex-session" };
    const out = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [openCode],
      readCodex: async () => [codex],
      price: () => 1,
    });

    expect(requests(out).value.basis.used.quantity.decimal).toBe("2");
    expect(budget(out).value.remaining).toBe(80);
    expect(
      db
        .prepare(
          "SELECT source, count(*) AS n FROM custom_estimate_events GROUP BY source ORDER BY source",
        )
        .all(),
    ).toEqual([
      { source: "codex-cli", n: 1 },
      { source: "opencode", n: 1 },
    ]);
    db.close();
  });
  it("retains records but makes current estimates unknown when a selected source fails", async () => {
    const { db } = await setup(),
      def = definition();
    await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [message("recorded")],
      price: () => 1,
    });
    const out = await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => {
        throw new Error("private source path");
      },
      price: () => 1,
    });
    expect(requests(out).value.remaining).toBeNull();
    expect(out.accounting?.rows.find((row) => row.id === "day-recorded")?.value).toMatchObject({
      quantity: { decimal: "1" },
    });
    expect(JSON.stringify(out)).not.toContain("private source path");
    db.close();
  });
  it("rolls back events and aliases together and fails closed on corrupt journal metadata", async () => {
    const { db } = await setup(),
      def = definition();
    db.exec(
      "CREATE TRIGGER fail_alias BEFORE INSERT ON custom_estimate_aliases BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;",
    );
    await expect(
      syncLocalQuotaEstimate(db, def, now, { readOpenCode: async () => [message("rollback")] }),
    ).rejects.toThrow("fixture rollback");
    expect(db.prepare("SELECT count(*) AS n FROM custom_estimate_events").get()).toMatchObject({
      n: 0,
    });
    db.exec("DROP TRIGGER fail_alias");
    await syncLocalQuotaEstimate(db, def, now, {
      readOpenCode: async () => [message("valid")],
      price: () => 1,
    });
    db.exec("UPDATE custom_estimate_events SET completed_at='corrupt'");
    await expect(
      syncLocalQuotaEstimate(db, def, now, { readOpenCode: async () => [] }),
    ).rejects.toThrow("Local journal unavailable");
    db.close();
  });
  it("validates local limits, source selection and bounded pricing fallback maps", () => {
    const def = definition();
    for (const value of [
      { ...def, windows: [{ ...def.windows[0], requestLimit: 0 }] },
      { ...def, sources: ["opencode", "opencode"] },
      { ...def, sources: ["opencode", "claude-cli", "codex-cli", "invalid"] },
      { ...def, windows: [{ ...def.windows[1], durationMinutes: Infinity }] },
      { ...def, windows: [{ ...def.windows[0], usdBudget: 1e-20 }] },
      { ...def, pricingModelMap: { model: "execute-this" } },
      { ...def, url: "https://example.test" },
    ])
      expect(() => validateQuotaDefinitions([value])).toThrow();
  });
});
