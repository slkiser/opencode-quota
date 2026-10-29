import { describe, expect, it } from "vite-plus/test";
import {
  buildSidebarContentRows,
  collectSidebarHeadingLines,
  formatSidebarHeading,
  formatSidebarHeadingSegments,
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

describe("sidebar content rows", () => {
  it("keeps the collapsed provider suffix on one heading as a muted segment", () => {
    const heading = {
      collapsed: true,
      heading: "Quota",
      hasDetailLines: true,
      providerCount: 3,
    };
    expect(formatSidebarHeading(heading)).toBe("▶ Quota (3 providers)");
    expect(formatSidebarHeadingSegments(heading)).toEqual([
      { text: "▶ Quota", style: "title" },
      { text: " (3 providers)", style: "muted" },
    ]);
  });

  it("replaces the collapsed heading with one expanded heading and no leftover suffix", () => {
    const collapsed = panelRows(true);
    const expanded = panelRows(false);
    const collapsedFrame = renderSidebarContentFrame(collapsed);
    const expandedFrame = renderSidebarContentFrame(expanded);

    expect(collapsed.filter((row) => row.kind === "header")).toHaveLength(1);
    expect(expanded.filter((row) => row.kind === "header")).toHaveLength(1);
    expect(collectSidebarHeadingLines(collapsedFrame)).toEqual(["▶ Quota (3 providers)"]);
    expect(collectSidebarHeadingLines(expandedFrame)).toEqual(["▼ Quota"]);
    expect(expanded[0]?.segments).toEqual([{ text: "▼ Quota", style: "title" }]);
    expect(expanded[0]?.text).toBe("▼ Quota");
    expect(expandedFrame).not.toContain("▶");
    expect(expandedFrame).not.toContain("providers");
    expect(collapsedFrame).not.toContain("▼");
    expect(collapsed[0]?.text.endsWith(" ")).toBe(false);
    expect(expanded[0]?.text.endsWith(" ")).toBe(false);
  });

  it("drops expanded body rows when collapsing back to the summary heading", () => {
    const collapsedFrame = renderSidebarContentFrame(panelRows(true));
    expect(collapsedFrame).not.toContain("[Copilot]");
    expect(collectSidebarHeadingLines(collapsedFrame)).toEqual(["▶ Quota (3 providers)"]);
  });

  it("keeps expand/collapse aligned when collapsed overflow is explicit", () => {
    const heading = {
      collapsed: true,
      heading: "Quota",
      hasDetailLines: true,
      providerCount: 2,
    };
    const collapsed = buildSidebarContentRows({
      ...heading,
      lines: ["Copilot 5% | +1"],
    });
    const expanded = buildSidebarContentRows({
      ...heading,
      collapsed: false,
      lines: ["[Copilot]", "Quota 95%", "[OpenAI ChatGPT Plus Plan]", "5h window 19%"],
    });

    expect(formatSidebarHeading(heading)).toBe("▶ Quota (2 providers)");
    expect(collectSidebarHeadingLines(renderSidebarContentFrame(collapsed))).toEqual([
      "▶ Quota (2 providers)",
    ]);
    expect(collectSidebarHeadingLines(renderSidebarContentFrame(expanded))).toEqual(["▼ Quota"]);
    expect(renderSidebarContentFrame(collapsed)).toContain("Copilot 5% | +1");
    expect(renderSidebarContentFrame(collapsed)).not.toContain("81%");
    expect(renderSidebarContentFrame(expanded)).toContain("[OpenAI ChatGPT Plus Plan]");
    expect(renderSidebarContentFrame(expanded)).not.toContain("+1");
  });
});
