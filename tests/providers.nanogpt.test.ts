import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { nanogptProvider } from "../src/providers/nanogpt.js";

vi.mock("../src/lib/nanogpt.js", () => ({
  queryNanoGptQuota: vi.fn(),
  hasNanoGptApiKey: vi.fn(),
}));

describe("nanogpt provider", () => {
  it("returns attempted:false when not configured", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce(null);

    const out = await nanogptProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into a single toast entry (classic) using worst window", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      label: "NanoGPT",
      windows: {
        weeklyTokens: { percentRemaining: 80, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        dailyImages: { percentRemaining: 30, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await nanogptProvider.fetch({ config: { toastStyle: "classic" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT",
        percentRemaining: 30,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps success into grouped entries for all windows", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: true,
      label: "NanoGPT",
      windows: {
        weeklyTokens: { percentRemaining: 85, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        dailyImages: { percentRemaining: 45, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await nanogptProvider.fetch({ config: { toastStyle: "grouped" } } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        name: "NanoGPT Weekly Tokens",
        group: "NanoGPT",
        label: "Weekly:",
        percentRemaining: 85,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "NanoGPT Daily Images",
        group: "NanoGPT",
        label: "Images:",
        percentRemaining: 45,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("maps errors into toast errors", async () => {
    const { queryNanoGptQuota } = await import("../src/lib/nanogpt.js");
    (queryNanoGptQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Unauthorized",
    });

    const out = await nanogptProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "NanoGPT");
  });

  it("matches nanogpt/nano-gpt/nanogpt-custom model ids", () => {
    expect(nanogptProvider.matchesCurrentModel?.("nanogpt/gpt-4")).toBe(true);
    expect(nanogptProvider.matchesCurrentModel?.("nano-gpt/gpt-4")).toBe(true);
    expect(nanogptProvider.matchesCurrentModel?.("nanogpt-custom/minimax")).toBe(true);
    expect(nanogptProvider.matchesCurrentModel?.("openai/gpt-4")).toBe(false);
  });

  it("is available when provider ids include nanogpt variants", async () => {
    const { hasNanoGptApiKey } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKey as any).mockResolvedValueOnce(false);

    const makeCtx = (ids: string[]) =>
      ({
        client: {
          config: {
            providers: vi
              .fn()
              .mockResolvedValue({ data: { providers: ids.map((id) => ({ id })) } }),
            get: vi.fn(),
          },
        },
        config: { googleModels: [] },
      }) as any;

    await expect(nanogptProvider.isAvailable(makeCtx(["nanogpt"]))).resolves.toBe(true);
    await expect(nanogptProvider.isAvailable(makeCtx(["nanogpt-custom"]))).resolves.toBe(true);
    await expect(nanogptProvider.isAvailable(makeCtx(["nano-gpt"]))).resolves.toBe(true);
    await expect(nanogptProvider.isAvailable(makeCtx(["openai"]))).resolves.toBe(false);
  });

  it("falls back to api key when provider ids not found", async () => {
    const { hasNanoGptApiKey } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKey as any).mockResolvedValueOnce(true);

    const ctx = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [{ id: "openai" }] } }),
          get: vi.fn(),
        },
      },
      config: { googleModels: [] },
    } as any;

    await expect(nanogptProvider.isAvailable(ctx)).resolves.toBe(true);
  });

  it("is not available when provider lookup throws and no api key", async () => {
    const { hasNanoGptApiKey } = await import("../src/lib/nanogpt.js");
    (hasNanoGptApiKey as any).mockResolvedValueOnce(false);

    const ctx = {
      client: {
        config: {
          providers: vi.fn().mockRejectedValue(new Error("boom")),
          get: vi.fn(),
        },
      },
      config: { googleModels: [] },
    } as any;

    await expect(nanogptProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
