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

  it("maps quota buckets into grouped toast entries and truncated error labels", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-2-5-flash",
          displayName: "Gemini 2.5 Flash",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
          remainingAmount: "1234",
          tokenType: "REQUESTS",
        },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        name: "Gemini Models (ali..example)",
        group: "Google AGY",
        label: "Gemini Models:",
        right: "1,234 left",
        percentRemaining: 64,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(out.errors).toEqual([{ label: "bob..example", message: "Unauthorized" }]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Google AGY",
      singleWindowShowRight: true,
    });
  });

  it("maps aggregated Google AGY quality tiers without changing provider presentation", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-3-5-flash",
          displayName: "Gemini 3.5 Flash",
          accountEmail: "alice@example.com",
          percentRemaining: 20,
          resetTimeIso: "2026-01-01T12:00:00Z",
          remainingAmount: "50",
          tokenType: "TOKENS",
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Gemini Models (ali..example)",
        group: "Google AGY",
        label: "Gemini Models:",
        right: "50 left TOKENS",
        percentRemaining: 20,
        resetTimeIso: "2026-01-01T12:00:00Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Google AGY",
      singleWindowShowRight: true,
    });
  });

  it("keeps email-less AGY accounts separate using account keys", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-3-5-flash",
          displayName: "Gemini 3.5 Flash",
          accountKey: "aaaaaaaa11111111",
          percentRemaining: 20,
        },
        {
          modelId: "gemini-3-5-flash",
          displayName: "Gemini 3.5 Flash",
          accountKey: "bbbbbbbb22222222",
          percentRemaining: 80,
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "Gemini Models (Account aaaaaaaa)",
      "Gemini Models (Account bbbbbbbb)",
    ]);
  });

  it("groups and filters multiple models into canonical display buckets", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        { modelId: "gemini-2-5-flash", displayName: "Gemini 2.5 Flash", accountEmail: "test@a.com", percentRemaining: 12 },
        { modelId: "gemini-2-5-pro", displayName: "Gemini 2.5 Pro", accountEmail: "test@a.com", percentRemaining: 12 },
        { modelId: "gemini-3-flash", displayName: "Gemini 3 Flash", accountEmail: "test@a.com", percentRemaining: 12 },
        { modelId: "gemini-3-1-pro-high", displayName: "Gemini 3.1 Pro High", accountEmail: "test@a.com", percentRemaining: 12 },
        { modelId: "gemini-3-5-flash", displayName: "Gemini 3.5 Flash", accountEmail: "test@a.com", percentRemaining: 12 },
        { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", accountEmail: "test@a.com", percentRemaining: 0 },
        { modelId: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 Thinking", accountEmail: "test@a.com", percentRemaining: 0 },
        { modelId: "gpt-oss-120b", displayName: "GPT-OSS 120B (Medium)", accountEmail: "test@a.com", percentRemaining: 0 }, // Should be filtered out
        { modelId: "chat-20706", displayName: "Chat 20706", accountEmail: "test@a.com", percentRemaining: 100 }, // Should be filtered out
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    
    // Check that we only get the 2 consolidated groups, sorted alphabetically
    const entryLabels = out.entries.map(e => e.label);
    expect(entryLabels).toEqual([
      "Claude and GPT models:",
      "Gemini Models:",
    ]);
  });

  it("separates entries by quota window for the same model group", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "claude-opus-4-6-thinking",
          displayName: "Claude Opus 4.6 Thinking",
          accountEmail: "test@example.com",
          percentRemaining: 42,
          resetTimeIso: "2026-07-24T10:00:00Z",
          tokenType: "weekly",
          window: "weekly",
        },
        {
          modelId: "claude-opus-4-6-thinking",
          displayName: "Claude Opus 4.6 Thinking",
          accountEmail: "test@example.com",
          percentRemaining: 78,
          resetTimeIso: "2026-08-10T10:00:00Z",
          tokenType: "monthly",
          window: "monthly",
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      name: "Claude and GPT models (Weekly) (tes..example)",
      label: "Claude and GPT models: (Weekly)",
      percentRemaining: 42,
    });
    expect(out.entries[1]).toMatchObject({
      name: "Claude and GPT models (Monthly) (tes..example)",
      label: "Claude and GPT models: (Monthly)",
      percentRemaining: 78,
    });
  });

  it("groups buckets without window under 'unknown' without a window tag", async () => {
    const { queryGoogleAgyQuota } = await import("../src/lib/google-agy.js");
    (queryGoogleAgyQuota as any).mockResolvedValueOnce({
      success: true,
      buckets: [
        {
          modelId: "gemini-3-5-flash",
          displayName: "Gemini 3.5 Flash",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
          resetTimeIso: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const out = await googleAgyProvider.fetch({ client: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0].name).toBe("Gemini Models (ali..example)");
    expect(out.entries[0].label).toBe("Gemini Models:");
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
