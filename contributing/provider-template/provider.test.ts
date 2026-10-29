import { describe, expect, it, vi } from "vite-plus/test";
import { exampleProviderProvider } from "../src/providers/example-provider.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/example-provider.js", () => ({
  queryExampleProviderQuota: vi.fn(),
}));

vi.mock("../src/lib/example-provider-config.js", () => ({
  hasExampleProviderApiKey: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("example provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryExampleProviderQuota } = await import("../src/lib/example-provider.js");
    (queryExampleProviderQuota as any).mockResolvedValueOnce(null);

    const out = await exampleProviderProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into a quota entry", async () => {
    const { queryExampleProviderQuota } = await import("../src/lib/example-provider.js");
    (queryExampleProviderQuota as any).mockResolvedValueOnce({
      success: true,
      percentRemaining: 75,
      resetTimeIso: "2026-01-02T00:00:00.000Z",
    });

    const out = await exampleProviderProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: "Example Provider",
        percentRemaining: 75,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps provider errors into quota errors", async () => {
    const { queryExampleProviderQuota } = await import("../src/lib/example-provider.js");
    (queryExampleProviderQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await exampleProviderProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Example Provider");
  });

  it("is available when canonical provider metadata is available", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(exampleProviderProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("falls back to trusted API key presence when provider metadata is absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasExampleProviderApiKey } = await import("../src/lib/example-provider-config.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasExampleProviderApiKey as any).mockResolvedValueOnce(true);

    await expect(exampleProviderProvider.isAvailable({} as any)).resolves.toBe(true);
  });
});
