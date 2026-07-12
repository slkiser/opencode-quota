import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { visibleEntries } from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { zhipuProvider } from "../src/providers/zhipu.js";

vi.mock("../src/lib/zhipu.js", () => ({
  queryZhipuQuota: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  resolveZhipuAuthCached: vi.fn(),
}));

vi.mock("../src/lib/zhipu-auth.js", () => ({
  DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveZhipuAuthCached: authMocks.resolveZhipuAuthCached,
}));

describe("zhipu provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.resolveZhipuAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "zhipu-test-key",
    });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryZhipuQuota } = await import("../src/lib/zhipu.js");
    (queryZhipuQuota as any).mockResolvedValueOnce(null);

    const out = await zhipuProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into canonical grouped-capable entries with single-window display metadata", async () => {
    const { queryZhipuQuota } = await import("../src/lib/zhipu.js");
    (queryZhipuQuota as any).mockResolvedValueOnce({
      success: true,
      label: "Zhipu",
      windows: {
        fiveHour: { percentRemaining: 80, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 30, resetTimeIso: "2026-01-02T00:00:00.000Z" },
        mcp: { percentRemaining: 90, resetTimeIso: "2026-01-03T00:00:00.000Z" },
      },
    });

    const out = await zhipuProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "zhipu")).toEqual([
      {
        name: "Zhipu 5h",
        group: "Zhipu",
        label: "5h:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "Zhipu Weekly",
        group: "Zhipu",
        label: "Weekly:",
        percentRemaining: 30,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
      {
        name: "Zhipu MCP",
        group: "Zhipu",
        label: "MCP:",
        percentRemaining: 90,
        resetTimeIso: "2026-01-03T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "Zhipu",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryZhipuQuota } = await import("../src/lib/zhipu.js");
    (queryZhipuQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await zhipuProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "Zhipu");
  });

  it("matches Zhipu-specific model ids without matching the international Z.ai glm provider", () => {
    expect(zhipuProvider.matchesCurrentModel?.("zhipu/glm-4.5")).toBe(true);
    expect(zhipuProvider.matchesCurrentModel?.("zhipu-coding-plan/glm-4.5")).toBe(true);
    expect(zhipuProvider.matchesCurrentModel?.("glm-coding-plan/glm-4.5")).toBe(true);
    expect(zhipuProvider.matchesCurrentModel?.("zai/glm-4.5")).toBe(false);
    expect(zhipuProvider.matchesCurrentModel?.("glm/glm-4.5")).toBe(false);
    expect(zhipuProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available when provider ids include zhipu/zhipu-coding-plan/glm-coding-plan and auth is configured", async () => {
    await expect(
      zhipuProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zhipu"] })),
    ).resolves.toBe(true);
    await expect(
      zhipuProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["zhipu-coding-plan"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      zhipuProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["glm-coding-plan"] }),
      ),
    ).resolves.toBe(true);
    await expect(
      zhipuProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(false);
  });

  it("is available when auth is invalid so the provider can surface the error", async () => {
    authMocks.resolveZhipuAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: 'Unsupported Zhipu auth type: "oauth"',
    });

    const ctx = createProviderAvailabilityContext({ providerIds: ["zhipu"] });

    await expect(zhipuProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(authMocks.resolveZhipuAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is not available when provider ids exist but auth is missing", async () => {
    authMocks.resolveZhipuAuthCached.mockResolvedValueOnce({ state: "none" });

    const ctx = createProviderAvailabilityContext({ providerIds: ["zhipu"] });

    await expect(zhipuProvider.isAvailable(ctx)).resolves.toBe(false);
    expect(authMocks.resolveZhipuAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(zhipuProvider.isAvailable(ctx)).resolves.toBe(false);
    expect(authMocks.resolveZhipuAuthCached).not.toHaveBeenCalled();
  });
});
