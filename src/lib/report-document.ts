import { renderCommandHeading } from "./format-utils.js";
import { renderMarkdownTable, type WidthMode } from "./markdown-table.js";

export type ReportHeading = {
  title: string;
  generatedAtMs?: number;
};

export type ReportKvRow = {
  key: string;
  value?: string;
  indent?: 0 | 1;
  trailingColon?: boolean;
};

export type ReportBlock =
  | { kind: "lines"; lines: string[] }
  | { kind: "kv"; rows: ReportKvRow[] }
  | {
      kind: "table";
      headers: string[];
      rows: string[][];
      aligns: Array<"left" | "right">;
      widthMode?: WidthMode;
    };

export type ReportSection = {
  id: string;
  title?: string;
  blocks: ReportBlock[];
};

export type ReportDocument = {
  heading?: ReportHeading;
  sections: ReportSection[];
};

function hasBlockContent(block: ReportBlock): boolean {
  switch (block.kind) {
    case "lines":
      return block.lines.length > 0;
    case "kv":
      return block.rows.length > 0;
    case "table":
      return block.headers.length > 0 || block.rows.length > 0;
  }
}

function getRenderableBlocks(section: ReportSection): ReportBlock[] {
  return section.blocks.filter(hasBlockContent);
}

function renderKvRow(row: ReportKvRow): string {
  const indent = row.indent === 1 ? "  " : "";
  if (row.value !== undefined) {
    return `${indent}- ${row.key}: ${row.value}`;
  }
  return `${indent}- ${row.key}${row.trailingColon ? ":" : ""}`;
}

function renderPlainTextBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

function renderMarkdownBlock(block: ReportBlock): string[] {
  switch (block.kind) {
    case "lines":
      return block.lines;
    case "kv":
      return block.rows.map(renderKvRow);
    case "table":
      return [
        renderMarkdownTable({
          headers: block.headers,
          rows: block.rows,
          aligns: block.aligns,
          widthMode: block.widthMode,
        }),
      ];
  }
}

export function renderPlainTextReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) {
    lines.push(
      renderCommandHeading({
        title: document.heading.title,
        generatedAtMs: document.heading.generatedAtMs,
      }),
    );
  }

  const sections = document.sections
    .map((section) => ({ ...section, blocks: getRenderableBlocks(section) }))
    .filter((section) => section.title || section.blocks.length > 0);

  for (const section of sections) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(section.title);
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderPlainTextBlock(block));
    }
  }

  return lines.join("\n");
}

export function renderMarkdownReport(document: ReportDocument): string {
  const lines: string[] = [];

  if (document.heading) {
    lines.push(
      renderCommandHeading({
        title: document.heading.title,
        generatedAtMs: document.heading.generatedAtMs,
      }),
    );
  }

  const sections = document.sections
    .map((section) => ({ ...section, blocks: getRenderableBlocks(section) }))
    .filter((section) => section.title || section.blocks.length > 0);

  for (const section of sections) {
    if (lines.length > 0) lines.push("");

    if (section.title) {
      lines.push(`## ${section.title}`);
      if (section.blocks.length > 0) lines.push("");
    }

    for (const [index, block] of section.blocks.entries()) {
      if (index > 0) lines.push("");
      lines.push(...renderMarkdownBlock(block));
    }
  }

  return lines.join("\n");
}
