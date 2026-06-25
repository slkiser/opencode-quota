import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

vi.mock("../src/lib/google-agy.js", () => ({
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  queryGoogleAgyQuota: vi.fn(),
}));

describe("google agy provider", () => {
  it("preserves the Google AGY quota timeout default unless requestTimeoutMs is user-configured", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValue(null);

    await googleAgyProvider.fetch({ client: {}, config: { requestTimeoutMs: 5000 } } as any);
    expect(queryGoogleAgyQuota).toHaveBeenLastCalledWith({}, { requestTimeoutMs: undefined });

    await googleAgyProvider.fetch({
      client: {},
      config: { requestTimeoutMs: 12000, requestTimeoutMsConfigured: true },
    } as any);
    expect(queryGoogleAgyQuota).toHaveBeenLastCalledWith({}, { requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when Google AGY auth is not configured", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce(null);

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectNotAttempted(out);
  });

  it("maps summaryGroups into grouped toast entries with weekly-first ordering", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      summaryGroups: [
        {
          displayName: "Gemini Models",
          description: "Gemini model family",
          buckets: [
            { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 0.58, resetTime: "2026-06-22T00:00:00Z" },
            { bucketId: "gemini-5h", displayName: "5 Hour", window: "5h", remainingFraction: 0.25, remainingAmount: "1234" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          description: "Third-party model family",
          buckets: [
            { bucketId: "3p-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-06-22T00:00:00Z" },
            { bucketId: "3p-5h", displayName: "5 Hour", window: "5h", remainingFraction: 0.9, remainingAmount: "50" },
          ],
        },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        name: "Google AGY Gemini Models Weekly",
        group: "Google AGY \u00b7 Gemini Models",
        label: "Weekly:",
        rankOverride: 1,
        groupSortOverride: 1,
        percentRemaining: 58,
        resetTimeIso: "2026-06-22T00:00:00Z",
      },
      {
        name: "Google AGY Gemini Models 5h",
        group: "Google AGY \u00b7 Gemini Models",
        label: "5h:",
        rankOverride: 2,
        groupSortOverride: 1,
        right: "1,234 left",
        percentRemaining: 25,
      },
      {
        name: "Google AGY Claude and GPT models Weekly",
        group: "Google AGY \u00b7 Claude and GPT models",
        label: "Weekly:",
        rankOverride: 1,
        groupSortOverride: 2,
        percentRemaining: 100,
        resetTimeIso: "2026-06-22T00:00:00Z",
      },
      {
        name: "Google AGY Claude and GPT models 5h",
        group: "Google AGY \u00b7 Claude and GPT models",
        label: "5h:",
        rankOverride: 2,
        groupSortOverride: 2,
        right: "50 left",
        percentRemaining: 90,
      },
    ]);
    expect(out.errors).toEqual([{ label: "bob..example", message: "Unauthorized" }]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Google AGY",
      singleWindowShowRight: true,
    });
  });

  it("filters disabled buckets", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      summaryGroups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.5, disabled: true },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.8 },
          ],
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].rankOverride).toBe(2);
    expect(out.entries[0].label).toBe("5h:");
  });

  it("sorts Gemini groups before Claude/GPT groups", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      summaryGroups: [
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-5h", window: "5h", remainingFraction: 0.4 },
          ],
        },
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.6 },
          ],
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0].group).toContain("Gemini");
    expect(out.entries[0].groupSortOverride).toBe(1);
    expect(out.entries[1].group).toContain("Claude");
    expect(out.entries[1].groupSortOverride).toBe(2);
  });

  it("handles empty summaryGroups gracefully", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Quota summary API unavailable",
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithErrorLabel(out, "Google AGY");
  });

  it("maps fetch failures into toast errors", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithErrorLabel(out, "Google AGY");
  });

  it("is available only when the Google AGY runtime is configured", async () => {
    const { hasAgyQuotaRuntimeAvailable } = await import("../src/lib/google-agy.js");
    (hasAgyQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);
    await expect(googleAgyProvider.isAvailable({ client: {} } as any)).resolves.toBe(true);

    (hasAgyQuotaRuntimeAvailable as any).mockResolvedValueOnce(false);
    await expect(googleAgyProvider.isAvailable({ client: {} } as any)).resolves.toBe(false);
  });

  it("matches Google AGY current model ids", () => {
    expect(googleAgyProvider.matchesCurrentModel?.("google-agy/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("opencode-agy-auth/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("google-agy-auth/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("google/claude-opus")).toBe(false);
  });
});
