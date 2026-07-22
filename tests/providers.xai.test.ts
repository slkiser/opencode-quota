import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { xaiProvider } from "../src/providers/xai.js";

const xaiMocks = vi.hoisted(() => ({
  hasXaiOAuthCached: vi.fn(),
  periodKindLabel: vi.fn((kind: string) => (kind === "weekly" ? "Weekly" : "Period")),
  queryXaiQuota: vi.fn(),
}));

vi.mock("../src/lib/xai.js", () => ({
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasXaiOAuthCached: xaiMocks.hasXaiOAuthCached,
  periodKindLabel: xaiMocks.periodKindLabel,
  queryXaiQuota: xaiMocks.queryXaiQuota,
}));

describe("xai provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xaiMocks.hasXaiOAuthCached.mockResolvedValue(true);
  });

  it("passes configured requestTimeoutMs to the query", async () => {
    xaiMocks.queryXaiQuota.mockResolvedValueOnce(null);

    await xaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(xaiMocks.queryXaiQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when OAuth is not configured", async () => {
    xaiMocks.queryXaiQuota.mockResolvedValueOnce(null);

    const out = await xaiProvider.fetch({} as any);

    expectNotAttempted(out);
  });

  it("maps one shared weekly row with maintained remote accounting", async () => {
    xaiMocks.queryXaiQuota.mockResolvedValueOnce({
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
    expect(visibleEntries(out.entries, "xai")).toEqual([
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
    xaiMocks.queryXaiQuota.mockResolvedValueOnce({
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

  it("requires both the xAI runtime provider and OAuth, or OAuth fallback", async () => {
    xaiMocks.hasXaiOAuthCached.mockResolvedValueOnce(false);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(false);

    xaiMocks.hasXaiOAuthCached.mockResolvedValueOnce(true);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(true);
    expect(xaiMocks.hasXaiOAuthCached).toHaveBeenLastCalledWith({ maxAgeMs: 0 });

    xaiMocks.hasXaiOAuthCached.mockResolvedValueOnce(true);
    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: [] })),
    ).resolves.toBe(true);
    expect(xaiMocks.hasXaiOAuthCached).toHaveBeenLastCalledWith({ maxAgeMs: 5_000 });
  });
});
