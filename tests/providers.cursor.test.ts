import { describe, expect, it, vi } from "vite-plus/test";
import { cursorProvider } from "../src/providers/cursor.js";
import {
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: vi.fn(),
}));

vi.mock("../src/lib/cursor-detection.js", () => ({
  CURSOR_CANONICAL_PLUGIN_PACKAGE: "@playwo/opencode-cursor-oauth",
  inspectCursorAuthPresence: vi.fn(async () => ({
    state: "missing",
    presentPaths: [],
    candidatePaths: [],
  })),
  inspectCursorOpenCodeIntegration: vi.fn(async () => ({
    pluginEnabled: false,
    providerConfigured: false,
    matchedPaths: [],
    checkedPaths: [],
  })),
}));

vi.mock("../src/lib/cursor-usage.js", () => ({
  getCurrentCursorUsageSummary: vi.fn(),
}));

const resetTimeIso = "2026-03-01T00:00:00.000Z";

function usageSummary(params: {
  apiCost: number;
  apiMessages: number;
  autoCost?: number;
  autoMessages?: number;
  unknownModels?: Array<Record<string, unknown>>;
}): any {
  const autoCost = params.autoCost ?? 0;
  const autoMessages = params.autoMessages ?? 0;
  return {
    window: { resetTimeIso },
    api: { costUsd: params.apiCost, tokens: {}, messageCount: params.apiMessages },
    autoComposer: { costUsd: autoCost, tokens: {}, messageCount: autoMessages },
    total: {
      costUsd: params.apiCost + autoCost,
      tokens: {},
      messageCount: params.apiMessages + autoMessages,
    },
    unknownModels: params.unknownModels ?? [],
  };
}

describe("cursor provider", () => {
  it("returns attempted:false when there is no usage and no configured included budget", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 0, apiMessages: 0 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "none" },
    } as any);
    expectNotAttempted(out);
  });

  it("maps complete API coverage to a named budget percentage with USD basis", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 5, apiMessages: 2, autoCost: 1.25, autoMessages: 1 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        name: "Cursor API (Pro)",
        group: "Cursor (Pro)",
        percentRemaining: 75,
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "API" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: "5", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
          limit: {
            quantity: { decimal: "20", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
          remaining: {
            quantity: { decimal: "15", unit: { kind: "currency", code: "USD" } },
            authority: "locally_derived",
          },
        },
      },
      {
        kind: "quantity",
        name: "cursor-auto-composer-spend",
        group: "Cursor (Pro)",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Auto+Composer" },
          prominence: "supplementary",
        },
        quantity: { decimal: "1.25", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.entries[0]?.accounting.resultType).toBe("budget");
    expect(out.entries[1]?.accounting.resultType).toBe("spend");
    expect(out.entries.every((entry) => !("right" in entry))).toBe(true);
    expect(out.entries.every((entry) => !("barValue" in entry))).toBe(true);
    expect(out.entries.every((entry) => entry.kind !== "value")).toBe(true);
    expect(out.presentation).toBeUndefined();
  });

  it("attaches fixed-window evidence only to explicitly configured billing cycles", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    const observedAtMs = Date.parse("2026-02-15T12:00:00.000Z");
    const configured = usageSummary({ apiCost: 5, apiMessages: 2 });
    configured.window = {
      source: "configured_day",
      sinceMs: Date.parse("2026-02-01T00:00:00.000Z"),
      untilMs: Date.parse(resetTimeIso),
      resetTimeIso,
    };
    configured.observedAtMs = observedAtMs;
    (getCurrentCursorUsageSummary as any).mockResolvedValueOnce(configured);

    const supported = await cursorProvider.fetch({
      config: { cursorPlan: "pro", cursorBillingCycleStartDay: 1 },
    } as any);
    expect(supported.entries[0]).toMatchObject({
      fixedWindow: {
        kind: "fixed_window",
        startedAtIso: "2026-02-01T00:00:00.000Z",
        observedAtIso: "2026-02-15T12:00:00.000Z",
        endsAtIso: resetTimeIso,
        fullReset: true,
      },
    });

    const inferred = usageSummary({ apiCost: 5, apiMessages: 2 });
    inferred.window = {
      source: "calendar_month",
      sinceMs: Date.parse("2026-02-01T00:00:00.000Z"),
      untilMs: Date.parse(resetTimeIso),
      resetTimeIso,
    };
    inferred.observedAtMs = observedAtMs;
    (getCurrentCursorUsageSummary as any).mockResolvedValueOnce(inferred);
    const unsupported = await cursorProvider.fetch({ config: { cursorPlan: "pro" } } as any);
    expect(unsupported.entries[0]).not.toHaveProperty("fixedWindow");
  });

  it("marks an explicit included-API override as user configured", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 2, apiMessages: 1 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro", cursorIncludedApiUsd: 10 },
    } as any);

    expect(out.entries[0]).toMatchObject({
      percentRemaining: 80,
      basis: {
        limit: {
          quantity: { decimal: "10", unit: { kind: "currency", code: "USD" } },
          authority: "user_configured",
        },
      },
    });
  });

  it("preserves negative remaining percent while keeping remaining basis non-negative", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 25, apiMessages: 2 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({
      percentRemaining: -25,
      basis: {
        remaining: {
          quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
          authority: "locally_derived",
        },
      },
    });
  });

  it("maps complete no-allowance coverage to named API cycle spend", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 0.5, apiMessages: 1, autoCost: 1.25, autoMessages: 1 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "none" },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        kind: "quantity",
        name: "cursor-api-spend",
        group: "Cursor",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "API" },
          prominence: "primary",
        },
        quantity: { decimal: "0.5", unit: { kind: "currency", code: "USD" } },
      },
      {
        kind: "quantity",
        name: "cursor-auto-composer-spend",
        group: "Cursor",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Auto+Composer" },
          prominence: "supplementary",
        },
        quantity: { decimal: "1.25", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.entries.every((entry) => entry.accounting.resultType === "spend")).toBe(true);
  });

  it("maps partial model coverage to Known API spend and preserves the partial error", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({
        apiCost: 2,
        apiMessages: 1,
        unknownModels: [{ sourceModelID: "cursor/future-model", messageCount: 1, tokens: {} }],
      }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro" },
    } as any);

    expect(visibleEntries(out.entries, "cursor")).toEqual([
      {
        kind: "quantity",
        name: "cursor-known-api-spend",
        group: "Cursor (Pro)",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Known API" },
          prominence: "primary",
        },
        quantity: { decimal: "2", unit: { kind: "currency", code: "USD" } },
      },
      {
        kind: "quantity",
        name: "cursor-auto-composer-spend",
        group: "Cursor (Pro)",
        resetTimeIso,
        semantic: {
          metric: { kind: "named", name: "Auto+Composer" },
          prominence: "supplementary",
        },
        quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
      },
    ]);
    expect(out.entries[0]?.accounting.resultType).toBe("spend");
    expect(out.errors[0]?.label).toBe("Cursor");
    expect(out.errors[0]?.message).toContain("Unknown Cursor model ids");
  });

  it("treats a zero allowance as API spend instead of a percentage", async () => {
    const { getCurrentCursorUsageSummary } = await import("../src/lib/cursor-usage.js");
    (getCurrentCursorUsageSummary as any).mockResolvedValue(
      usageSummary({ apiCost: 0, apiMessages: 1 }),
    );

    const out = await cursorProvider.fetch({
      config: { cursorPlan: "pro", cursorIncludedApiUsd: 0 },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({
      kind: "quantity",
      semantic: {
        metric: { kind: "named", name: "API" },
        prominence: "primary",
      },
      quantity: { decimal: "0", unit: { kind: "currency", code: "USD" } },
    });
    expect(out.entries[0]).not.toHaveProperty("percentRemaining");
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
