import { describe, expect, it, vi } from "vitest";
import { runwayRow, runwayNow } from "./helpers/runway-fixture.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
const mocks = vi.hoisted(() => ({ providers: [] as any[], fetch: vi.fn() }));
vi.mock("../src/providers/registry.js", () => ({ getProviders: () => mocks.providers }));
vi.mock("../src/lib/quota-state.js", () => ({ fetchQuotaProviderResult: mocks.fetch }));
import { fetchAllQuota } from "../src/gui/ipc/quota.js";

describe("desktop provider failures", () => {
  it("uses the same typed fixed-window estimate with one provider call and opt-in", async () => {
    vi.spyOn(Date, "now").mockReturnValue(runwayNow);
    mocks.providers = [{ id: "fixture", isAvailable: async () => true }];
    mocks.fetch.mockClear();
    mocks.fetch.mockResolvedValue({
      attempted: true,
      entries: [{ name: "Fixture Weekly", percentRemaining: 25 }],
      errors: [],
      accounting: { version: 1, rows: [runwayRow()] },
    });
    const data = await fetchAllQuota({
      ...DEFAULT_CONFIG,
      enabledProviders: ["fixture"],
      quotaProjection: "runway",
    });
    expect(data.accountingDetails?.[0].runway).toBe("≈ 1h 20m");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(data.entries[0]).not.toHaveProperty("runway");
  });
  it("shows rejected provider checks alongside successful quota without leaking exception text", async () => {
    mocks.providers = [
      {
        id: "copilot",
        isAvailable: vi.fn().mockRejectedValue(new Error("credential-like private detail")),
      },
      { id: "openai", isAvailable: vi.fn().mockResolvedValue(true) },
    ];
    mocks.fetch.mockResolvedValue({
      attempted: true,
      entries: [{ name: "OpenAI", percentRemaining: 42 }],
      errors: [],
    });
    const result = await fetchAllQuota({ ...DEFAULT_CONFIG, enabledProviders: "auto" });
    expect(result.entries).toEqual([
      { name: "OpenAI", percentRemaining: 42, providerId: "openai" },
    ]);
    expect(result.errors).toEqual([{ label: "Copilot", message: "Quota query failed" }]);
    expect(result.detectedProviderIds).toEqual(["openai"]);
  });
});
