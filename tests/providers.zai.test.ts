import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { zaiProvider } from "../src/providers/zai.js";

vi.mock("../src/lib/zai.js", () => ({
  queryZaiQuota: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  resolveZaiAuthCached: vi.fn(),
}));

vi.mock("../src/lib/zai-auth.js", () => ({
  DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveZaiAuthCached: authMocks.resolveZaiAuthCached,
}));

describe("zai provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveZaiAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "zai-test-key",
    });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryZaiQuota } = await import("../src/lib/zai.js");
    (queryZaiQuota as any).mockResolvedValueOnce(null);

    const out = await zaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into a single toast entry (classic) using worst window", async () => {
    const { queryZaiQuota } = await import("../src/lib/zai.js");
    (queryZaiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Z.ai",
      windows: {
        fiveHour: { percentRemaining: 80, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 30, resetTimeIso: "2026-01-02T00:00:00.000Z" },
        mcp: { percentRemaining: 90, resetTimeIso: "2026-01-03T00:00:00.000Z" },
      },
    });

    const out = await zaiProvider.fetch({ config: { formatStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Z.ai",
        percentRemaining: 30,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps success into grouped entries for all windows", async () => {
    const { queryZaiQuota } = await import("../src/lib/zai.js");
    (queryZaiQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Z.ai",
      windows: {
        fiveHour: { percentRemaining: 85, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 45, resetTimeIso: "2026-01-02T00:00:00.000Z" },
        mcp: { percentRemaining: 70, resetTimeIso: "2026-01-03T00:00:00.000Z" },
      },
    });

    const out = await zaiProvider.fetch({ config: { formatStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "Z.ai 5h",
        group: "Z.ai",
        label: "5h:",
        percentRemaining: 85,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "Z.ai Weekly",
        group: "Z.ai",
        label: "Weekly:",
        percentRemaining: 45,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "Z.ai MCP",
        group: "Z.ai",
        label: "MCP:",
        percentRemaining: 70,
        resetTimeIso: "2026-01-03T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryZaiQuota } = await import("../src/lib/zai.js");
    (queryZaiQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await zaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Z.ai");
  });

  it("matches zai/glm model ids", () => {
    expect(zaiProvider.matchesCurrentModel?.("zai/glm-4.5")).toBe(true);
    expect(zaiProvider.matchesCurrentModel?.("glm/glm-4.5")).toBe(true);
    expect(zaiProvider.matchesCurrentModel?.("anthropic/glm-4")).toBe(true);
    expect(zaiProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when provider ids include zai/glm/zai-coding-plan and auth is configured", async () => {
    await expect(
      zaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(true);
    await expect(
      zaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["glm"] })),
    ).resolves.toBe(true);
    await expect(
      zaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai-coding-plan"] })),
    ).resolves.toBe(true);
    await expect(
      zaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
  });

  it("is available when auth is invalid so the provider can surface the error", async () => {
    authMocks.resolveZaiAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: 'Unsupported Z.ai auth type: "oauth"',
    });

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(zaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(authMocks.resolveZaiAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is not available when provider ids exist but auth is missing", async () => {
    authMocks.resolveZaiAuthCached.mockResolvedValueOnce({ state: "none" });

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(zaiProvider.isAvailable(ctx)).resolves.toBe(false);
    expect(authMocks.resolveZaiAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(zaiProvider.isAvailable(ctx)).resolves.toBe(false);
    expect(authMocks.resolveZaiAuthCached).not.toHaveBeenCalled();
  });
});
