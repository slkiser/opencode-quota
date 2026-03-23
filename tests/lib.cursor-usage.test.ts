import { describe, expect, it, vi } from "vitest";

import { computeCursorCycleWindow, getCurrentCursorUsageSummary } from "../src/lib/cursor-usage.js";

vi.mock("../src/lib/opencode-storage.js", () => ({
  iterAssistantMessages: vi.fn(),
}));

describe("cursor usage", () => {
  it("computes configured billing-cycle windows", () => {
    const window = computeCursorCycleWindow({
      nowMs: new Date(2026, 2, 19, 10, 0, 0, 0).getTime(),
      billingCycleStartDay: 7,
    });

    expect(new Date(window.sinceMs).getDate()).toBe(7);
    expect(new Date(window.sinceMs).getMonth()).toBe(2);
    expect(new Date(window.untilMs).getDate()).toBe(7);
    expect(new Date(window.untilMs).getMonth()).toBe(3);
    expect(window.source).toBe("configured_day");
  });

  it("falls back to the calendar month when no billing day is configured", () => {
    const window = computeCursorCycleWindow({
      nowMs: new Date(2026, 2, 19, 10, 0, 0, 0).getTime(),
    });

    expect(new Date(window.sinceMs).getDate()).toBe(1);
    expect(new Date(window.untilMs).getDate()).toBe(1);
    expect(new Date(window.untilMs).getMonth()).toBe(3);
    expect(window.source).toBe("calendar_month");
  });

  it("buckets cursor history into api and auto/composer usage", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([
      {
        role: "assistant",
        providerID: "cursor",
        modelID: "auto",
        tokens: { input: 1_000_000, output: 500_000, cache: { read: 0, write: 0 } },
      },
      {
        role: "assistant",
        providerID: "cursor",
        modelID: "gpt-5.4-high",
        tokens: { input: 1_000_000, output: 1_000_000, cache: { read: 0, write: 0 } },
      },
      {
        role: "assistant",
        providerID: "cursor-acp",
        modelID: "cursor-acp/unknown-future-model",
        tokens: { input: 10, output: 20, cache: { read: 0, write: 0 } },
      },
    ]);

    const summary = await getCurrentCursorUsageSummary({
      nowMs: new Date(2026, 2, 19, 10, 0, 0, 0).getTime(),
      billingCycleStartDay: 7,
    });

    expect(summary.autoComposer.messageCount).toBe(1);
    expect(summary.api.messageCount).toBe(1);
    expect(summary.autoComposer.costUsd).toBeCloseTo(4.25, 6);
    expect(summary.api.costUsd).toBeCloseTo(17.5, 6);
    expect(summary.total.messageCount).toBe(3);
    expect(summary.unknownModels).toHaveLength(1);
    expect(summary.unknownModels[0]?.sourceModelID).toBe("cursor-acp/unknown-future-model");
  });

  it("keeps legacy cursor-acp history readable", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([
      {
        role: "assistant",
        providerID: "cursor-acp",
        modelID: "cursor-acp/composer-1",
        tokens: { input: 1_000_000, output: 500_000, cache: { read: 0, write: 0 } },
      },
    ]);

    const summary = await getCurrentCursorUsageSummary({
      nowMs: new Date(2026, 2, 19, 10, 0, 0, 0).getTime(),
      billingCycleStartDay: 7,
    });

    expect(summary.autoComposer.messageCount).toBe(1);
    expect(summary.api.messageCount).toBe(0);
    expect(summary.unknownModels).toEqual([]);
  });

  it("treats new Cursor official fallback aliases as api usage instead of unknown models", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([
      {
        role: "assistant",
        providerID: "cursor",
        modelID: "cursor/gpt-5.3-codex-spark-preview",
        tokens: { input: 1_000_000, output: 1_000_000, cache: { read: 0, write: 0 } },
      },
    ]);

    const summary = await getCurrentCursorUsageSummary({
      nowMs: new Date(2026, 2, 19, 10, 0, 0, 0).getTime(),
      billingCycleStartDay: 7,
    });

    expect(summary.autoComposer.messageCount).toBe(0);
    expect(summary.api.messageCount).toBe(1);
    expect(summary.api.costUsd).toBeCloseTo(15.75, 6);
    expect(summary.unknownModels).toEqual([]);
  });
});
