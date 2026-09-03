import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DISPLAYED_PERCENT_LABEL_WIDTH,
  displayedPercentLabelWidth,
  formatDisplayedPercentLabel,
  formatResetCountdown,
} from "../src/lib/format-utils.js";

describe("formatResetCountdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the compact compound form by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-17T15:14:00.000Z")).toBe("2d5h14m");
  });

  it("joins compound units with spaces when spaced is set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-17T15:14:00.000Z", { spaced: true })).toBe("2d 5h 14m");
  });

  it("spaces hours and minutes below one day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T13:45:00.000Z", { spaced: true })).toBe("3h 45m");
  });

  it("keeps minute-only values as a single token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T10:14:00.000Z", { spaced: true })).toBe("14m");
  });

  it("rounds partial minutes up in spaced mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T12:14:01.000Z", { spaced: true })).toBe("2h 15m");
  });

  it("keeps single-unit compactRounded output unchanged when spaced is set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(
      formatResetCountdown("2026-01-17T15:14:00.000Z", {
        compactRounded: true,
        decimals: 1,
        spaced: true,
      }),
    ).toBe("2.2d");
  });

  it("returns the reset marker for past timestamps in spaced mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T09:00:00.000Z", { spaced: true })).toBe("reset");
  });
});

describe("formatDisplayedPercentLabel", () => {
  it("keeps the word suffix by default", () => {
    expect(formatDisplayedPercentLabel(81, "remaining")).toBe("81% left");
    expect(formatDisplayedPercentLabel(81, "used")).toBe("19% used");
  });

  it("omits the word suffix in bare mode", () => {
    expect(formatDisplayedPercentLabel(81, "remaining", "bare")).toBe("81%");
    expect(formatDisplayedPercentLabel(81, "used", "bare")).toBe("19%");
  });
});

describe("displayedPercentLabelWidth", () => {
  it("matches the full label width by default", () => {
    expect(displayedPercentLabelWidth()).toBe(DISPLAYED_PERCENT_LABEL_WIDTH);
    expect(displayedPercentLabelWidth("full")).toBe(DISPLAYED_PERCENT_LABEL_WIDTH);
  });

  it("shrinks to the bare percent width in bare mode", () => {
    expect(displayedPercentLabelWidth("bare")).toBe("100%".length);
  });
});
