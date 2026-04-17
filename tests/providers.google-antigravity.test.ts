import { describe, expect, it, vi } from "vitest";

import { expectAttemptedWithErrorLabel, expectNotAttempted } from "./helpers/provider-assertions.js";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.js";

vi.mock("../src/lib/google.js", () => ({
  hasAntigravityQuotaRuntimeAvailable: vi.fn(),
  queryGoogleQuota: vi.fn(),
}));

describe("google antigravity provider", () => {
  it("returns attempted:false when antigravity accounts are not configured", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce(null);

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectNotAttempted(out);
  });

  it("maps success into toast entries and truncated error labels", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          displayName: "Gemini 2.5 Pro",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        name: "Gemini 2.5 Pro (ali..gmail)",
        percentRemaining: 64,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(out.errors).toEqual([{ label: "bob..gmail", message: "Unauthorized" }]);
  });

  it("maps fetch failures into toast errors", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectAttemptedWithErrorLabel(out, "Antigravity");
  });

  it("is available only when the antigravity runtime is configured", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(true);

    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(false);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("returns false when runtime detection throws", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockRejectedValueOnce(new Error("boom"));

    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
