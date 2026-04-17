import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { firmwareProvider } from "../src/providers/firmware.js";

vi.mock("../src/lib/firmware.js", () => ({
  queryFirmwareQuota: vi.fn(),
  hasFirmwareApiKeyConfigured: vi.fn(),
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

describe("firmware provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryFirmwareQuota } = await import("../src/lib/firmware.js");
    (queryFirmwareQuota as any).mockResolvedValueOnce(null);

    const out = await firmwareProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into a value toast entry", async () => {
    const { queryFirmwareQuota } = await import("../src/lib/firmware.js");
    (queryFirmwareQuota as any).mockResolvedValueOnce({
      success: true,
      creditsUsd: 42.5,
      resetTimeIso: "2026-01-20T18:12:03.000Z",
    });

    const out = await firmwareProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Firmware",
        value: "$42.50",
        resetTimeIso: "2026-01-20T18:12:03.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryFirmwareQuota } = await import("../src/lib/firmware.js");
    (queryFirmwareQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await firmwareProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Firmware");
  });

  it("is available when firmware provider ids are reported by metadata", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(true);

    await expect(firmwareProvider.isAvailable({} as any)).resolves.toBe(true);
  });

  it("falls back to trusted API key presence when provider ids are absent", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { hasFirmwareApiKeyConfigured } = await import("../src/lib/firmware.js");
    (isCanonicalProviderAvailable as any).mockResolvedValueOnce(false);
    (hasFirmwareApiKeyConfigured as any).mockResolvedValueOnce(true);

    await expect(firmwareProvider.isAvailable({} as any)).resolves.toBe(true);
  });
});
