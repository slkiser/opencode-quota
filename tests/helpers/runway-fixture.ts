import type { AccountingRow } from "../../src/lib/accounting.js";
export const runwayNow = Date.parse("2026-10-15T12:00:00Z");
export function runwayRow(): AccountingRow {
  return {
    id: "weekly",
    name: "Fixture Weekly",
    resultType: "quota",
    prominence: "primary",
    source: {
      id: "fixture",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    account: { kind: "unknown" },
    freshness: { kind: "observed", observedAtIso: new Date(runwayNow).toISOString() },
    window: {
      kind: "fixed",
      id: "weekly",
      startedAtIso: "2026-10-15T08:00:00Z",
      endsAtIso: "2026-10-15T16:00:00Z",
      fullReset: true,
    },
    value: { kind: "percent", remaining: 25 },
  };
}
