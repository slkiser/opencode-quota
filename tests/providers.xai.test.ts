import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { xaiProvider } from "../src/providers/xai.js";

vi.mock("../src/lib/xai.js", () => ({
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasXaiOAuthCached: vi.fn(),
  periodKindLabel: vi.fn((kind: string) => {
    switch (kind) {
      case "weekly":
        return "Weekly";
      case "monthly":
        return "Monthly";
      case "daily":
        return "Daily";
      default:
        return "Period";
    }
  }),
  queryXaiQuota: vi.fn(),
}));

describe("xai provider", () => {
  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    await xaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(queryXaiQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    const out = await xaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("shows only the shared weekly meter for unified billing", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "xAI SuperGrok",
      unifiedBilling: true,
      windows: {
        primary: {
          percentRemaining: 99,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
          kind: "weekly",
        },
        products: [
          {
            product: "Api",
            window: {
              percentRemaining: 99,
              resetTimeIso: "2026-07-20T02:24:00.983Z",
              kind: "weekly",
            },
          },
          {
            product: "GrokChat",
            window: {
              percentRemaining: 100,
              resetTimeIso: "2026-07-20T02:24:00.983Z",
              kind: "weekly",
            },
          },
        ],
      },
      monthly: {
        limitUsd: 1500,
        usedUsd: 4.26,
        remainingUsd: 1495.74,
        percentRemaining: 100,
        resetTimeIso: "2026-08-01T00:00:00.000Z",
      },
    });

    const out = await xaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "xAI SuperGrok Weekly",
        group: "xAI SuperGrok",
        label: "Weekly:",
        percentRemaining: 99,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "xAI SuperGrok",
    });
  });

  it("shows non-unified product rows when remaining differs", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "xAI",
      unifiedBilling: false,
      windows: {
        primary: {
          percentRemaining: 80,
          resetTimeIso: "2026-07-20T02:24:00.983Z",
          kind: "weekly",
        },
        products: [
          {
            product: "Api",
            window: {
              percentRemaining: 50,
              resetTimeIso: "2026-07-20T02:24:00.983Z",
              kind: "weekly",
            },
          },
        ],
      },
    });

    const out = await xaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((e) => e.label)).toEqual(["Weekly:", "Api:"]);
  });

  it("maps errors into toast errors", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await xaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "xAI");
  });

  it("matches only xai/grok provider ids, not bare grok model names", () => {
    expect(xaiProvider.matchesCurrentModel?.("xai/grok-4")).toBe(true);
    expect(xaiProvider.matchesCurrentModel?.("grok/grok-4")).toBe(true);
    expect(xaiProvider.matchesCurrentModel?.("grok-code-fast-1")).toBe(false);
    expect(xaiProvider.matchesCurrentModel?.("github-copilot/grok-code-fast-1")).toBe(false);
    expect(xaiProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when provider ids include xai or oauth is cached", async () => {
    const { hasXaiOAuthCached } = await import("../src/lib/xai.js");
    (hasXaiOAuthCached as any).mockResolvedValue(false);

    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(true);

    (hasXaiOAuthCached as any).mockResolvedValue(true);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: [] })),
    ).resolves.toBe(true);

    (hasXaiOAuthCached as any).mockResolvedValue(false);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: [] })),
    ).resolves.toBe(false);
  });
});
