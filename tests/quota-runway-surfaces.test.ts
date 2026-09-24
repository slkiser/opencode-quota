import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuotaPercentEntry } from "../src/lib/entries.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import {
  buildSidebarQuotaPanelLines,
  TUI_SIDEBAR_MAX_WIDTH,
} from "../src/lib/tui-sidebar-format.js";

const NOW_ISO = "2026-09-09T10:00:00.000Z";
const RESET_ISO = "2026-09-09T12:00:00.000Z";

function percentEntry(overrides: Partial<QuotaPercentEntry> = {}): QuotaPercentEntry {
  return {
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      observedAtIso: NOW_ISO,
    },
    name: "OpenAI Five-hour",
    group: "OpenAI Account With A Very Long Provider Label",
    label: "Five-hour:",
    percentRemaining: 50,
    resetTimeIso: RESET_ISO,
    runway: { kind: "before_reset", projectedAtIso: "2026-09-09T11:50:00.000Z" },
    ...overrides,
  };
}

function data(entries: QuotaPercentEntry[]): QuotaRenderData {
  return { entries, errors: [] };
}

function renderToast(entries: QuotaPercentEntry[], percentDisplayMode: "remaining" | "used") {
  return formatQuotaRows({
    version: "test",
    style: "allWindows",
    layout: { maxWidth: 52, narrowAt: 42, tinyAt: 32 },
    entries,
    errors: [],
    percentDisplayMode,
  });
}

describe("quota runway production surfaces", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows exact full-label typography and keeps reset separate on /quota and toast", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const entries = [percentEntry()];

    const command = formatQuotaCommand({
      ...data(entries),
      generatedAtMs: Date.parse(NOW_ISO),
      percentDisplayMode: "remaining",
    });
    const toast = renderToast(entries, "remaining");

    for (const output of [command, toast]) {
      expect(output).toContain("Runs out");
      expect(output).toContain("≈ 1h 50m");
      expect(output).toContain("2h");
      expect(output).not.toContain("≈1h");
      expect(output).not.toContain("1h50m");
    }
    expect(command).toMatch(/reset 2h0m \| Runs out ≈ 1h 50m/u);
  });

  it("keeps the same runway in used and remaining modes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const entries = [percentEntry({ percentRemaining: 75 })];

    const remaining = renderToast(entries, "remaining");
    const used = renderToast(entries, "used");

    expect(remaining).toContain("75% left");
    expect(used).toContain("25% used");
    expect(remaining).toContain("Runs out  ≈ 1h 50m");
    expect(used).toContain("Runs out  ≈ 1h 50m");
  });

  it("keeps runway readable and bounded in the tiny toast layout", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));

    const tiny = formatQuotaRows({
      version: "test",
      style: "allWindows",
      layout: { maxWidth: 30, narrowAt: 42, tinyAt: 32 },
      entries: [percentEntry({ name: "OpenAI Five-hour", group: "OpenAI" })],
      errors: [],
      percentDisplayMode: "remaining",
    });

    expect(tiny).toContain("Runs out");
    expect(tiny).toContain("≈ 1h 50m");
    for (const line of tiny.split("\n")) expect([...line].length).toBeLessThanOrEqual(30);
  });

  it("wraps long provider/account labels without exceeding the 36-column sidebar", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));

    const lines = buildSidebarQuotaPanelLines({
      data: data([percentEntry()]),
      config: {
        formatStyle: "allWindows",
        percentDisplayMode: "remaining",
        quotaProjection: "runway",
      },
    });

    expect(lines.join("\n")).toContain("Runs out");
    expect(lines.join("\n")).toContain("≈ 1h 50m");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(TUI_SIDEBAR_MAX_WIDTH);
  });

  it("keeps the urgent window when a long provider identity exceeds compact widths", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const longProvider = "OpenAI Enterprise Account With A Very Long Identity";
    const entries = [
      percentEntry({
        name: "OpenAI Five-hour",
        group: longProvider,
        label: "5h:",
        runway: { kind: "before_reset", projectedAtIso: "2026-09-09T11:50:00.000Z" },
      }),
      percentEntry({
        name: "OpenAI Weekly",
        group: longProvider,
        label: "Weekly:",
        percentRemaining: 20,
        resetTimeIso: "2026-09-12T10:00:00.000Z",
        runway: { kind: "before_reset", projectedAtIso: "2026-09-09T10:30:00.000Z" },
      }),
    ];

    const wide = buildCompactQuotaStatusLine({
      data: data(entries),
      percentDisplayMode: "remaining",
      maxWidth: 200,
    });

    expect(wide).toContain("5h");
    expect(wide).toContain("7d");
    expect(wide).toContain("r/o ≈ 1h 50m");
    expect(wide).toContain("r/o ≈ 30m");

    for (const maxWidth of [50, 40, 36]) {
      const narrow = buildCompactQuotaStatusLine({
        data: data(entries),
        percentDisplayMode: "remaining",
        maxWidth,
      });

      expect(narrow.length).toBeLessThanOrEqual(maxWidth);
      expect(narrow).toContain("7d");
      expect(narrow).toContain("20%");
      expect(narrow).toContain("r/o ≈ 30m");
      expect(narrow).not.toContain("50%");
      expect(narrow).not.toContain("1h 50m");
    }
  });

  it("orders already exhausted ahead of future runway and supports lasts-past-reset compact text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const exhausted = percentEntry({
      name: "OpenAI Weekly",
      group: "OpenAI",
      label: "Weekly:",
      runway: { kind: "before_reset", projectedAtIso: "2026-09-09T09:59:00.000Z" },
    });
    const future = percentEntry({
      name: "OpenAI Five-hour",
      group: "OpenAI",
      label: "5h:",
      runway: { kind: "before_reset", projectedAtIso: "2026-09-09T10:30:00.000Z" },
    });
    const pastReset = percentEntry({
      name: "Qwen UTC day",
      group: "Qwen",
      label: "UTC day:",
      runway: { kind: "lasts_past_reset" },
    });

    const narrow = buildCompactQuotaStatusLine({
      data: data([future, exhausted]),
      percentDisplayMode: "remaining",
      maxWidth: 40,
    });
    const crossProvider = buildCompactQuotaStatusLine({
      data: data([
        future,
        { ...exhausted, name: "Qwen UTC day", group: "Qwen", label: "UTC day:" },
      ]),
      percentDisplayMode: "remaining",
      maxWidth: 40,
    });
    const lasts = buildCompactQuotaStatusLine({
      data: data([pastReset]),
      percentDisplayMode: "remaining",
      maxWidth: 100,
    });

    expect(narrow).toContain("7d");
    expect(narrow).toContain("r/o ≈ 0m");
    expect(crossProvider.startsWith("Qwen")).toBe(true);
    expect(crossProvider).toContain("r/o ≈ 0m");
    expect(lasts).toContain("r/o lasts past reset");
  });

  it("matches independent default-off outputs when entries have no projection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    const entries = [percentEntry({ runway: undefined })];
    const command = formatQuotaCommand({ ...data(entries), generatedAtMs: Date.parse(NOW_ISO) });

    expect({
      command: command.slice(command.indexOf("\n\n") + 2),
      toast: renderToast(entries, "remaining"),
      sidebar: buildSidebarQuotaPanelLines({
        data: data(entries),
        config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      }),
      compact: buildCompactQuotaStatusLine({
        data: data(entries),
        percentDisplayMode: "remaining",
        maxWidth: 100,
      }),
    }).toEqual({
      command:
        "→ [OpenAI Account With A Very Long Provider Label]\n  5h quota      █████░░░░░   50% left | reset 2h0m",
      toast:
        "[OpenAI Account With A Very Long Provider Label]\n5h                                              2h0m\n█████████████████████░░░░░░░░░░░░░░░░░░░░   50% left",
      sidebar: [
        "[OpenAI Account With A Very Long Pro",
        "5h                              2h0m",
        "█████████████░░░░░░░░░░░░   50% left",
      ],
      compact: "OpenAI Account With A Very Long Provider Label 50% 2h0m",
    });
  });
});
