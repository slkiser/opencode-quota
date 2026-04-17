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
  formatNanoGptBalanceValue: vi.fn((balance: { usdBalance?: number; nanoBalanceRaw?: string }) => {
    if (typeof balance.usdBalance === "number") {
      return `$${balance.usdBalance.toFixed(2)}`;
    }
    return balance.nanoBalanceRaw ? `${balance.nanoBalanceRaw} NANO` : null;
  }),
}));

describe("nanogpt provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce(null);

    const out = await nanoGptProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps grouped rows for daily, monthly, and balance", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        daily: {
          used: 5,
          limit: 5000,
          remaining: 4995,
          percentRemaining: 100,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        monthly: {
          used: 50,
          limit: 60000,
          remaining: 59950,
          percentRemaining: 100,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
      },
      balance: {
        usdBalance: 12.34,
      },
    });

    const out = await nanoGptProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Daily",
        group: "NanoGPT",
        label: "Daily:",
        right: "5/5000",
        percentRemaining: 100,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Monthly",
        group: "NanoGPT",
        label: "Monthly:",
        right: "50/60000",
        percentRemaining: 100,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      {
        kind: "value",
        name: "NanoGPT Balance",
        group: "NanoGPT",
        label: "Balance:",
        value: "$12.34",
      },
    ]);
  });

  it("maps classic rows for daily, monthly, and balance", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: true,
        daily: {
          used: 2.5,
          limit: 10,
          remaining: 7.5,
          percentRemaining: 75,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
        monthly: {
          used: 25,
          limit: 100,
          remaining: 75,
          percentRemaining: 75,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
        },
      },
      balance: {
        nanoBalanceRaw: "3.20",
      },
    });

    const out = await nanoGptProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Daily",
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "NanoGPT Monthly",
        percentRemaining: 75,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      {
        kind: "value",
        name: "NanoGPT Balance",
        value: "3.20 NANO",
      },
    ]);
  });

  it("maps partial endpoint errors and non-active subscription state", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: false,
        state: "grace",
        enforceDailyLimit: true,
        daily: {
          used: 100,
          limit: 100,
          remaining: 0,
          percentRemaining: 0,
          resetTimeIso: "2026-01-02T00:00:00.000Z",
        },
      },
      endpointErrors: [
        {
          endpoint: "balance",
          message: "NanoGPT API error 401: Unauthorized",
        },
      ],
    });

    const out = await nanoGptProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Daily",
        group: "NanoGPT",
        label: "Daily:",
        right: "100/100",
        percentRemaining: 0,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.errors).toEqual([
      {
        label: "NanoGPT Balance",
        message: "NanoGPT API error 401: Unauthorized",
      },
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
      error: "Usage: Unauthorized; Balance: Unauthorized",
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
