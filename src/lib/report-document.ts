/** A text report as data (a heading line, then sections of lines and key-value rows) and its text. */

export type ReportKvRow = {
  key: string;
  value?: string;
  indent?: 0 | 1;
  trailingColon?: boolean;
};

export type ReportBlock = { kind: "lines"; lines: string[] } | { kind: "kv"; rows: ReportKvRow[] };

export type ReportSection = {
  id: string;
  title?: string;
  blocks: ReportBlock[];
};

export type ReportDocument = {
  /** The report's first line. */
  heading?: string;
  sections: ReportSection[];
};

function hasBlockContent(block: ReportBlock): boolean {
  return block.kind === "lines" ? block.lines.length > 0 : block.rows.length > 0;
}

function renderKvRow(row: ReportKvRow): string {
  const indent = row.indent === 1 ? "  " : "";
  if (row.value !== undefined) {
    return `${indent}- ${row.key}: ${row.value}`;
  }
  return `${indent}- ${row.key}${row.trailingColon ? ":" : ""}`;
}

/**
 * The report as text: the heading, then each section with a title or a block with content,
 * a blank line between sections and between blocks.
 */
export function renderPlainTextReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) lines.push(document.heading);

  for (const section of document.sections) {
    const blocks = section.blocks.filter(hasBlockContent);
    if (!section.title && blocks.length === 0) continue;
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(section.title);
    }

    for (const [index, block] of blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...(block.kind === "lines" ? block.lines : block.rows.map(renderKvRow)));
    }
  }

  return lines.join("\n");
}
