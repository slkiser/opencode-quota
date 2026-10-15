import { describe, it, expect } from "vitest";
import { runwayRow, runwayNow } from "./helpers/runway-fixture.js";
import { projectQuotaRunway, formatQuotaRunway } from "../src/lib/quota-runway.js";
import { projectAccountingDetails } from "../src/lib/accounting-display.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
describe("fixed-window average runway", () => {
  it("computes the independent four-hour/75-percent example as 80 minutes", () => {
    const projection = projectQuotaRunway(runwayRow(), runwayNow)!;
    expect(projection).toEqual({
      kind: "before_reset",
      projectedAt: runwayNow + 80 * 60000,
      resetAt: Date.parse("2026-10-15T16:00:00Z"),
    });
    expect(formatQuotaRunway(projection, runwayNow)).toBe("≈ 1h 20m");
    expect(formatQuotaRunway(projection, runwayNow + 10 * 60000)).toBe("≈ 1h 10m");
  });
  it("distinguishes enough runway from exhausted quota and rejects zero usage", () => {
    const row = runwayRow();
    row.value = { kind: "percent", remaining: 75 };
    expect(formatQuotaRunway(projectQuotaRunway(row, runwayNow)!, runwayNow)).toBe(
      "≈ lasts past reset",
    );
    row.value.remaining = 0;
    expect(formatQuotaRunway(projectQuotaRunway(row, runwayNow)!, runwayNow)).toBe("≈ 0m");
    row.value.remaining = -25;
    expect(formatQuotaRunway(projectQuotaRunway(row, runwayNow)!, runwayNow)).toBe("≈ 0m");
    row.value.remaining = 100;
    expect(projectQuotaRunway(row, runwayNow)).toBeNull();
  });
  it.each([
    "unknown",
    "identified",
    "rolling",
    "partial-reset",
    "unknown-usage",
    "unknown-time",
    "future-time",
    "old-time",
    "unknown-source",
    "balance",
    "zero-length",
    "future-start",
    "infinite-percent",
  ])("suppresses unsupported %s evidence even with a Weekly label", (kind) => {
    const row = runwayRow();
    if (kind === "unknown") row.window = { kind: "unknown" };
    if (kind === "identified")
      row.window = { kind: "identified", id: "weekly", resetTimeIso: "2026-10-15T16:00:00Z" };
    if (kind === "rolling") row.window = { kind: "rolling", id: "weekly", durationMs: 8 * 3600000 };
    if (kind === "partial-reset" && row.window.kind === "fixed") row.window.fullReset = false;
    if (kind === "unknown-usage") row.value = { kind: "percent", remaining: null };
    if (kind === "unknown-time") row.freshness = { kind: "unknown" };
    if (kind === "future-time")
      row.freshness = { kind: "observed", observedAtIso: new Date(runwayNow + 1).toISOString() };
    if (kind === "old-time")
      row.freshness = {
        kind: "observed",
        observedAtIso: new Date(runwayNow - 15 * 60000 - 1).toISOString(),
      };
    if (kind === "unknown-source") row.source.authority = "unknown";
    if (kind === "balance") row.resultType = "balance";
    if (kind === "zero-length" && row.window.kind === "fixed")
      row.window.endsAtIso = row.window.startedAtIso;
    if (kind === "future-start" && row.window.kind === "fixed")
      row.window.startedAtIso = "2026-10-15T13:00:00Z";
    if (kind === "infinite-percent") row.value = { kind: "percent", remaining: Infinity };
    expect(projectQuotaRunway(row, runwayNow)).toBeNull();
  });
  it("leaves exports untouched and shares identical estimate text across percent display modes", () => {
    const result = {
      attempted: true,
      errors: [],
      entries: [{ name: "Fixture Weekly", percentRemaining: 25 }],
      accounting: { version: 1 as const, rows: [runwayRow()] },
    };
    const saved = structuredClone(result);
    expect(projectAccountingDetails("fixture", result)[0].runway).toBeUndefined();
    const details = projectAccountingDetails("fixture", result, {
      quotaProjection: "runway",
      now: runwayNow,
    });
    expect(details[0].runway).toBe("≈ 1h 20m");
    for (const mode of ["remaining", "used"] as const) {
      const data = { entries: result.entries, errors: [], accountingDetails: details };
      expect(formatQuotaRows({ version: "fixture", ...data, percentDisplayMode: mode })).toContain(
        "≈ 1h 20m",
      );
      expect(
        buildSidebarQuotaPanelLines({
          data,
          config: { ...DEFAULT_CONFIG, percentDisplayMode: mode },
        }).join("\n"),
      ).toContain("≈ 1h 20m");
      expect(formatQuotaCommand({ ...data, percentDisplayMode: mode })).toContain("≈ 1h 20m");
    }
    expect(result).toEqual(saved);
    expect(projectQuotaRunway(runwayRow(), Date.parse("2026-10-15T16:00:00Z"))).toBeNull();
  });
});
