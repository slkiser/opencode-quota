import { describe, expect, it } from "vite-plus/test";
import type {
  QuotaProviderPresentation,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import { projectQuotaProviderResults } from "../src/lib/quota-accounting-projection.js";

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

type LegacyPresentation = QuotaProviderPresentation & {
  classicDisplayName?: string;
  classicShowRight?: boolean;
};

function result(
  entries: QuotaToastEntry[],
  presentation?: LegacyPresentation,
): QuotaProviderResult {
  return {
    attempted: true,
    entries,
    errors: [],
    ...(presentation ? { presentation } : {}),
  };
}

describe("projectQuotaProviderResults", () => {
  it("selects semantic windows by exact source and result type while retaining non-window facts", () => {
    const projected = projectQuotaProviderResults(
      [
        result([
          {
            accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
            name: "A weekly quota",
            group: "Semantic",
            percentRemaining: 30,
            semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
          },
          {
            accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
            name: "A daily quota",
            group: "Semantic",
            percentRemaining: 30,
            semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
          },
          {
            accounting: {
              ...TEST_ACCOUNTING,
              resultType: "budget",
              sourceId: "account-a",
            },
            name: "A monthly budget",
            group: "Semantic",
            percentRemaining: 40,
            semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
          },
          {
            accounting: {
              ...TEST_ACCOUNTING,
              resultType: "budget",
              sourceId: "account-a",
            },
            name: "A yearly budget",
            group: "Semantic",
            percentRemaining: 20,
            semantic: { metric: { kind: "window", window: "year" }, prominence: "primary" },
          },
          {
            accounting: { ...TEST_ACCOUNTING, sourceId: "account-b" },
            name: "B daily quota",
            group: "Semantic",
            percentRemaining: 15,
            semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
          },
          {
            accounting: {
              ...TEST_ACCOUNTING,
              resultType: "spend",
              sourceId: "account-a",
            },
            name: "Known spend",
            group: "Semantic",
            percentRemaining: 90,
            semantic: { metric: { kind: "named", name: "Known API" }, prominence: "primary" },
          },
        ]),
      ],
      "singleWindow",
      "detailed",
    );

    expect(
      projected.map((entry) => ({
        resultType: entry.accounting.resultType,
        sourceId: entry.accounting.sourceId,
        metric: entry.semantic?.metric,
      })),
    ).toEqual([
      {
        resultType: "quota",
        sourceId: "account-a",
        metric: { kind: "window", window: "day" },
      },
      {
        resultType: "quota",
        sourceId: "account-b",
        metric: { kind: "window", window: "day" },
      },
      {
        resultType: "budget",
        sourceId: "account-a",
        metric: { kind: "window", window: "year" },
      },
      {
        resultType: "spend",
        sourceId: "account-a",
        metric: { kind: "named", name: "Known API" },
      },
    ]);
  });

  it("prefers a configured window for one result and preserves fallback and other results", () => {
    const openCodeGo = result([
      {
        accounting: TEST_ACCOUNTING,
        name: "OpenCode Go Five-hour",
        group: "OpenCode Go",
        percentRemaining: 98,
        semantic: { metric: { kind: "window", window: "five_hour" }, prominence: "primary" },
      },
      {
        accounting: TEST_ACCOUNTING,
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        percentRemaining: 53,
        semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
      },
      {
        accounting: TEST_ACCOUNTING,
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        percentRemaining: 33,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
      },
    ]);
    const other = result([
      {
        accounting: TEST_ACCOUNTING,
        name: "Other Weekly",
        group: "Other",
        percentRemaining: 80,
        semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
      },
      {
        accounting: TEST_ACCOUNTING,
        name: "Other Monthly",
        group: "Other",
        percentRemaining: 10,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
      },
    ]);

    const preferred = projectQuotaProviderResults([openCodeGo, other], "singleWindow", "summary", {
      preferredWindowsByResultIndex: new Map([[0, "five_hour"]]),
    });
    expect(
      preferred.map((entry) => ({
        group: entry.name,
        window: entry.semantic?.metric.kind === "window" ? entry.semantic.metric.window : null,
      })),
    ).toEqual([
      { group: "[OpenCode Go] 5h", window: "five_hour" },
      { group: "[Other] Monthly", window: "month" },
    ]);

    const unavailable = projectQuotaProviderResults([openCodeGo], "singleWindow", "summary", {
      preferredWindowsByResultIndex: new Map([[0, "year"]]),
    });
    expect(unavailable[0]?.semantic?.metric).toEqual({ kind: "window", window: "month" });

    expect(
      projectQuotaProviderResults([openCodeGo], "allWindows", "summary", {
        preferredWindowsByResultIndex: new Map([[0, "five_hour"]]),
      }).map((entry) => entry.semantic?.metric),
    ).toEqual([
      { kind: "window", window: "five_hour" },
      { kind: "window", window: "week" },
      { kind: "window", window: "month" },
    ]);
  });

  it("sorts only contiguous semantic runs and leaves legacy anchors fixed", () => {
    const entries: QuotaToastEntry[] = [
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
        kind: "quantity",
        name: "Balance",
        quantity: { decimal: "1", unit: { kind: "currency", code: "USD" } },
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "primary",
        },
      },
      {
        accounting: TEST_ACCOUNTING,
        name: "Quota",
        percentRemaining: 50,
        semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
      },
      {
        accounting: TEST_ACCOUNTING,
        kind: "value",
        name: "Legacy anchor",
        value: "ready",
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
        kind: "quantity",
        name: "Spend",
        quantity: { decimal: "2", unit: { kind: "currency", code: "USD" } },
        semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "usage" },
        kind: "quantity",
        name: "Usage",
        quantity: { decimal: "3", unit: { kind: "count", unit: "token" } },
        semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
      },
    ];

    expect(
      projectQuotaProviderResults([result(entries)], "allWindows", "detailed").map((e) => e.name),
    ).toEqual(["Quota", "Balance", "Legacy anchor", "Usage", "Spend"]);
  });

  it("honors canonical presentation precedence over live legacy fields", () => {
    const entry = {
      accounting: TEST_ACCOUNTING,
      name: "Entry Daily",
      label: "Daily:",
      right: "10 left",
      percentRemaining: 10,
    } satisfies QuotaToastEntry;

    const projected = projectQuotaProviderResults(
      [
        result([{ ...entry }], {
          classicDisplayName: "Legacy",
          classicShowRight: true,
        }),
        result([{ ...entry }], {
          singleWindowDisplayName: "Canonical",
          singleWindowShowRight: false,
          classicDisplayName: "Legacy",
          classicShowRight: true,
        }),
        result([{ ...entry }], {
          singleWindowDisplayName: "   ",
          classicDisplayName: "Legacy",
        }),
      ],
      "singleWindow",
      "summary",
    );

    expect(projected.map(({ name, right }) => ({ name, right }))).toEqual([
      { name: "[Legacy] Daily", right: "10 left" },
      { name: "[Canonical] Daily", right: undefined },
      { name: "[Entry Daily] Daily", right: undefined },
    ]);
  });

  it("filters semantic prominence by detail without filtering legacy facts", () => {
    const entries: QuotaToastEntry[] = [
      {
        accounting: TEST_ACCOUNTING,
        name: "Primary quota",
        percentRemaining: 50,
        semantic: { metric: { kind: "aggregate" }, prominence: "primary" },
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
        kind: "quantity",
        name: "Supplementary balance",
        quantity: { decimal: "12", unit: { kind: "currency", code: "USD" } },
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "supplementary",
        },
      },
      {
        accounting: TEST_ACCOUNTING,
        kind: "value",
        name: "Legacy status",
        value: "ready",
      },
    ];

    expect(
      projectQuotaProviderResults([result(entries)], "grouped", "summary").map((e) => e.name),
    ).toEqual(["Primary quota", "Legacy status"]);
    expect(
      projectQuotaProviderResults([result(entries)], "allWindows", "detailed").map((e) => e.name),
    ).toEqual(["Primary quota", "Supplementary balance", "Legacy status"]);
  });

  it("preserves legacy rows without bypassing semantic window reduction", () => {
    const projected = projectQuotaProviderResults(
      [
        result(
          [
            {
              accounting: TEST_ACCOUNTING,
              name: "Daily quota",
              percentRemaining: 50,
              semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
            },
            {
              accounting: TEST_ACCOUNTING,
              name: "Weekly quota",
              percentRemaining: 20,
              semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
            },
            {
              accounting: TEST_ACCOUNTING,
              name: "Legacy A",
              percentRemaining: 40,
            },
            {
              accounting: TEST_ACCOUNTING,
              kind: "value",
              name: "Legacy B",
              value: "ready",
            },
          ],
          { classicStrategy: "preserve" },
        ),
      ],
      "singleWindow",
      "summary",
    );

    expect(projected).toHaveLength(3);
    expect(projected.map((entry) => entry.semantic?.metric ?? entry.name)).toEqual([
      { kind: "window", window: "week" },
      "[Legacy A]",
      "[Legacy B]",
    ]);
  });

  it("removes non-finite semantic windows but preserves legacy non-finite selection", () => {
    const projected = projectQuotaProviderResults(
      [
        result([
          {
            accounting: TEST_ACCOUNTING,
            name: "Infinite semantic",
            percentRemaining: Number.POSITIVE_INFINITY,
            semantic: { metric: { kind: "window", window: "day" }, prominence: "primary" },
          },
          {
            accounting: TEST_ACCOUNTING,
            name: "Legacy NaN",
            percentRemaining: Number.NaN,
          },
          {
            accounting: TEST_ACCOUNTING,
            name: "Legacy finite",
            percentRemaining: 10,
          },
        ]),
      ],
      "singleWindow",
      "summary",
    );

    expect(projected).toHaveLength(1);
    expect(projected[0]?.name).toBe("[Legacy NaN]");
    expect(projected[0]).toHaveProperty("percentRemaining", Number.NaN);
  });

  it("partitions legacy rows by exact source identity once any source is defined", () => {
    const projected = projectQuotaProviderResults(
      [
        result([
          { accounting: TEST_ACCOUNTING, name: "Unscoped 50", percentRemaining: 50 },
          {
            accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
            name: "Scoped 20",
            percentRemaining: 20,
          },
          { accounting: TEST_ACCOUNTING, name: "Unscoped 10", percentRemaining: 10 },
          {
            accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
            name: "Scoped 30",
            percentRemaining: 30,
          },
        ]),
      ],
      "singleWindow",
      "summary",
    );

    expect(projected.map((entry) => entry.accounting.sourceId)).toEqual([undefined, "account-a"]);
    expect(
      projected.map((entry) => ("percentRemaining" in entry ? entry.percentRemaining : null)),
    ).toEqual([10, 20]);
  });

  it("suppresses redundant family text and keeps classic and singleWindow aliases equivalent", () => {
    const source = result(
      [
        {
          accounting: TEST_ACCOUNTING,
          name: "Provider: Claude",
          group: "Provider",
          label: "Claude:",
          metricLabel: "Claude",
          percentRemaining: 25,
        },
      ],
      { classicStrategy: "preserve", redundantQuotaFamily: " Claude " },
    );

    expect(projectQuotaProviderResults([source], "allWindows", "summary")).toEqual([
      {
        accounting: TEST_ACCOUNTING,
        name: "Provider",
        group: "Provider",
        label: undefined,
        metricLabel: "Quota",
        percentRemaining: 25,
      },
    ]);
    expect(projectQuotaProviderResults([source], "classic", "summary")).toEqual(
      projectQuotaProviderResults([source], "singleWindow", "summary"),
    );
  });

  it("returns fresh deep clones and leaves raw results unchanged", () => {
    const source = result([
      {
        accounting: { ...TEST_ACCOUNTING, sourceId: "account-a" },
        name: "Monthly quota",
        percentRemaining: 75,
        semantic: { metric: { kind: "window", window: "month" }, prominence: "primary" },
        basis: {
          remaining: {
            quantity: { decimal: "75", unit: { kind: "count", unit: "credit" } },
            authority: "provider_reported",
          },
        },
      },
      {
        accounting: { ...TEST_ACCOUNTING, resultType: "balance" },
        kind: "quantity",
        name: "Balance",
        quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
        semantic: {
          metric: { kind: "component", component: "total_balance" },
          prominence: "supplementary",
        },
      },
    ]);
    const snapshot = structuredClone(source);

    const first = projectQuotaProviderResults([source], "allWindows", "detailed");
    const percent = first[0];
    const quantity = first[1];
    if (
      !percent ||
      !("percentRemaining" in percent) ||
      !percent.semantic ||
      !percent.basis?.remaining
    ) {
      throw new Error("expected cloned percentage basis");
    }
    if (!quantity || quantity.kind !== "quantity") {
      throw new Error("expected cloned quantity");
    }
    percent.accounting.sourceId = "mutated";
    percent.semantic.metric = { kind: "aggregate" };
    percent.basis.remaining.quantity.decimal = "0";
    quantity.quantity.unit = { kind: "custom", symbol: "changed" };

    const second = projectQuotaProviderResults([source], "allWindows", "detailed");
    expect(source).toEqual(snapshot);
    expect(second).toEqual(snapshot.entries);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.accounting).not.toBe(first[0]?.accounting);
  });

  it("adds runway only after window selection and leaves default-off output unchanged", () => {
    const fixed = {
      accounting: TEST_ACCOUNTING,
      name: "Fixed Daily",
      label: "Daily:",
      percentRemaining: 55,
      resetTimeIso: "2026-09-09T05:00:00.000Z",
      fixedWindow: {
        kind: "fixed_window",
        startedAtIso: "2026-09-09T00:00:00.000Z",
        observedAtIso: "2026-09-09T01:30:00.000Z",
        endsAtIso: "2026-09-09T05:00:00.000Z",
        fullReset: true,
      },
    } as const satisfies QuotaToastEntry;
    const rolling = {
      accounting: TEST_ACCOUNTING,
      name: "Rolling Weekly",
      label: "Weekly:",
      percentRemaining: 80,
      resetTimeIso: "2026-09-10T00:00:00.000Z",
    } as const satisfies QuotaToastEntry;
    const source = result([fixed, rolling]);

    const disabled = projectQuotaProviderResults([source], "allWindows", "summary", {
      nowMs: Date.parse("2026-09-09T01:30:00.000Z"),
    });
    expect(disabled).toEqual([fixed, rolling]);
    expect(disabled.every((entry) => !("runway" in entry))).toBe(true);

    const allWindows = projectQuotaProviderResults([source], "allWindows", "summary", {
      quotaProjection: "runway",
      nowMs: Date.parse("2026-09-09T01:30:00.000Z"),
    });
    expect(allWindows[0]).toMatchObject({
      runway: { kind: "before_reset", projectedAtIso: "2026-09-09T03:20:00.000Z" },
    });
    expect(allWindows[1]).not.toHaveProperty("runway");

    const single = projectQuotaProviderResults([source], "singleWindow", "summary", {
      quotaProjection: "runway",
      nowMs: Date.parse("2026-09-09T01:30:00.000Z"),
    });
    expect(single).toHaveLength(1);
    expect(single[0]).toHaveProperty("runway.kind", "before_reset");
    expect(source.entries.every((entry) => !("runway" in entry))).toBe(true);
  });

  it("returns no entries for empty results and empty provider entry arrays", () => {
    expect(projectQuotaProviderResults([], "singleWindow", "summary")).toEqual([]);
    expect(projectQuotaProviderResults([result([])], "allWindows", "detailed")).toEqual([]);
  });
});
