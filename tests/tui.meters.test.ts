import { describe, expect, it } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { defaultSettings } from "../src/settings/schema.js";
import { segmentColor, type Theme } from "../src/tui/theme.js";
import { limitsLines } from "../src/tui/window/limits.js";
import { columnsOf } from "../src/view/columns.js";
import {
  barSegments,
  bigStatusLine,
  lineText,
  sidebarPanel,
  statusLayout,
  statusLineInput,
  toastInput,
  toastLines,
} from "../src/view/text.js";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { THEME } from "./helpers/jsx-tree.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    providerSnapshot(
      "anthropic",
      "Claude",
      [
        quotaRow("anthropic.five_hour", {
          label: "5h",
          window: "five_hour",
          percentRemaining: 57,
          resetsAt: new Date(NOW + 2 * 60 * 60_000).toISOString(),
        }),
      ],
      { okAtMs: NOW, checkedAtMs: NOW },
    ),
  ],
  resetNotices: [],
  generatedAtMs: NOW,
};

function quotaRows(
  display: ReturnType<typeof defaultSettings>,
  width: number,
  open: boolean,
): string[] {
  const panel = sidebarPanel(SNAPSHOT, display, { nowMs: NOW, width, open });
  return [panel.title, ...panel.lines.map(lineText)];
}

function statusText(
  display: ReturnType<typeof defaultSettings>,
  width: number,
  mode: "auto" | "bar",
) {
  const input = statusLineInput(SNAPSHOT, display, NOW);
  const layout = statusLayout(input, width, 0, mode);
  return layout.shown.map(lineText).join(display.layout.separator);
}

function toastText(display: ReturnType<typeof defaultSettings>, width: number): string[] {
  return toastLines(toastInput(SNAPSHOT, display, { nowMs: NOW, width })).map(lineText);
}

describe("TUI quota meters", () => {
  it("matches the documented 20-cell line and default/custom theme role examples", () => {
    const display = defaultSettings();
    display.layout.bar = "line";
    display.layout.barWidth = 20;
    display.layout.evenUse = false;
    const theme = THEME as unknown as Theme;
    const render = () =>
      [60, 40, 10].map((percent) => {
        const segments = barSegments("line", percent, 20, undefined, display.words);
        return [
          `5h ${segments.map((segment) => segment.text).join("")}  ${percent}% left`,
          ...segments.map((segment) => segmentColor(theme, display, segment)),
        ];
      });

    expect(render()).toEqual([
      ["5h ━━━━━━━━━━━━────────  60% left", "green", "muted"],
      ["5h ━━━━━━━━────────────  40% left", "yellow", "muted"],
      ["5h ━━──────────────────  10% left", "red", "muted"],
    ]);

    display.colors.good = "blue";
    display.colors.warning = "accent";
    display.colors.low = "red";
    display.colors.empty = "muted";
    expect(render()).toEqual([
      ["5h ━━━━━━━━━━━━────────  60% left", "blue", "muted"],
      ["5h ━━━━━━━━────────────  40% left", "accent", "muted"],
      ["5h ━━──────────────────  10% left", "red", "muted"],
    ]);
  });

  it("keeps the even-use marker in its own cell of the 20-cell example", () => {
    const display = defaultSettings();
    expect(
      lineText({ id: "example", segments: barSegments("line", 60, 20, 50, display.words) }),
    ).toBe("━━━━━━━━━━┃━────────");
  });

  it.each([
    { shape: "line", expected: "━━━━━━━━━━━━────────" },
    { shape: "blocks", expected: "████████████░░░░░░░░" },
    { shape: "shades", expected: "▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░" },
    { shape: "squares", expected: "■■■■■■■■■■■■□□□□□□□□" },
    { shape: "dots", expected: "●●●●●●●●●●●●○○○○○○○○" },
    { shape: "none", expected: "" },
  ] as const)("renders the documented 20-cell 60% $shape sample", ({ shape, expected }) => {
    const display = defaultSettings();
    expect(
      barSegments(shape, 60, 20, undefined, display.words)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(expected);
  });

  it("uses a thin segmented line by default across quota surfaces", () => {
    const display = defaultSettings();
    display.collapsed.window = { anthropic: "five_hour" };
    display.statusLine.window = { anthropic: "five_hour" };

    const surfaces = [
      quotaRows(display, 48, true).at(2) ?? "",
      quotaRows(display, 48, false).at(1) ?? "",
      statusText(display, 100, "auto"),
      lineText(bigStatusLine(statusLineInput(SNAPSHOT, display, NOW))!),
      ...toastText(display, 64).slice(1),
      ...toastText({ ...display, toast: { ...display.toast, layout: "detailed" } }, 64).filter(
        (line) => /[━─]/u.test(line),
      ),
      lineText(limitsLines({ snapshot: SNAPSHOT, display, nowMs: NOW, width: 100 })[1]!),
    ];

    for (const surface of surfaces) expect(surface).toMatch(/[━─]/u);
  });

  it("honors an explicit bar width on each bar renderer and clamps it to narrow rooms", () => {
    const display = defaultSettings();
    display.layout.bar = "blocks";
    display.layout.barWidth = 12;
    display.collapsed.window = { anthropic: "five_hour" };
    display.statusLine.window = { anthropic: "five_hour" };

    const expanded = quotaRows(display, 60, true).find((line) => line.includes("5h")) ?? "";
    const collapsed = quotaRows(display, 60, false).find((line) => line.includes("Claude")) ?? "";
    const status = statusText(display, 100, "bar");
    const narrowStatus = statusText(display, 24, "bar");
    const bigStatus = lineText(bigStatusLine(statusLineInput(SNAPSHOT, display, NOW))!);
    const grouped = toastText(display, 64).find((line) => line.includes("5h")) ?? "";
    const detailedDisplay = {
      ...display,
      toast: { ...display.toast, layout: "detailed" as const },
    };
    const detailed = toastText(detailedDisplay, 64).find((line) => /[█░]/u.test(line)) ?? "";
    const limits = lineText(
      limitsLines({ snapshot: SNAPSHOT, display, nowMs: NOW, width: 100 })[1]!,
    );

    const barCells = (line: string) => (line.match(/[█░┃]+/u)?.[0] ?? "").length;
    for (const [surface, line] of [
      ["expanded sidebar", expanded],
      ["collapsed sidebar", collapsed],
      ["status line", status],
      ["Home status line", bigStatus],
      ["grouped toast", grouped],
      ["detailed toast", detailed],
      ["Limits", limits],
    ]) {
      expect(barCells(line), surface).toBe(12);
    }
    expect(narrowStatus).toContain("57%");
    expect(columnsOf(narrowStatus)).toBeLessThanOrEqual(24);

    for (const line of [
      ...quotaRows(display, 24, true),
      ...quotaRows(display, 24, false),
      narrowStatus,
      lineText(bigStatusLine(statusLineInput(SNAPSHOT, display, NOW), 24)!),
      ...toastText(display, 24),
      ...toastText(detailedDisplay, 24),
      ...limitsLines({ snapshot: SNAPSHOT, display, nowMs: NOW, width: 24 }).map(lineText),
    ]) {
      expect(columnsOf(line)).toBeLessThanOrEqual(24);
    }
  });

  it("omits meters when disabled except for Limits' documented thin-line fallback", () => {
    const display = defaultSettings();
    display.layout.bar = "none";
    display.collapsed.window = { anthropic: "five_hour" };
    display.statusLine.window = { anthropic: "five_hour" };
    const detailedDisplay = {
      ...display,
      toast: { ...display.toast, layout: "detailed" as const },
    };
    const noMeter = [
      ...quotaRows(display, 24, true),
      ...quotaRows(display, 24, false),
      statusText(display, 24, "bar"),
      lineText(bigStatusLine(statusLineInput(SNAPSHOT, display, NOW), 24)!),
      ...toastText(display, 24),
      ...toastText(detailedDisplay, 24),
    ];
    const limits = limitsLines({ snapshot: SNAPSHOT, display, nowMs: NOW, width: 24 }).map(
      lineText,
    );

    for (const line of noMeter) {
      expect(line).not.toMatch(/[━─█░▓■□●○]/u);
      expect(columnsOf(line)).toBeLessThanOrEqual(24);
    }
    expect(limits.some((line) => /[━─]/u.test(line))).toBe(true);
    for (const line of limits) expect(columnsOf(line)).toBeLessThanOrEqual(24);
  });
});
