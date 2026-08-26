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
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "missing",
    sourceKey: null,
    accountCount: 0,
    validAccountCount: 0,
  })),
}));

vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

function bucket(params: {
  family: "Gemini Models" | "Claude and GPT models";
  window: "weekly" | "five_hour";
  percentRemaining: number;
  accountEmail: string;
  accountKey: string;
  accountIndex: number;
}) {
  return {
    ...params,
    windowLabel: params.window === "weekly" ? "Weekly" : "5h",
    sourceKey: "google-agy",
  };
}

describe("Google AGY provider surfaces", () => {
  it("keeps two accounts, both families, and both windows distinct on every surface", async () => {
    mocks.queryGoogleAgyQuota.mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          family: "Gemini Models",
          window: "five_hour",
          percentRemaining: 100,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
        }),
        bucket({
          family: "Gemini Models",
          window: "weekly",
          percentRemaining: 99,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
        }),
        bucket({
          family: "Claude and GPT models",
          window: "five_hour",
          percentRemaining: 100,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
        }),
        bucket({
          family: "Claude and GPT models",
          window: "weekly",
          percentRemaining: 82,
          accountEmail: "alice@example.com",
          accountKey: "account-alice",
          accountIndex: 0,
        }),
        bucket({
          family: "Gemini Models",
          window: "five_hour",
          percentRemaining: 90,
          accountEmail: "bob@example.com",
          accountKey: "account-bob",
          accountIndex: 1,
        }),
        bucket({
          family: "Gemini Models",
          window: "weekly",
          percentRemaining: 75,
          accountEmail: "bob@example.com",
          accountKey: "account-bob",
          accountIndex: 1,
        }),
        bucket({
          family: "Claude and GPT models",
          window: "five_hour",
          percentRemaining: 80,
          accountEmail: "bob@example.com",
          accountKey: "account-bob",
          accountIndex: 1,
        }),
        bucket({
          family: "Claude and GPT models",
          window: "weekly",
          percentRemaining: 60,
          accountEmail: "bob@example.com",
          accountKey: "account-bob",
          accountIndex: 1,
        }),
      ],
      errors: [],
    });

    const result = await googleAgyProvider.fetch({ client: {} } as any);
    const { entries, errors } = result;
    const headers = [
      "[AGY (ali…): Gemini]",
      "[AGY (ali…): Claude/GPT]",
      "[AGY (bob…): Gemini]",
      "[AGY (bob…): Claude/GPT]",
    ];

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
      maxWidth: 400,
    });

    for (const output of [toast, sidebar]) {
      for (const header of headers) expect(output).toContain(header);
      expect(output).toContain("Weekly");
      expect(output).toContain("5h");
      expect(output.indexOf("Weekly")).toBeLessThan(output.indexOf("5h"));
    }
    for (const header of headers) expect(command).toContain(header);
    expect(command.indexOf("Week quota")).toBeLessThan(command.indexOf("5h quota"));
    expect(compact).toBe(
      "AGY (ali…): Gemini 7d 99%, 5h 100% | " +
        "AGY (ali…): Claude/GPT 7d 82%, 5h 100% | " +
        "AGY (bob…): Gemini 7d 75%, 5h 90% | " +
        "AGY (bob…): Claude/GPT 7d 60%, 5h 80%",
    );
    expect(entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "account-alice",
      "account-alice",
      "account-alice",
      "account-alice",
      "account-bob",
      "account-bob",
      "account-bob",
      "account-bob",
    ]);
  });
});
