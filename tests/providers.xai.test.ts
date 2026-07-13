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
  periodKindLabel: vi.fn((kind: string) => (kind === "weekly" ? "Weekly" : "Period")),
  queryXaiQuota: vi.fn(),
}));

describe("xai provider", () => {
  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    await xaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(queryXaiQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when oauth is not configured", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    const out = await xaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps exactly one shared weekly row", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "xAI SuperGrok",
      window: {
        percentRemaining: 95,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
        kind: "weekly",
      },
    });

    const out = await xaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "xAI SuperGrok Weekly",
        group: "xAI SuperGrok",
        label: "Weekly:",
        percentRemaining: 95,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
      },
    ]);
    expect(out.presentation).toEqual({ singleWindowDisplayName: "xAI SuperGrok" });
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

  it("uses currentProviderID to distinguish direct xAI from Copilot Grok", () => {
    expect(
      xaiProvider.matchesCurrentModel?.("grok-4", {
        enabledProviders: "auto",
        currentProviderID: "xai",
      }),
    ).toBe(true);
    expect(
      xaiProvider.matchesCurrentModel?.("grok-code-fast-1", {
        enabledProviders: "auto",
        currentProviderID: "github-copilot",
      }),
    ).toBe(false);
    expect(xaiProvider.matchesCurrentModel?.("xai/grok-4", { enabledProviders: "auto" })).toBe(
      true,
    );
  });

  it("requires both the xai runtime provider and oauth, or oauth fallback", async () => {
    const { hasXaiOAuthCached } = await import("../src/lib/xai.js");

    (hasXaiOAuthCached as any).mockResolvedValue(false);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(false);

    (hasXaiOAuthCached as any).mockResolvedValue(true);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(true);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: [] })),
    ).resolves.toBe(true);
  });
});
