import { describe, expect, it } from "vitest";

import {
  buildSessionTokenSectionModel,
  renderSessionTokensLines,
  renderSidebarSessionTokenSummaryLines,
  SESSION_TOKEN_SECTION_HEADING,
  WIDE_SESSION_TOKEN_LINE_WIDTH,
} from "../src/lib/session-tokens-format.js";

describe("renderSessionTokensLines", () => {
  it("keeps the existing wide row layout when width allows it", () => {
    const lines = renderSessionTokensLines({
      models: [{ modelID: "openai/gpt-5", input: 1234, output: 567 }],
      totalInput: 1234,
      totalOutput: 567,
    });

    expect(lines).toEqual([
      SESSION_TOKEN_SECTION_HEADING,
      "  openai/gpt-5            1.2K in     567 out",
    ]);
    expect(lines[1]?.length).toBe(WIDE_SESSION_TOKEN_LINE_WIDTH);
  });

  it("abbreviates antigravity model names before shortening", () => {
    const section = buildSessionTokenSectionModel({
      models: [{ modelID: "antigravity-super-very-long-model", input: 1234, output: 567 }],
      totalInput: 1234,
      totalOutput: 567,
    });

    expect(section?.lines[0]).toContain("agy-super-very-long…");
    expect(section?.lines[0]).not.toContain("antigravity");
    expect(section?.lines[0]?.slice(2, 22).length).toBe(20);
  });

  it("switches to a compact layout when maxWidth is narrow", () => {
    const lines = renderSessionTokensLines(
      {
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
        totalInput: 372,
        totalOutput: 41,
      },
      { maxWidth: 36 },
    );

    expect(lines.every((line) => line.length <= 36)).toBe(true);
    expect(lines).toEqual([
      SESSION_TOKEN_SECTION_HEADING.slice(0, 36),
      "  openai/gpt-5.4-mini",
      "    372 in  41 out",
    ]);
  });

  it("builds a reusable detailed section model without duplicating the heading in body rows", () => {
    const section = buildSessionTokenSectionModel({
      models: [{ modelID: "openai/gpt-5", input: 1234, output: 567 }],
      totalInput: 1234,
      totalOutput: 567,
    });

    expect(section).toEqual({
      heading: SESSION_TOKEN_SECTION_HEADING,
      lines: ["  openai/gpt-5            1.2K in     567 out"],
    });
  });

  it("renders separate new and cached input when cache data is present", () => {
    const lines = renderSessionTokensLines({
      models: [
        {
          modelID: "openai/gpt-5",
          input: 1234,
          cachedInput: 456,
          totalInput: 1690,
          output: 567,
        },
      ],
      totalInput: 1234,
      totalCachedInput: 456,
      totalCombinedInput: 1690,
      totalOutput: 567,
    });

    expect(lines).toEqual([
      SESSION_TOKEN_SECTION_HEADING,
      "  openai/gpt-5          1.2K (456) in     567 out",
    ]);
  });

  it("switches to compact layout when cached input would overflow maxWidth", () => {
    const lines = renderSessionTokensLines(
      {
        models: [
          {
            modelID: "openai/gpt-5",
            input: 1234,
            cachedInput: 456,
            totalInput: 1690,
            output: 567,
          },
        ],
        totalInput: 1234,
        totalCachedInput: 456,
        totalCombinedInput: 1690,
        totalOutput: 567,
      },
      { maxWidth: WIDE_SESSION_TOKEN_LINE_WIDTH },
    );

    expect(lines.every((line) => line.length <= WIDE_SESSION_TOKEN_LINE_WIDTH)).toBe(true);
    expect(lines).toEqual([
      SESSION_TOKEN_SECTION_HEADING,
      "  openai/gpt-5",
      "    1.2K (456) in  567 out",
    ]);
  });
});

describe("renderSidebarSessionTokenSummaryLines", () => {
  it("renders a one-line aggregate sidebar summary under the shared heading", () => {
    const lines = renderSidebarSessionTokenSummaryLines(
      {
        models: [{ modelID: "openai/gpt-5.4-mini", input: 372, output: 41 }],
        totalInput: 372,
        totalOutput: 41,
      },
      { maxWidth: 36 },
    );

    expect(lines).toEqual([SESSION_TOKEN_SECTION_HEADING.slice(0, 36), "  372 in  41 out"]);
    expect(lines.every((line) => line.length <= 36)).toBe(true);
  });

  it("renders aggregate new and cached input in the sidebar summary when cache data exists", () => {
    const lines = renderSidebarSessionTokenSummaryLines(
      {
        models: [
          {
            modelID: "openai/gpt-5.4-mini",
            input: 372,
            cachedInput: 120,
            totalInput: 492,
            output: 41,
          },
        ],
        totalInput: 372,
        totalCachedInput: 120,
        totalCombinedInput: 492,
        totalOutput: 41,
      },
      { maxWidth: 80 },
    );

    expect(lines).toEqual([SESSION_TOKEN_SECTION_HEADING, "  372 (120) in  41 out"]);
  });
});
