import { describe, expect, it } from "vitest";

import { renderMarkdownReport, renderPlainTextReport } from "../src/lib/report-document.js";

describe("report-document", () => {
  it("renders stable plain-text section spacing across lines and kv blocks", () => {
    const out = renderPlainTextReport({
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
          ],
        },
        {
          id: "notes",
          blocks: [
            {
              kind: "lines",
              lines: ["note one", "note two"],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "status:
      - enabled: true
      - providers:
        - openai: available

      note one
      note two"
    `);
  });

  it("renders stable markdown section spacing across tables and note blocks", () => {
    const out = renderMarkdownReport({
      sections: [
        {
          id: "summary",
          blocks: [
            {
              kind: "table",
              headers: ["Messages", "Cost"],
              aligns: ["right", "right"],
              rows: [["3", "$1.23"]],
            },
          ],
        },
        {
          id: "details",
          title: "Details",
          blocks: [
            {
              kind: "table",
              headers: ["Source", "Tokens"],
              aligns: ["left", "right"],
              rows: [["OpenAI", "123"]],
            },
            {
              kind: "lines",
              lines: ["Follow up note."],
            },
          ],
        },
      ],
    });

    expect(out).toMatchInlineSnapshot(`
      "| Messages |  Cost |
      | -------: | ----: |
      |        3 | $1.23 |

      ## Details

      | Source | Tokens |
      | ------ | -----: |
      | OpenAI |    123 |

      Follow up note."
    `);
  });
});
