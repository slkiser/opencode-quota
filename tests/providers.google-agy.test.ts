import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";

vi.mock("../src/lib/google-agy.js", () => ({
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  queryGoogleAgyQuota: vi.fn(),
}));

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    family: "Gemini Models",
    window: "weekly",
    windowLabel: "Weekly",
    bucketId: "gemini-weekly",
    percentRemaining: 58,
    accountEmail: "alice@example.com",
    accountKey: "aaaaaaaa11111111",
    accountIndex: 0,
    sourceKey: "google-agy",
    ...overrides,
  };
}

describe("google agy provider", () => {
  it("preserves the provider timeout default unless the timeout is user-configured", async () => {
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

  it("maps weekly and five-hour summary rows with fixed labels and accounting metadata", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          window: "five_hour",
          windowLabel: "5h",
          bucketId: "gemini-five-hour",
          percentRemaining: 25,
          remainingAmount: "1234.5",
        }),
        bucket(),
        bucket({
          family: "Claude and GPT models",
          window: "five_hour",
          windowLabel: "5h",
          bucketId: "third-party-five-hour",
          percentRemaining: 90,
          remainingAmount: "1e3",
        }),
        bucket({
          family: "Claude and GPT models",
          bucketId: "third-party-weekly",
          percentRemaining: 100,
          resetTimeIso: "2026-06-23T00:00:00.000Z",
        }),
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "google-agy")).toEqual([
      {
        name: "Gemini Models (ali..example)",
        group: "AGY · ali..example · Gemini",
        label: "Weekly:",
        sortPriority: 0,
        percentRemaining: 58,
        resetTimeIso: undefined,
      },
      {
        name: "Gemini Models (ali..example)",
        group: "AGY · ali..example · Gemini",
        label: "5h:",
        sortPriority: 1,
        right: "1,234.5 left",
        percentRemaining: 25,
        resetTimeIso: undefined,
      },
      {
        name: "Claude and GPT models (ali..example)",
        group: "AGY · ali..example · Claude/GPT",
        label: "Weekly:",
        sortPriority: 0,
        percentRemaining: 100,
        resetTimeIso: "2026-06-23T00:00:00.000Z",
      },
      {
        name: "Claude and GPT models (ali..example)",
        group: "AGY · ali..example · Claude/GPT",
        label: "5h:",
        sortPriority: 1,
        right: "1,000 left",
        percentRemaining: 90,
        resetTimeIso: undefined,
      },
    ]);
    expect(out.errors).toEqual([{ label: "bob..example", message: "Unauthorized" }]);
    expect(out.presentation).toEqual({
      singleWindowShowRight: true,
    });
    expect(out.entries.every((entry) => entry.accounting.sourceId === "aaaaaaaa11111111")).toBe(
      true,
    );
  });

  it("keeps account order and email-less accounts distinct", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          accountEmail: undefined,
          accountKey: "aaaaaaaa11111111",
          accountIndex: 0,
          percentRemaining: 20,
        }),
        bucket({
          accountEmail: undefined,
          accountKey: "bbbbbbbb22222222",
          accountIndex: 1,
          percentRemaining: 80,
        }),
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "Gemini Models (Account aaaaaaaa)",
      "Gemini Models (Account bbbbbbbb)",
    ]);
    expect(out.entries.map((entry) => entry.percentRemaining)).toEqual([20, 80]);
  });

  it("sorts account, family, and weekly-before-five-hour independently of input order", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        bucket({
          accountIndex: 1,
          accountEmail: "bob@example.com",
          window: "five_hour",
          windowLabel: "5h",
        }),
        bucket({
          family: "Claude and GPT models",
          accountIndex: 0,
          window: "five_hour",
          windowLabel: "5h",
        }),
        bucket({ accountIndex: 0 }),
        bucket({
          family: "Claude and GPT models",
          accountIndex: 0,
        }),
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "AGY · ali..example · Gemini",
      "AGY · ali..example · Claude/GPT",
      "AGY · ali..example · Claude/GPT",
      "AGY · bob..example · Gemini",
    ]);
  });

  it("preserves partial account errors when no summary rows succeed", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [],
      errors: [
        { email: "alice@example.com", error: "API timeout" },
        { email: "google-agy-auth", error: "Token revoked" },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      { label: "ali..example", message: "API timeout" },
      { label: "goo..", message: "Token revoked" },
    ]);
  });

  it("maps fetch failures into provider errors", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: false,
      error: "No Google AGY quota data available",
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

  it("matches the existing Google AGY runtime ids", () => {
    expect(googleAgyProvider.matchesCurrentModel?.("google-agy/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("opencode-agy-auth/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("google-agy-auth/gpt-4")).toBe(true);
    expect(googleAgyProvider.matchesCurrentModel?.("google/claude-opus")).toBe(false);
  });
});
