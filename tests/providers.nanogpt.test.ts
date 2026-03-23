import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { nanoGptProvider } from "../src/providers/nanogpt.js";

vi.mock("../src/lib/nanogpt.js", () => ({
  queryNanoGptQuota: vi.fn(),
  hasNanoGptApiKeyConfigured: vi.fn(),
}));

describe("nanogpt provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce(null);

    const out = await nanoGptProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps grouped rows for weekly tokens, daily images, and daily tokens", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 5,
          limit: 60_000_000,
          remaining: 59_999_995,
          percentRemaining: 100,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        dailyImages: {
          used: 1,
          limit: 100,
          remaining: 99,
          percentRemaining: 99,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        dailyInputTokens: {
          used: 25_000,
          limit: 250_000,
          remaining: 225_000,
          percentRemaining: 90,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: { toastStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Weekly Tokens",
        group: "NanoGPT",
        label: "Weekly:",
        right: "5/60000000",
        percentRemaining: 100,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Daily Images",
        group: "NanoGPT",
        label: "Images:",
        right: "1/100",
        percentRemaining: 99,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Daily Tokens",
        group: "NanoGPT",
        label: "Daily Tokens:",
        right: "25000/250000",
        percentRemaining: 90,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps classic rows in fixed primary order", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 59_650_170,
          limit: 60_000_000,
          remaining: 349_830,
          percentRemaining: 1,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        dailyImages: {
          used: 75,
          limit: 100,
          remaining: 25,
          percentRemaining: 25,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        dailyInputTokens: {
          used: 2.5,
          limit: 10,
          remaining: 7.5,
          percentRemaining: 75,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: { toastStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Weekly Tokens",
        percentRemaining: 1,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Daily Images",
        percentRemaining: 25,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Daily Tokens",
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("reports missing weekly usage without hiding secondary windows", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        dailyImages: {
          used: 100,
          limit: 100,
          remaining: 0,
          percentRemaining: 0,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: { toastStyle: "grouped" } } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Daily Images",
        group: "NanoGPT",
        label: "Images:",
        right: "100/100",
        percentRemaining: 0,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.errors).toEqual([
      {
        label: "NanoGPT",
        message: "Weekly input token usage unavailable from NanoGPT subscription API",
      },
    ]);
  });

  it("reports non-active subscription state as a soft error", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: false,
        state: "grace",
        enforceDailyLimit: true,
        weeklyInputTokens: {
          used: 100,
          limit: 60_000_000,
          remaining: 59_999_900,
          percentRemaining: 100,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: { toastStyle: "grouped" } } as any);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Weekly Tokens",
        group: "NanoGPT",
        label: "Weekly:",
        right: "100/60000000",
        percentRemaining: 100,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.errors).toEqual([
      {
        label: "NanoGPT",
        message: "Subscription state: grace",
      },
    ]);
  });

  it("maps hard failures into toast errors", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: false,
      error: "NanoGPT API error 401: Unauthorized",
    });

    const out = await nanoGptProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "NanoGPT");
  });

  it("reports missing usable data as an error", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
      },
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "NanoGPT");
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "NanoGPT",
        message: "No usable NanoGPT subscription usage data",
      },
    ]);
  });

  it("matches NanoGPT model ids", () => {
    expect(nanoGptProvider.matchesCurrentModel?.("nanogpt/gpt-oss-120b")).toBe(true);
    expect(nanoGptProvider.matchesCurrentModel?.("nano-gpt/gpt-5")).toBe(true);
    expect(nanoGptProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when a trusted API key is configured", async () => {
    const { hasNanoGptApiKeyConfigured } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKeyConfigured as any).mockResolvedValue(true);

    const withProvider = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "nanogpt" }] } }),
          get: vi.fn(),
        },
      },
    } as any;

    const fallback = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "openai" }] } }),
          get: vi.fn(),
        },
      },
    } as any;

    await expect(nanoGptProvider.isAvailable(withProvider)).resolves.toBe(true);
    await expect(nanoGptProvider.isAvailable(fallback)).resolves.toBe(true);
  });

  it("is not available when the provider id exists but no trusted API key is configured", async () => {
    const { hasNanoGptApiKeyConfigured } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKeyConfigured as any).mockResolvedValue(false);

    const withProvider = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "nanogpt" }] } }),
          get: vi.fn(),
        },
      },
    } as any;

    await expect(nanoGptProvider.isAvailable(withProvider)).resolves.toBe(false);
  });

  it("is not available when provider ids are absent and no API key exists", async () => {
    const { hasNanoGptApiKeyConfigured } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKeyConfigured as any).mockResolvedValue(false);

    const ctx = {
      client: {
        config: {
          providers: vi.fn().mockRejectedValue(new Error("boom")),
          get: vi.fn(),
        },
      },
    } as any;

    await expect(nanoGptProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
