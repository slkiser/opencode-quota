import { describe, expect, it } from "vite-plus/test";
import type { FixedWindowProjectionEvidence } from "../src/lib/entries.js";
import {
  compareQuotaRunwayUrgency,
  formatQuotaRunway,
  isFixedWindowProjectionEvidence,
  projectQuotaRunway,
} from "../src/lib/quota-exhaustion-projection.js";

const START = Date.parse("2026-09-09T00:00:00.000Z");
const OBSERVED = Date.parse("2026-09-09T01:30:00.000Z");
const RESET = Date.parse("2026-09-09T05:00:00.000Z");

function evidence(
  overrides: Partial<FixedWindowProjectionEvidence> = {},
): FixedWindowProjectionEvidence {
  return {
    kind: "fixed_window",
    startedAtIso: new Date(START).toISOString(),
    observedAtIso: new Date(OBSERVED).toISOString(),
    endsAtIso: new Date(RESET).toISOString(),
    fullReset: true,
    ...overrides,
  };
}

describe("fixed-window quota runway projection", () => {
  it("uses average usage since the fixed window began and formats exact typography", () => {
    const projection = projectQuotaRunway({
      percentRemaining: 55,
      fixedWindow: evidence(),
      resetTimeIso: new Date(RESET).toISOString(),
      nowMs: OBSERVED,
    });

    expect(projection).toEqual({
      kind: "before_reset",
      projectedAtIso: "2026-09-09T03:20:00.000Z",
    });
    expect(formatQuotaRunway(projection ?? undefined, OBSERVED)).toBe("≈ 1h 50m");
  });

  it("rounds a partial minute up and emits only useful spaced duration units", () => {
    expect(
      formatQuotaRunway(
        { kind: "before_reset", projectedAtIso: new Date(OBSERVED + 60_001).toISOString() },
        OBSERVED,
      ),
    ).toBe("≈ 2m");
    expect(
      formatQuotaRunway(
        { kind: "before_reset", projectedAtIso: new Date(OBSERVED + 60 * 60_000).toISOString() },
        OBSERVED,
      ),
    ).toBe("≈ 1h");
    expect(
      formatQuotaRunway(
        {
          kind: "before_reset",
          projectedAtIso: new Date(OBSERVED + (24 * 60 + 2) * 60_000).toISOString(),
        },
        OBSERVED,
      ),
    ).toBe("≈ 1d 2m");
  });

  it("reports zero usage and projections at or after reset as lasting past reset", () => {
    expect(
      projectQuotaRunway({
        percentRemaining: 100,
        fixedWindow: evidence(),
        resetTimeIso: new Date(RESET).toISOString(),
        nowMs: OBSERVED,
      }),
    ).toEqual({ kind: "lasts_past_reset" });

    expect(
      projectQuotaRunway({
        percentRemaining: 80,
        fixedWindow: evidence(),
        resetTimeIso: new Date(RESET).toISOString(),
        nowMs: OBSERVED,
      }),
    ).toEqual({ kind: "lasts_past_reset" });
    expect(formatQuotaRunway({ kind: "lasts_past_reset" }, OBSERVED)).toBe("lasts past reset");
  });

  it("treats exhausted and over-quota rows as already exhausted", () => {
    for (const percentRemaining of [0, -10]) {
      const projection = projectQuotaRunway({
        percentRemaining,
        fixedWindow: evidence(),
        resetTimeIso: new Date(RESET).toISOString(),
        nowMs: OBSERVED,
      });
      expect(projection?.kind).toBe("before_reset");
      expect(formatQuotaRunway(projection ?? undefined, OBSERVED)).toBe("≈ 0m");
    }
  });

  it("omits non-finite, over-100, missing, malformed, zero-elapsed, and stale inputs", () => {
    const resetTimeIso = new Date(RESET).toISOString();
    expect(
      projectQuotaRunway({
        percentRemaining: Number.NaN,
        fixedWindow: evidence(),
        resetTimeIso,
        nowMs: OBSERVED,
      }),
    ).toBeNull();
    expect(
      projectQuotaRunway({
        percentRemaining: 101,
        fixedWindow: evidence(),
        resetTimeIso,
        nowMs: OBSERVED,
      }),
    ).toBeNull();
    expect(projectQuotaRunway({ percentRemaining: 50, resetTimeIso, nowMs: OBSERVED })).toBeNull();
    expect(
      projectQuotaRunway({
        percentRemaining: 50,
        fixedWindow: evidence({ startedAtIso: "bad" }),
        resetTimeIso,
        nowMs: OBSERVED,
      }),
    ).toBeNull();
    expect(
      projectQuotaRunway({
        percentRemaining: 50,
        fixedWindow: evidence({ startedAtIso: new Date(OBSERVED).toISOString() }),
        resetTimeIso,
        nowMs: OBSERVED,
      }),
    ).toBeNull();
    expect(
      projectQuotaRunway({
        percentRemaining: 50,
        fixedWindow: evidence(),
        resetTimeIso,
        nowMs: RESET,
      }),
    ).toBeNull();
  });

  it("requires exact keys, a full reset, chronological timestamps, and reset agreement", () => {
    const resetTimeIso = new Date(RESET).toISOString();
    expect(isFixedWindowProjectionEvidence(evidence(), resetTimeIso)).toBe(true);
    expect(isFixedWindowProjectionEvidence({ ...evidence(), extra: true }, resetTimeIso)).toBe(
      false,
    );
    expect(isFixedWindowProjectionEvidence({ ...evidence(), fullReset: false }, resetTimeIso)).toBe(
      false,
    );
    expect(
      isFixedWindowProjectionEvidence(
        evidence({ observedAtIso: new Date(START).toISOString() }),
        resetTimeIso,
      ),
    ).toBe(false);
    expect(isFixedWindowProjectionEvidence(evidence(), "2026-09-09T06:00:00.000Z")).toBe(false);
  });

  it("orders exhausted, before-reset, shortest runway, past-reset, then unsupported", () => {
    const exhausted = {
      kind: "before_reset",
      projectedAtIso: new Date(OBSERVED - 1).toISOString(),
    } as const;
    const soon = {
      kind: "before_reset",
      projectedAtIso: new Date(OBSERVED + 60_000).toISOString(),
    } as const;
    const later = {
      kind: "before_reset",
      projectedAtIso: new Date(OBSERVED + 120_000).toISOString(),
    } as const;
    const pastReset = { kind: "lasts_past_reset" } as const;
    const values = [undefined, later, pastReset, soon, exhausted];
    values.sort((left, right) => compareQuotaRunwayUrgency(left, right, OBSERVED));
    expect(values).toEqual([exhausted, soon, later, pastReset, undefined]);
  });
});
