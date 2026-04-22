import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { syntheticProvider } from "../src/providers/synthetic.js";

vi.mock("../src/lib/synthetic.js", () => ({
  querySyntheticQuota: vi.fn(),
  hasSyntheticApiKeyConfigured: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("synthetic provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { querySyntheticQuota } = await import("../src/lib/synthetic.js");
    (querySyntheticQuota as any).mockResolvedValueOnce(null);

    const out = await syntheticProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps both Synthetic quota windows into classic entries with rounded usage summaries", async () => {
    const { querySyntheticQuota } = await import("../src/lib/synthetic.js");
    (querySyntheticQuota as any).mockResolvedValueOnce({
      success: true,
      windows: {
        fiveHour: {
          limit: 100,
          used: 25.5,
          percentRemaining: 75,
          resetTimeIso: "2026-01-20T18:12:03.000Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-01-27T18:12:03.000Z",
        },
      },
    });

    const out = await syntheticProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Synthetic 5h",
        percentRemaining: 75,
        right: "26/100",
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
      {
        name: "Synthetic Weekly",
        percentRemaining: 8,
        right: "$22/$24",
        resetTimeIso: "2026-01-27T18:12:03.000Z",
      },
    ]);
  });

  it("maps both top-level Synthetic windows into grouped rows", async () => {
    const { querySyntheticQuota } = await import("../src/lib/synthetic.js");
    (querySyntheticQuota as any).mockResolvedValueOnce({
      success: true,
      windows: {
        fiveHour: {
          limit: 500,
          used: 52.4,
          percentRemaining: 90,
          resetTimeIso: "2026-01-20T18:12:03.000Z",
        },
        weekly: {
          limit: 24,
          used: 21.98,
          percentRemaining: 8,
          resetTimeIso: "2026-01-27T18:12:03.000Z",
        },
      },
    });

    const out = await syntheticProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Synthetic 5h",
        group: "Synthetic",
        label: "5h:",
        percentRemaining: 90,
        right: "52/500",
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
      {
        name: "Synthetic Weekly",
        group: "Synthetic",
        label: "Weekly:",
        percentRemaining: 8,
        right: "$22/$24",
        resetTimeIso: "2026-01-27T18:12:03.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { querySyntheticQuota } = await import("../src/lib/synthetic.js");
    (querySyntheticQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await syntheticProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Synthetic");
  });

  it("matches synthetic model prefixes", () => {
    expect(syntheticProvider.matchesCurrentModel?.("synthetic/claude")).toBe(true);
    expect(syntheticProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when synthetic provider ids are reported by metadata", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(syntheticProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("falls back to trusted API key presence when provider ids are absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasSyntheticApiKeyConfigured } = await import("../src/lib/synthetic.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasSyntheticApiKeyConfigured as any).mockResolvedValueOnce(true);

    await expect(syntheticProvider.isAvailable({} as any)).resolves.toBe(true);
  });
});
