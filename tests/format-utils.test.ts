import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DISPLAYED_PERCENT_LABEL_WIDTH,
  displayedPercentLabelWidth,
  formatDisplayedPercentLabel,
  formatQuotaModeHeading,
  formatResetCountdown,
} from "../src/lib/format-utils.js";

describe("formatResetCountdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the configured missing value without fabricating a countdown", () => {
    expect(formatResetCountdown()).toBe("");
    expect(formatResetCountdown(undefined, { missing: "-" })).toBe("-");
  });

  it("returns one reset marker for expired timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T10:00:00.000Z")).toBe("reset");
    expect(formatResetCountdown("2026-01-15T09:59:59.999Z", { spaced: true })).toBe("reset");
  });

  it("keeps exact countdowns compact by default and spaces compound units on request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    const multiDay = "2026-01-17T15:14:00.000Z";
    const sameDay = "2026-01-15T13:45:00.000Z";
    expect(formatResetCountdown(multiDay)).toBe("2d5h14m");
    expect(formatResetCountdown(multiDay, { spaced: true })).toBe("2d 5h 14m");
    expect(formatResetCountdown(sameDay, { spaced: true })).toBe("3h 45m");
  });

  it("leaves minute-only and partial-minute behavior unchanged in spaced mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-15T10:14:00.000Z", { spaced: true })).toBe("14m");
    expect(formatResetCountdown("2026-01-15T12:14:01.000Z", { spaced: true })).toBe("2h 15m");
  });

  it("keeps resetTimeDecimals output unchanged when spacing is enabled", () => {
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
});

describe("percent labels", () => {
  it("keeps full labels by default and supports bare remaining and used labels", () => {
    expect(formatDisplayedPercentLabel(81, "remaining")).toBe("81% left");
    expect(formatDisplayedPercentLabel(81, "used")).toBe("19% used");
    expect(formatDisplayedPercentLabel(81, "remaining", "bare")).toBe("81%");
    expect(formatDisplayedPercentLabel(81, "used", "bare")).toBe("19%");
  });

  it("reserves only the bare percentage width when requested", () => {
    expect(displayedPercentLabelWidth()).toBe(DISPLAYED_PERCENT_LABEL_WIDTH);
    expect(displayedPercentLabelWidth("full")).toBe(DISPLAYED_PERCENT_LABEL_WIDTH);
    expect(displayedPercentLabelWidth("bare")).toBe("100%".length);
  });

  it("names the report-level percentage mode", () => {
    expect(formatQuotaModeHeading("remaining")).toBe("Quota [Remaining]");
    expect(formatQuotaModeHeading("used")).toBe("Quota [Used]");
  });

  it("separates exact countdown units when spacing is requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-21T05:49:00.000Z", { spaced: true })).toBe("5d 19h 49m");
    expect(formatResetCountdown("2026-01-15T12:14:00.000Z", { spaced: true })).toBe("2h 14m");
  });
});
