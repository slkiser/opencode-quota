import { beforeEach, describe, expect, it, vi } from "vitest";

import { xaiProvider } from "../src/providers/xai.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/xai.js", () => ({
  DEFAULT_XAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasXaiOAuthCached: vi.fn(),
  periodKindLabel: vi.fn((kind: string) => {
    if (kind === "weekly") return "Weekly";
    if (kind === "monthly") return "Monthly";
    if (kind === "daily") return "Daily";
    return "Period";
  }),
  queryXaiQuota: vi.fn(),
}));

describe("xai provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    await xaiProvider.fetch({ config: { requestTimeoutMs: 12_000 } } as any);

    expect(queryXaiQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12_000 });
  });

  it("returns attempted:false when OAuth is not configured", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce(null);

    const output = await xaiProvider.fetch({} as any);
    expectNotAttempted(output);
  });

  it("maps exactly one shared weekly quota row with accounting metadata", async () => {
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

    const output = await xaiProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(output);
    expect(visibleEntries(output.entries)).toEqual([
      {
        name: "xAI SuperGrok Weekly",
        group: "xAI SuperGrok",
        label: "Weekly:",
        percentRemaining: 95,
        resetTimeIso: "2026-07-20T02:24:00.983Z",
      },
    ]);
    expect(output.entries[0]?.accounting).toEqual({
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(output.presentation).toEqual({ singleWindowDisplayName: "xAI SuperGrok" });
  });

  it("maps attempted query errors without exposing provider internals", async () => {
    const { queryXaiQuota } = await import("../src/lib/xai.js");
    (queryXaiQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const output = await xaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(output, "xAI");
    expect(output.errors).toEqual([{ label: "xAI", message: "Token expired" }]);
  });

  it("uses currentProviderID to distinguish direct xAI from Copilot Grok models", () => {
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
    expect(
      xaiProvider.matchesCurrentModel?.("grok-4", {
        enabledProviders: "auto",
        currentProviderID: "grok",
      }),
    ).toBe(false);
    expect(xaiProvider.matchesCurrentModel?.("xai/grok-4", { enabledProviders: "auto" })).toBe(
      true,
    );
    expect(xaiProvider.matchesCurrentModel?.("grok/grok-4", { enabledProviders: "auto" })).toBe(
      false,
    );
    expect(xaiProvider.matchesCurrentModel?.("openai/grok-4", { enabledProviders: "auto" })).toBe(
      false,
    );
  });

  it("requires OAuth even when the xai runtime provider exists", async () => {
    const { hasXaiOAuthCached } = await import("../src/lib/xai.js");
    (hasXaiOAuthCached as any).mockResolvedValueOnce(false);

    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["xai"] })),
    ).resolves.toBe(false);
    expect(hasXaiOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 0 });
  });

  it("is available from the exact OAuth entry even when runtime provider lookup is empty", async () => {
    const { hasXaiOAuthCached } = await import("../src/lib/xai.js");
    (hasXaiOAuthCached as any).mockResolvedValueOnce(true);

    await expect(
      xaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: [] })),
    ).resolves.toBe(true);
    expect(hasXaiOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to the cached OAuth check when runtime provider lookup fails", async () => {
    const { hasXaiOAuthCached } = await import("../src/lib/xai.js");
    (hasXaiOAuthCached as any).mockResolvedValueOnce(true);

    await expect(
      xaiProvider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("unavailable") }),
      ),
    ).resolves.toBe(true);
    expect(hasXaiOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });
});
