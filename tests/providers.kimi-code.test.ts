import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const authMocks = vi.hoisted(() => ({
  resolveKimiAuthCached: vi.fn(),
}));

vi.mock("../src/lib/kimi-auth.js", () => ({
  resolveKimiAuthCached: authMocks.resolveKimiAuthCached,
  DEFAULT_KIMI_AUTH_CACHE_MAX_AGE_MS: 5_000,
}));

vi.mock("../src/lib/kimi.js", () => ({
  queryKimiQuota: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

import { kimiCodeProvider } from "../src/providers/kimi-code.js";

describe("kimi-code provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveKimiAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "test-key",
    });
  });

  it("returns attempted:false when no kimi auth is configured", async () => {
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await kimiCodeProvider.fetch({ config: {} } as any);
    expectNotAttempted(out);
  });

  it("returns error when kimi auth is invalid", async () => {
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "Invalid API key",
    });

    const out = await kimiCodeProvider.fetch({ config: {} } as any);
    expectAttemptedWithErrorLabel(out, "Kimi Code");
    expect(out.errors[0]?.message).toBe("Invalid API key");
  });

  it("maps success into grouped entries for all windows", async () => {
    const { queryKimiQuota } = await import("../src/lib/kimi.js");
    (queryKimiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Kimi Code",
      windows: [
        {
          label: "Weekly limit",
          used: 250,
          limit: 1000,
          percentRemaining: 75,
          resetTimeIso: "2026-01-08T00:00:00.000Z",
        },
        {
          label: "5h limit",
          used: 100,
          limit: 500,
          percentRemaining: 80,
          resetTimeIso: "2026-01-01T05:00:00.000Z",
        },
      ],
    });

    const out = await kimiCodeProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Kimi Code Weekly limit",
        group: "Kimi Code",
        label: "Weekly limit:",
        right: "250/1000",
        percentRemaining: 75,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
      {
        name: "Kimi Code 5h limit",
        group: "Kimi Code",
        label: "5h limit:",
        right: "100/500",
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    ]);
  });

  it("maps success into a single toast entry (classic) using worst window", async () => {
    const { queryKimiQuota } = await import("../src/lib/kimi.js");
    (queryKimiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Kimi Code",
      windows: [
        {
          label: "Weekly limit",
          used: 250,
          limit: 1000,
          percentRemaining: 75,
          resetTimeIso: "2026-01-08T00:00:00.000Z",
        },
        {
          label: "5h limit",
          used: 100,
          limit: 500,
          percentRemaining: 80,
          resetTimeIso: "2026-01-01T05:00:00.000Z",
        },
      ],
    });

    const out = await kimiCodeProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Kimi Code",
        percentRemaining: 75,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryKimiQuota } = await import("../src/lib/kimi.js");
    (queryKimiQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await kimiCodeProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Kimi Code");
  });

  it("matches kimi model ids", () => {
    expect(kimiCodeProvider.matchesCurrentModel?.("kimi-code/kimi-k2")).toBe(true);
    expect(kimiCodeProvider.matchesCurrentModel?.("kimi/kimi-k2")).toBe(true);
    expect(kimiCodeProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when provider ids include kimi and auth is configured", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);

    const available = await kimiCodeProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-for-coding"] }),
    );
    expect(available).toBe(true);
  });

  it("is available when auth is invalid so the provider can surface the error", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: 'Unsupported Kimi auth type: "oauth"',
    });

    const available = await kimiCodeProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-for-coding"] }),
    );
    expect(available).toBe(true);
  });

  it("is not available when provider ids exist but auth is missing", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);
    authMocks.resolveKimiAuthCached.mockResolvedValueOnce({ state: "none" });

    const available = await kimiCodeProvider.isAvailable(
      createProviderAvailabilityContext({ providerIds: ["kimi-for-coding"] }),
    );
    expect(available).toBe(false);
  });

  it("is not available when provider lookup throws", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockRestore();

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    const available = await kimiCodeProvider.isAvailable(ctx);
    expect(available).toBe(false);
    expect(authMocks.resolveKimiAuthCached).not.toHaveBeenCalled();
  });
});
