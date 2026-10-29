import { describe, expect, it } from "vite-plus/test";

import { SESSION_TOKEN_SECTION_HEADING } from "../src/lib/session-tokens-format.js";
import { getSidebarBodyLineColor } from "../src/lib/tui-line-style.js";

describe("getSidebarBodyLineColor", () => {
  const theme = {
    text: "white",
    textMuted: "gray",
  };

  it("uses normal text color for the sidebar session-token heading", () => {
    expect(getSidebarBodyLineColor(SESSION_TOKEN_SECTION_HEADING, theme)).toBe("white");
  });

  it("keeps the heading highlighted when the rendered sidebar heading is width-clamped", () => {
    expect(getSidebarBodyLineColor(SESSION_TOKEN_SECTION_HEADING.slice(0, 18), theme)).toBe(
      "white",
    );
  });

  it("keeps non-heading sidebar lines muted", () => {
    expect(getSidebarBodyLineColor("Unavailable", theme)).toBe("gray");
  });
});
