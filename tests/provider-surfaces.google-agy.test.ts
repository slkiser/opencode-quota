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
        {
          family: "Claude and GPT models",
          window: "five_hour",
          windowLabel: "5h",
          percentRemaining: 40,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
          sourceKey: "google-agy",
        },
        {
          family: "Claude and GPT models",
          window: "weekly",
          windowLabel: "Weekly",
          percentRemaining: 75,
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
    const geminiHeader = "[AGY · ali..example · Gemini]";
    const thirdPartyHeader = "[AGY · ali..example · Claude/GPT]";

    const toast = formatQuotaRowsGrouped({
      layout: { maxWidth: 50, narrowAt: 42, tinyAt: 32 },
      entries,
      errors,
    });
    const sidebar = formatQuotaRowsGrouped({
      layout: { maxWidth: 36, narrowAt: 36, tinyAt: 20 },
      entries,
      errors,
    });
    const command = formatQuotaCommand({ entries, errors });
    const compact = buildCompactQuotaStatusLine({
      data: { entries, errors },
      maxWidth: 240,
    });

    for (const output of [toast, sidebar]) {
      expect(output).toContain(geminiHeader);
      expect(output).toContain(thirdPartyHeader);
      expect(output).toContain("Weekly window");
      expect(output).toContain("5h window");
      expect(output.indexOf("Weekly window")).toBeLessThan(output.indexOf("5h window"));
    }
    expect(command).toContain(geminiHeader);
    expect(command).toContain(thirdPartyHeader);
    expect(command.indexOf("Week quota")).toBeLessThan(command.indexOf("5h quota"));
    expect(compact).toContain("AGY · ali..example · Gemini 7d 58%, 5h 25%");
    expect(compact).toContain("AGY · ali..example · Claude/GPT 7d 75%, 5h 40%");
    expect(entries.every((entry) => entry.accounting.sourceId === "account-alice")).toBe(true);
  });
});
