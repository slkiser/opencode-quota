import { describe, expect, it } from "vite-plus/test";
import { paceOf } from "../src/core/pace.js";
import type { QuotaRow } from "../src/core/types.js";
import { quotaRow } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

/** A 5-hour row; by default half of its window has passed, so even use leaves 50%. */
const row = (fields: Partial<QuotaRow> = {}) =>
  quotaRow("anthropic.five_hour", {
    label: "5h",
    window: "five_hour",
    resetsAt: at(150),
    ...fields,
  });

describe("core/pace", () => {
  it.each([
    { name: "far above even use", left: 80, kind: "spare" },
    { name: "just above even use", left: 54, kind: "on_track" },
    { name: "just below even use", left: 46, kind: "on_track" },
    { name: "below even use", left: 30, kind: "fast", runsOutInMs: (30 / 70) * 150 * MINUTE },
    { name: "nothing left", left: 0, kind: "fast" },
    { name: "over quota", left: -5, kind: "fast" },
  ])("$name ($left% left at half time) is $kind", ({ left, kind, runsOutInMs }) => {
    expect(paceOf(row({ percentRemaining: left }), NOW)).toEqual({
      evenLeft: 50,
      kind,
      ...(runsOutInMs === undefined ? {} : { runsOutInMs }),
    });
  });

  it("gives no run-out time before a tenth of the window has passed", () => {
    // 20 of 300 minutes passed: even use leaves about 93%.
    const pace = paceOf(row({ percentRemaining: 50, resetsAt: at(280) }), NOW);
    expect(pace?.kind).toBe("fast");
    expect(pace?.runsOutInMs).toBeUndefined();
    expect(pace?.evenLeft).toBeCloseTo((280 / 300) * 100);
  });

  it("uses the row's own window start over the window's length", () => {
    const pace = paceOf(
      row({ percentRemaining: 50, window: "week", windowStartedAt: at(-60), resetsAt: at(60) }),
      NOW,
    );
    expect(pace).toEqual({ evenLeft: 50, kind: "on_track" });
  });

  it.each([
    { name: "a row without a percent", fields: { percentRemaining: undefined } },
    { name: "a row without a reset", fields: { resetsAt: undefined } },
    { name: "a row without a known window", fields: { window: undefined } },
    { name: "a window that already reset", fields: { resetsAt: at(-1) } },
    { name: "a window that has not started", fields: { windowStartedAt: at(10) } },
  ])("has no pace for $name", ({ fields }) => {
    expect(paceOf(row({ percentRemaining: 40, ...fields }), NOW)).toBeUndefined();
  });
});
