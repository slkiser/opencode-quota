import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";
import { openaiProvider } from "../src/providers/openai.js";

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  hasOpenAIOAuthCached: vi.fn(),
  queryOpenAIQuota: vi.fn(),
}));

describe("openai provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    const out = await openaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into canonical grouped-capable windows with single-window display metadata", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 80, resetTimeIso: "2026-01-07T00:00:00.000Z" },
      },
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "OpenAI (Pro) 5h",
        group: "OpenAI (Pro)",
        label: "5h:",
        percentRemaining: 42,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Weekly",
        group: "OpenAI (Pro)",
        label: "Weekly:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-07T00:00:00.000Z",
      },
    ]);
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "OpenAI (Pro)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenAI");
  });

  it("is available when provider ids include openai/chatgpt/codex", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["chatgpt"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["codex"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["opencode"] })),
    ).resolves.toBe(false);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(false);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledTimes(2);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to native OpenCode auth when provider ids do not include an OpenAI alias", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValueOnce(true);

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to available when provider lookup throws", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });
});
