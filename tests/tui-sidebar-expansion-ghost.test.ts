import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarContentRows,
  collectSidebarHeadingLines,
  renderSidebarContentFrame,
} from "../src/lib/tui-sidebar-content.js";

const COLLAPSED_LINES = ["Copilot 5% | OpenAI 81% | GLM 12%"];
const EXPANDED_LINES = [
  "[Copilot]",
  "Quota 95%",
  "[OpenAI]",
  "5h window 19%",
  "[GLM]",
  "Weekly 12%",
];

function panelRows(collapsed: boolean) {
  return buildSidebarContentRows({
    collapsed,
    heading: "Quota",
    hasDetailLines: true,
    providerCount: 3,
    lines: collapsed ? COLLAPSED_LINES : EXPANDED_LINES,
  });
}

describe("sidebar expansion heading rows", () => {
  it("keeps one header row and swaps title/suffix segments when expanding", () => {
    const collapsed = panelRows(true);
    expect(collapsed[0]).toMatchObject({
      kind: "header",
      text: "▶ Quota (3 providers)",
      segments: [
        { text: "▶ Quota", style: "title" },
        { text: " (3 providers)", style: "muted" },
      ],
    });
    expect(collapsed.map((row) => row.text)).toEqual(["▶ Quota (3 providers)", COLLAPSED_LINES[0]]);
    expect(collectSidebarHeadingLines(renderSidebarContentFrame(collapsed))).toEqual([
      "▶ Quota (3 providers)",
    ]);

    const expanded = panelRows(false);
    expect(expanded[0]).toMatchObject({
      kind: "header",
      text: "▼ Quota",
      segments: [{ text: "▼ Quota", style: "title" }],
    });
    expect(expanded.map((row) => row.text)).toEqual(["▼ Quota", ...EXPANDED_LINES]);
    expect(collectSidebarHeadingLines(renderSidebarContentFrame(expanded))).toEqual(["▼ Quota"]);
    expect(expanded[0]?.segments.some((segment) => segment.style === "muted")).toBe(false);
    expect(expanded[0]?.text).not.toContain("▶");
    expect(expanded[0]?.text).not.toContain("providers");

    const collapsedAgain = panelRows(true);
    expect(collapsedAgain.map((row) => row.text)).toEqual([
      "▶ Quota (3 providers)",
      COLLAPSED_LINES[0],
    ]);
    expect(collapsedAgain.map((row) => row.text).join("\n")).not.toContain("▼");
    expect(collapsedAgain.map((row) => row.text).join("\n")).not.toContain("[Copilot]");
    expect(collectSidebarHeadingLines(renderSidebarContentFrame(collapsedAgain))).toEqual([
      "▶ Quota (3 providers)",
    ]);
  });
});
