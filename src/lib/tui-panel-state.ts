import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";

const SIDEBAR_LOADING_LINE = "Loading…";
const SIDEBAR_UNAVAILABLE_LINE = "Unavailable";
const COMPACT_LOADING_TEXT = "Quota loading…";

type PanelStatus = "loading" | "disabled" | "ready";

export type SidebarPanelState = {
  status: PanelStatus;
  lines: string[];
  linesExpanded?: string[];
  providerCount?: number;
};

export type CompactStatusState =
  | { status: "loading"; text?: string }
  | { status: "disabled"; text?: string }
  | { status: "ready"; text: string };

export function shouldRenderSidebarPanel(panel: SidebarPanelState): boolean {
  return panel.status !== "disabled";
}

export function getSidebarPanelLines(panel: SidebarPanelState): string[] {
  if (panel.lines.length > 0) return panel.lines;

  switch (panel.status) {
    case "ready":
      return [SIDEBAR_UNAVAILABLE_LINE];
    case "loading":
      return [SIDEBAR_LOADING_LINE];
    default:
      return [];
  }
}

export function getSidebarPanelLinesExpanded(panel: SidebarPanelState): string[] {
  if (panel.linesExpanded && panel.linesExpanded.length > 0) return panel.linesExpanded;
  return getSidebarPanelLines(panel);
}

export function shouldRenderCompactStatus(panel: CompactStatusState): boolean {
  return panel.status !== "disabled";
}

export function getCompactStatusText(panel: CompactStatusState): string {
  if (panel.status === "disabled") return "";

  const text = sanitizeSingleLineDisplayText(panel.text ?? "");
  if (text) return text;

  return panel.status === "loading" ? COMPACT_LOADING_TEXT : "";
}
