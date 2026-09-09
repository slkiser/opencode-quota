import { afterEach, describe, expect, it, vi } from "vitest";

import { formatResetCountdown } from "../src/lib/format-utils.js";

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
    expect(formatResetCountdown("2026-01-15T09:59:59.999Z")).toBe("reset");
  });

  it("separates exact countdown units by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(formatResetCountdown("2026-01-21T05:49:00.000Z")).toBe("5d 19h 49m");
    expect(formatResetCountdown("2026-01-15T12:14:00.000Z")).toBe("2h 14m");
  });
});
