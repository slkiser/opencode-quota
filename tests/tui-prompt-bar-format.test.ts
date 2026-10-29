import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AccountingMetadata, QuotaToastEntry } from "../src/lib/entries.js";
import {
  formatPromptBarIdentityLabel,
  formatPromptBarPercentMeta,
  PROMPT_BAR_MAX_LABEL_WIDTH,
  PROMPT_BAR_WIDTH,
  pickPromptBarEntry,
  resolvePromptBarLabel,
} from "../src/lib/tui-prompt-bar-format.js";

const RATE_LIMIT = {
  resultType: "rate_limit",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const satisfies AccountingMetadata;

function percentEntry(
  entry: Omit<Extract<QuotaToastEntry, { percentRemaining: number }>, "accounting"> & {
    accounting?: AccountingMetadata;
  },
): QuotaToastEntry {
  return {
    accounting: RATE_LIMIT,
    ...entry,
  };
}

function renderData(entries: QuotaToastEntry[]) {
  return { entries, errors: [] };
}

describe("prompt-bar identity format", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the fill at a fixed 12 cells", () => {
    expect(PROMPT_BAR_WIDTH).toBe(12);
  });

  it("renders OpenAI 5h instead of a window-only label", () => {
    expect(
      formatPromptBarIdentityLabel({
        name: "OpenAI 5h",
        group: "OpenAI",
        label: "5h:",
      }),
    ).toBe("OpenAI 5h");
  });

  it("labels Anthropic Fable from the stripped label instead of Weekly", () => {
    expect(
      formatPromptBarIdentityLabel({
        name: "Claude Fable Weekly",
        group: "Claude",
        label: "Fable:",
      }),
    ).toBe("Claude Fable");
  });

  it("retains Cursor API from a named semantic percent metric", () => {
    expect(
      formatPromptBarIdentityLabel({
        name: "Cursor API",
        group: "Cursor",
        semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
      }),
    ).toBe("Cursor API");
  });

  it("keeps duplicate account and group names distinguishable", () => {
    expect(
      formatPromptBarIdentityLabel({
        name: "OpenAI 5h",
        group: "OpenAI (work)",
        label: "5h:",
      }),
    ).toBe("OpenAI (work) 5h");
    expect(
      formatPromptBarIdentityLabel({
        name: "OpenAI 5h",
        group: "OpenAI (personal)",
        label: "5h:",
      }),
    ).toBe("OpenAI (personal) 5h");
    expect(
      formatPromptBarIdentityLabel({
        name: "[Google AGY] (abc…) 5h",
        label: "5h:",
      }),
    ).toBe("Google AGY (abc…) 5h");
  });

  it("truncates long labels with an ellipsis instead of dropping the provider", () => {
    const longGroup = "Alibaba Personal Token Plan With An Extremely Long Account Title";
    const fitted = formatPromptBarIdentityLabel(
      {
        name: `${longGroup} Weekly`,
        group: longGroup,
        label: "Weekly:",
      },
      24,
    );

    expect(fitted).toContain("…");
    expect(fitted).toContain("Weekly");
    expect(fitted.startsWith("Alibaba")).toBe(true);
    expect(fitted).not.toBe("Weekly");
    expect(fitted.length).toBeLessThanOrEqual(24);

    const narrow = formatPromptBarIdentityLabel(
      {
        name: `${longGroup} Weekly`,
        group: longGroup,
        label: "Weekly:",
      },
      8,
    );
    expect(narrow).toContain("…");
    expect(narrow.startsWith("A")).toBe(true);
    expect(narrow).not.toBe("Weekly");
    expect(narrow.length).toBeLessThanOrEqual(8);

    const bounded = formatPromptBarIdentityLabel({
      name: `${longGroup} 5h`,
      group: longGroup,
      label: "5h:",
    });
    expect(bounded.length).toBeLessThanOrEqual(PROMPT_BAR_MAX_LABEL_WIDTH);
    expect(bounded).toContain("…");
    expect(bounded).toContain("5h");
  });

  it("strips control characters from provider identity", () => {
    expect(
      formatPromptBarIdentityLabel({
        name: "OpenAI\n5h",
        group: "Open\u0007AI",
        label: "5h:",
      }),
    ).toBe("OpenAI 5h");
  });

  it("keeps used/remaining percent and reset metadata beside the identity label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T10:00:00.000Z"));

    expect(
      formatPromptBarPercentMeta({
        percentRemaining: 50,
        percentDisplayMode: "remaining",
        resetTimeIso: "2026-01-17T15:14:00.000Z",
        runway: {
          kind: "before_reset",
          projectedAtIso: "2026-01-15T11:50:00.000Z",
        },
      }),
    ).toBe("50% | 2d5h14m | r/o ≈ 1h 50m");

    expect(
      formatPromptBarPercentMeta({
        percentRemaining: 81,
        percentDisplayMode: "used",
        resetTimeIso: "2026-01-17T15:14:00.000Z",
        resetTimeSpaced: true,
      }),
    ).toBe("19% | 2d 5h 14m");
  });
});

describe("prompt-bar selection identity", () => {
  it("selects legacy five-hour windows with a provider label", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({ name: "Copilot weekly", percentRemaining: 4 }),
        percentEntry({
          name: "Copilot 5h",
          percentRemaining: 72,
          resetTimeIso: "2026-08-09T12:00:00Z",
        }),
      ]),
    );

    expect(entry).toEqual({
      identityLabel: "Copilot 5h",
      name: "Copilot 5h",
      percentRemaining: 72,
      resetTimeIso: "2026-08-09T12:00:00Z",
      accounting: RATE_LIMIT,
    });
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Copilot 5h");
  });

  it("keeps provider identity on fallback lowest-percentage selection", () => {
    const entry = pickPromptBarEntry(
      renderData([
        { kind: "value", accounting: RATE_LIMIT, name: "Balance", value: "$10" },
        percentEntry({ name: "Copilot weekly", percentRemaining: 44 }),
        percentEntry({ name: "Copilot monthly", percentRemaining: 18 }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Copilot Monthly");
    expect(entry?.percentRemaining).toBe(18);
  });

  it("selects weekly-only Alibaba Token Plan with the provider name", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Alibaba Personal Token Plan Weekly",
          group: "Alibaba Personal Token Plan",
          label: "Weekly:",
          percentRemaining: 37,
        }),
      ]),
    );

    expect(entry).toMatchObject({
      identityLabel: "Alibaba Personal Token Plan Weekly",
      group: "Alibaba Personal Token Plan",
      percentRemaining: 37,
    });
  });

  it("keeps OpenCode Go identity when preferring 5h over an exhausted sibling", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "OpenCode Go 5h",
          group: "OpenCode Go",
          label: "5h:",
          percentRemaining: 83,
        }),
        percentEntry({
          name: "OpenCode Go Weekly",
          group: "OpenCode Go",
          label: "Weekly:",
          percentRemaining: 0,
        }),
        percentEntry({
          name: "OpenCode Go Monthly",
          group: "OpenCode Go",
          label: "Monthly:",
          percentRemaining: 9,
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("OpenCode Go 5h");
    expect(entry?.percentRemaining).toBe(83);
    expect(entry?.accounting?.acquisitionMethod).toBe("remote_api");
  });

  it("selects exhausted OpenCode Go weekly when 5h is filtered out", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "OpenCode Go Weekly",
          group: "OpenCode Go",
          label: "Weekly:",
          percentRemaining: 0,
        }),
        percentEntry({
          name: "OpenCode Go Monthly",
          group: "OpenCode Go",
          label: "Monthly:",
          percentRemaining: 9,
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("OpenCode Go Weekly");
    expect(entry?.percentRemaining).toBe(0);
  });

  it("keeps duplicate account identity on the selected 5h window", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "OpenAI 5h",
          group: "OpenAI (work)",
          label: "5h:",
          percentRemaining: 11,
        }),
        percentEntry({
          name: "OpenAI 5h",
          group: "OpenAI (personal)",
          label: "5h:",
          percentRemaining: 40,
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("OpenAI (work) 5h");
    expect(entry?.group).toBe("OpenAI (work)");
  });

  it("labels the remaining provider after current-model filtering", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Copilot 5h",
          group: "Copilot",
          label: "5h:",
          percentRemaining: 18,
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Copilot 5h");
    expect(resolvePromptBarLabel(entry ?? {})).not.toBe("5h");
  });

  it("uses provider plus window for semantic percent rows", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "OpenAI 5h",
          group: "OpenAI",
          label: "5h:",
          percentRemaining: 40,
          semantic: { metric: { kind: "window", window: "five_hour" }, prominence: "primary" },
        }),
        percentEntry({
          name: "OpenAI Weekly",
          group: "OpenAI",
          label: "Weekly:",
          percentRemaining: 90,
          semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("OpenAI 5h");
    expect(entry?.semanticSegment).toBeUndefined();
    expect(resolvePromptBarLabel(entry ?? {})).toBe("OpenAI 5h");
  });

  it("selects the first primary semantic percent before a later 5h row", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Cursor API",
          group: "Cursor",
          percentRemaining: 90,
          semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
        }),
        percentEntry({
          name: "Copilot 5h",
          percentRemaining: 10,
          resetTimeIso: "2026-08-09T12:00:00Z",
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Cursor API");
    expect(entry?.percentRemaining).toBe(90);
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Cursor API");
  });

  it("still publishes non-percent semantic values", () => {
    const entry = pickPromptBarEntry(
      renderData([
        {
          kind: "quantity",
          accounting: {
            resultType: "spend",
            acquisitionMethod: "local_runtime_accounting",
            ownership: "maintained",
            authority: "locally_derived",
          },
          name: "known-api-spend",
          group: "Cursor",
          semantic: { metric: { kind: "named", name: "Known API" }, prominence: "primary" },
          quantity: { decimal: "12.5", unit: { kind: "currency", code: "USD" } },
        },
      ]),
    );

    expect(entry).toEqual({
      semanticSegment: "Cursor: Known API spend USD 12.50",
    });
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Cursor: Known API spend USD 12.50");
  });

  it("prefers the urgent runway percent while keeping provider identity", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "OpenAI 5h",
          group: "OpenAI",
          label: "5h:",
          percentRemaining: 80,
          runway: { kind: "lasts_past_reset" },
        }),
        percentEntry({
          name: "OpenAI Weekly",
          group: "OpenAI",
          label: "Weekly:",
          percentRemaining: 20,
          resetTimeIso: "2026-01-17T15:14:00.000Z",
          runway: {
            kind: "before_reset",
            projectedAtIso: "2026-01-15T11:50:00.000Z",
          },
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("OpenAI Weekly");
    expect(entry?.percentRemaining).toBe(20);
    expect(entry?.runway).toEqual({
      kind: "before_reset",
      projectedAtIso: "2026-01-15T11:50:00.000Z",
    });
  });

  it("labels Anthropic Fable alone instead of a generic weekly window", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Claude Fable Weekly",
          group: "Claude",
          label: "Fable:",
          percentRemaining: 98,
          semantic: { metric: { kind: "named", name: "Fable weekly" }, prominence: "primary" },
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Claude Fable");
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Claude Fable");
    expect(resolvePromptBarLabel(entry ?? {})).not.toBe("Claude Weekly");
  });

  it("keeps Claude Fable when that row is selected via urgent runway", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Claude 5h",
          group: "Claude",
          label: "5h:",
          percentRemaining: 80,
          runway: { kind: "lasts_past_reset" },
        }),
        percentEntry({
          name: "Claude Weekly",
          group: "Claude",
          label: "Weekly:",
          percentRemaining: 40,
          runway: { kind: "lasts_past_reset" },
        }),
        percentEntry({
          name: "Claude Fable Weekly",
          group: "Claude",
          label: "Fable:",
          percentRemaining: 10,
          resetTimeIso: "2026-01-17T15:14:00.000Z",
          semantic: { metric: { kind: "named", name: "Fable weekly" }, prominence: "primary" },
          runway: {
            kind: "before_reset",
            projectedAtIso: "2026-01-15T11:50:00.000Z",
          },
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Claude Fable");
    expect(entry?.percentRemaining).toBe(10);
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Claude Fable");
    expect(resolvePromptBarLabel(entry ?? {})).not.toBe("Claude Weekly");
  });

  it("retains API on a Cursor named percent metric", () => {
    const entry = pickPromptBarEntry(
      renderData([
        percentEntry({
          name: "Cursor API",
          group: "Cursor",
          percentRemaining: 25,
          semantic: { metric: { kind: "named", name: "API" }, prominence: "primary" },
        }),
      ]),
    );

    expect(entry?.identityLabel).toBe("Cursor API");
    expect(resolvePromptBarLabel(entry ?? {})).toBe("Cursor API");
    expect(resolvePromptBarLabel(entry ?? {})).toContain("API");
  });
});
