import { describe, expect, it, vi } from "vitest";
import { nanoGptProvider } from "../src/providers/nanogpt.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/nanogpt.js", () => ({
  queryNanoGptQuota: vi.fn(),
  hasNanoGptApiKeyConfigured: vi.fn(),
  getNanoGptKeyDiagnostics: vi.fn(async () => ({
    configured: false,
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
  })),
}));

describe("nanogpt provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce(null);

    const out = await nanoGptProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps canonical grouped-capable rows for daily, monthly, and balance", async () => {
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
          reportedBasis: { used: 5, limit: 5000, remaining: 4995 },
        },
        monthly: {
          used: 50,
          limit: 60000,
          remaining: 59950,
          percentRemaining: 100,
          resetTimeIso: "2026-02-01T00:00:00.000Z",
          reportedBasis: { used: 50, limit: 60000, remaining: 59950 },
        },
      },
      balance: {
        usdBalanceRaw: "12.3400",
        nanoBalanceRaw: "99.5",
      },
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      {
        name: "nanogpt-day-quota",
        group: "NanoGPT",
        percentRemaining: 100,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
        semantic: {
          metric: { kind: "window", window: "day" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "5", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "5000", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          remaining: {
            quantity: { decimal: "4995", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
        },
      },
      {
        name: "nanogpt-month-quota",
        group: "NanoGPT",
        percentRemaining: 100,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "50", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "60000", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          remaining: {
            quantity: { decimal: "59950", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
        },
      },
      {
        kind: "quantity",
        name: "nanogpt-current-balance",
        group: "NanoGPT",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "primary",
        },
        quantity: { decimal: "12.3400", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.presentation).toBeUndefined();
  });

  it("omits locally derived fallback values from provider-reported basis", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      subscription: {
        active: true,
        state: "active",
        enforceDailyLimit: false,
        daily: {
          used: 0,
          limit: 100,
          remaining: 75,
          percentRemaining: 75,
          reportedBasis: { limit: 100 },
        },
      },
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);

    expect(visibleEntries(out.entries, "nanogpt")[0]).toMatchObject({
      basis: {
        limit: {
          quantity: { decimal: "100", unit: { kind: "count", unit: "request" } },
          authority: "provider_reported",
        },
      },
    });
    expect(out.entries[0]).not.toHaveProperty("basis.used");
    expect(out.entries[0]).not.toHaveProperty("basis.remaining");
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
          reportedBasis: { used: 100, limit: 100, remaining: 0 },
        },
      },
      endpointErrors: [
        {
          endpoint: "balance",
          message: "NanoGPT API error 401: Unauthorized",
        },
      ],
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      {
        name: "nanogpt-day-quota",
        group: "NanoGPT",
        percentRemaining: 0,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
        semantic: {
          metric: { kind: "window", window: "day" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "100", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: "100", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
          remaining: {
            quantity: { decimal: "0", unit: { kind: "count", unit: "request" } },
            authority: "provider_reported",
          },
        },
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

  it("falls back to valid NANO and preserves its malformed USD sibling as a partial error", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      balance: { nanoBalanceRaw: "26.71801147" },
      endpointErrors: [
        {
          endpoint: "balance",
          message: "NanoGPT balance response returned an invalid usd_balance decimal",
        },
      ],
    });

    const out = await nanoGptProvider.fetch({ config: {} } as any);

    expect(visibleEntries(out.entries, "nanogpt")).toEqual([
      {
        kind: "quantity",
        name: "nanogpt-current-balance",
        group: "NanoGPT",
        semantic: {
          metric: { kind: "component", component: "current_balance" },
          prominence: "primary",
        },
        quantity: { decimal: "26.71801147", unit: { kind: "custom", symbol: "NANO" } },
      },
    ]);
    expect(out.errors).toEqual([
      {
        label: "NanoGPT Balance",
        message: "NanoGPT balance response returned an invalid usd_balance decimal",
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
    expect(visibleEntries(out.entries, "nanogpt")).toEqual([]);
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
