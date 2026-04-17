import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { chutesProvider } from "../src/providers/chutes.js";

vi.mock("../src/lib/chutes.js", () => ({
  queryChutesQuota: vi.fn(),
  hasChutesApiKeyConfigured: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("chutes provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryChutesQuota } = await import("../src/lib/chutes.js");
    (queryChutesQuota as any).mockResolvedValueOnce(null);

    const out = await chutesProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into a toast entry", async () => {
    const { queryChutesQuota } = await import("../src/lib/chutes.js");
    (queryChutesQuota as any).mockResolvedValueOnce({
      success: true,
      percentRemaining: 75,
      resetTimeIso: "2026-01-02T00:00:00.000Z",
    });

    const out = await chutesProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Chutes",
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryChutesQuota } = await import("../src/lib/chutes.js");
    (queryChutesQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await chutesProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Chutes");
  });

  it("is available when chutes provider ids are reported by metadata", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(chutesProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("falls back to trusted API key presence when provider ids are absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasChutesApiKeyConfigured } = await import("../src/lib/chutes.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasChutesApiKeyConfigured as any).mockResolvedValueOnce(true);

    await expect(chutesProvider.isAvailable({} as any)).resolves.toBe(true);
  });
});
