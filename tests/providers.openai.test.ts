import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
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

  it("maps success into a single toast entry (classic)", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
      },
    });

    const out = await openaiProvider.fetch({ config: {} } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "OpenAI (Pro)",
        percentRemaining: 42,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
    ]);
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

  it("is available when provider ids include openai/chatgpt/codex/opencode", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const makeCtx = (ids: string[]) =>
      ({
        client: {
          config: {
            providers: vi.fn().mockResolvedValue({ data: { providers: ids.map((id) => ({ id })) } }),
            get: vi.fn(),
          },
        },
        config: { googleModels: [] },
      }) as any;

    await expect(openaiProvider.isAvailable(makeCtx(["openai"]))).resolves.toBe(true);
    await expect(openaiProvider.isAvailable(makeCtx(["chatgpt"]))).resolves.toBe(true);
    await expect(openaiProvider.isAvailable(makeCtx(["codex"]))).resolves.toBe(true);
    await expect(openaiProvider.isAvailable(makeCtx(["opencode"]))).resolves.toBe(true);
    await expect(openaiProvider.isAvailable(makeCtx(["zai"]))).resolves.toBe(false);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledTimes(1);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to native OpenCode auth when provider ids do not include an OpenAI alias", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValueOnce(true);

    const ctx = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "zai" }] } }),
          get: vi.fn(),
        },
      },
      config: { googleModels: [] },
    } as any;

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to available when provider lookup throws", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const ctx = {
      client: {
        config: {
          providers: vi.fn().mockRejectedValue(new Error("boom")),
          get: vi.fn(),
        },
      },
      config: { googleModels: [] },
    } as any;

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });
});
