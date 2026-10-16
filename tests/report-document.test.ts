import { describe, expect, it } from "vite-plus/test";

import { renderPlainTextReport } from "../src/lib/report-document.js";

describe("renderPlainTextReport", () => {
  it("renders the heading, then sections and blocks with one blank line between them", () => {
    const out = renderPlainTextReport({
      heading: "# Report 16:00 29/09/2026",
      sections: [
        {
          id: "status",
          title: "status:",
          blocks: [
            {
              kind: "kv",
              rows: [
                { key: "enabled", value: "true" },
                { key: "providers", trailingColon: true },
                { key: "openai", value: "available", indent: 1 },
              ],
            },
            { kind: "lines", lines: ["note one", "note two"] },
          ],
        },
        { id: "notes", blocks: [{ kind: "lines", lines: ["note three"] }] },
      ],
    });

    expect(out).toBe(
      [
        "# Report 16:00 29/09/2026",
        "",
        "status:",
        "- enabled: true",
        "- providers:",
        "  - openai: available",
        "",
        "note one",
        "note two",
        "",
        "note three",
      ].join("\n"),
    );
  });

  it("keeps only sections with a title or a block that has content", () => {
    const out = renderPlainTextReport({
      sections: [
        { id: "empty", blocks: [{ kind: "lines", lines: [] }] },
        { id: "titled", title: "Title", blocks: [{ kind: "kv", rows: [] }] },
        {
          id: "mixed",
          blocks: [
            { kind: "kv", rows: [] },
            { kind: "lines", lines: ["kept"] },
          ],
        },
      ],
    });

    expect(out).toBe("Title\n\nkept");
  });
});
