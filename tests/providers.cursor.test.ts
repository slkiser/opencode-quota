import { describe, expect, it, vi } from "vitest";

import { expectAttemptedWithNoErrors, expectNotAttempted } from "./helpers/provider-assertions.js";
import { cursorProvider } from "../src/providers/cursor.js";

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  inspectCursorOpenCodeIntegration: vi.fn(),
}));

vi.mock("../src/lib/cursor-usage.js", () => ({
  getCurrentCursorUsageSummary: vi.fn(),
}));

describe("cursor provider", () => {
  it("returns attempted:false when there is no usage and no configured included budget", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue({
      window: { resetTimeIso: "2026-03-01T00:00:00.000Z" },
      api: { costUsd: 0, tokens: {}, messageCount: 0 },
      autoComposer: { costUsd: 0, tokens: {}, messageCount: 0 },
      total: { costUsd: 0, tokens: {}, messageCount: 0 },
      unknownModels: [],
    });

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "none", formatStyle: "grouped" },
    } as any);
    expectNotAttempted(out);
  });

  it("renders grouped api and auto/composer rows when a plan budget is configured", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue({
      window: { resetTimeIso: "2026-03-01T00:00:00.000Z" },
      api: { costUsd: 5, tokens: {}, messageCount: 2 },
      autoComposer: { costUsd: 1.25, tokens: {}, messageCount: 1 },
      total: { costUsd: 6.25, tokens: {}, messageCount: 3 },
      unknownModels: [],
    });

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro", formatStyle: "grouped" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({
      group: "Cursor (Pro)",
      label: "API:",
      right: "$5.00/$20.00",
      percentRemaining: 75,
    });
    expect(out.entries[1]).toMatchObject({
      kind: "value",
      group: "Cursor (Pro)",
      label: "Auto+Composer:",
      value: "$1.25 used",
    });
  });

  it("renders a classic value-only entry when no included api budget is configured", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue({
      window: { resetTimeIso: "2026-03-01T00:00:00.000Z" },
      api: { costUsd: 0.5, tokens: {}, messageCount: 1 },
      autoComposer: { costUsd: 1.25, tokens: {}, messageCount: 1 },
      total: { costUsd: 1.75, tokens: {}, messageCount: 2 },
      unknownModels: [],
    });

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "none", formatStyle: "classic" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Cursor",
        value: "$1.75 used this cycle",
        resetTimeIso: "2026-03-01T00:00:00.000Z",
      },
    ]);
  });

  it("surfaces unknown cursor model ids as provider errors", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue({
      window: { resetTimeIso: "2026-03-01T00:00:00.000Z" },
      api: { costUsd: 2, tokens: {}, messageCount: 1 },
      autoComposer: { costUsd: 0, tokens: {}, messageCount: 0 },
      total: { costUsd: 2, tokens: {}, messageCount: 2 },
      unknownModels: [{ sourceModelID: "cursor/future-model", messageCount: 1, tokens: {} }],
    });

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro", formatStyle: "classic" },
    } as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([
      {
        kind: "value",
        name: "Cursor API (Pro)",
        value: "$2.00/$20.00 used (partial)",
        resetTimeIso: "2026-03-01T00:00:00.000Z",
      },
    ]);
    expect(out.errors[0]?.label).toBe("Cursor");
    expect(out.errors[0]?.message).toContain("Unknown Cursor model ids");
  });

  it("treats the current Cursor provider id as an availability signal", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(false);
    (inspectCursorOpenCodeIntegration as any).mockResolvedValue({
      pluginEnabled: false,
      providerConfigured: false,
      matchedPaths: [],
      checkedPaths: ["/tmp/opencode.json"],
    });

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { currentModel: "auto", currentProviderID: "cursor", cursorPlan: "none" },
      } as any),
    ).resolves.toBe(true);
  });

  it("treats cursor models or config-file integration as availability signals", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    const { inspectCursorOpenCodeIntegration } = await import("../src/lib/cursor-detection.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(false);
    (inspectCursorOpenCodeIntegration as any).mockResolvedValue({
      pluginEnabled: true,
      providerConfigured: false,
      matchedPaths: ["/tmp/opencode.json"],
      checkedPaths: ["/tmp/opencode.json"],
    });

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { currentModel: "openai/gpt-5", cursorPlan: "none" },
      } as any),
    ).resolves.toBe(true);

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { currentModel: "cursor-acp/auto", cursorPlan: "none" },
      } as any),
    ).resolves.toBe(true);
  });

  it("treats metadata-backed Cursor provider availability as a signal", async () => {
    const { isCanonicalProviderAvailable } = await import("../src/lib/provider-availability.js");
    (isCanonicalProviderAvailable as any).mockResolvedValue(true);

    await expect(
      cursorProvider.isAvailable({
        client: { config: { providers: vi.fn() } },
        config: { currentModel: "openai/gpt-5", cursorPlan: "none" },
      } as any),
    ).resolves.toBe(true);
  });
});
