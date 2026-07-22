import { describe, expect, it, vi } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

const mocks = vi.hoisted(() => ({
  queryGoogleAgyQuota: vi.fn(),
}));

vi.mock("../src/lib/google-agy.js", () => ({
  hasAgyQuotaRuntimeAvailable: vi.fn(async () => true),
  queryGoogleAgyQuota: mocks.queryGoogleAgyQuota,
}));

describe("Google AGY provider surfaces", () => {
  it("keeps account, family, and weekly-first identity on every surface", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          family: "Gemini Models",
          window: "five_hour",
          windowLabel: "5h",
          percentRemaining: 25,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
          sourceKey: "google-agy",
        },
        {
          family: "Gemini Models",
          window: "weekly",
          windowLabel: "Weekly",
          percentRemaining: 58,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
          sourceKey: "google-agy",
        },
      ],
    });

    const result = await googleAgyProvider.fetch({ client: {} } as any);
    const entries = result.entries;
    const errors = result.errors;
    const weeklyHeader = "[Google AGY · ali..example · Gemini Models · Weekly]";
    const fiveHourHeader = "[Google AGY · ali..example · Gemini Models · 5h]";

    const toast = formatQuotaRowsGrouped({
      layout: { maxWidth: 120, narrowAt: 42, tinyAt: 32 },
      entries,
      errors,
    });
    const sidebar = formatQuotaRowsGrouped({
      layout: { maxWidth: 80, narrowAt: 42, tinyAt: 32 },
      entries,
      errors,
    });
    const command = formatQuotaCommand({ entries, errors });
    const compact = buildCompactQuotaStatusLine({
      data: { entries, errors },
      maxWidth: 240,
    });

    for (const output of [toast, sidebar, command]) {
      expect(output).toContain(weeklyHeader);
      expect(output).toContain(fiveHourHeader);
      expect(output.indexOf(weeklyHeader)).toBeLessThan(output.indexOf(fiveHourHeader));
    }
    expect(compact).toContain("Google AGY · ali..example · Gemini Models · Weekly 58%");
    expect(compact).toContain("Google AGY · ali..example · Gemini Models · 5h 25%");
    expect(compact.indexOf("Weekly 58%")).toBeLessThan(compact.indexOf("5h 25%"));
    expect(entries.every((entry) => entry.accounting.sourceId === "account-alice")).toBe(true);
  });
});
