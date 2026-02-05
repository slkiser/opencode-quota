type Align = "left" | "right" | "center";

/**
 * Width measurement mode:
 * - "raw": Use string length (grapheme count)
 * - "markdown-conceal": Strip markdown syntax for width calculation (for TUI concealment mode)
 */
export type WidthMode = "raw" | "markdown-conceal";

/**
 * Use Intl.Segmenter for grapheme-aware width measurement when available.
 * Falls back to Array.from for code point count.
 */
const GRAPHEME_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Measure width using grapheme clusters (preferred) or code points (fallback).
 */
function measureWidth(text: string): number {
  const s = text ?? "";
  if (!s) return 0;
  if (GRAPHEME_SEGMENTER) {
    let n = 0;
    for (const _ of GRAPHEME_SEGMENTER.segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

/**
 * Convert markdown text to visual representation for width calculation.
 * Strips markdown syntax that is hidden in concealment mode.
 */
function toVisualTextForWidth(text: string): string {
  // Treat escaped markdown pipes as a single visual char.
  let t = (text ?? "").replace(/\\\|/g, "|");

  // Protect inline code so markdown inside `code` remains literal.
  const codeSpans: string[] = [];
  t = t.replace(/`([^`]+?)`/g, (_m, content: string) => {
    codeSpans.push(content);
    return `\x00CODE${codeSpans.length - 1}\x00`;
  });

  let prev = "";
  while (t !== prev) {
    prev = t;
    t = t
      // ***bold+italic*** -> text
      .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
      // **bold** -> text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      // *italic* -> text
      .replace(/\*(.+?)\*/g, "$1")
      // ~~strikethrough~~ -> text
      .replace(/~~(.+?)~~/g, "$1")
      // ![alt](url) -> alt
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
      // [text](url) -> text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  }

  // Restore inline code contents (without backticks)
  t = t.replace(/\x00CODE(\d+)\x00/g, (_m, idx: string) => {
    const i = Number(idx);
    return Number.isFinite(i) ? (codeSpans[i] ?? "") : "";
  });

  return t;
}

/**
 * Calculate cell width based on the specified mode.
 */
function cellWidth(text: string, widthMode: WidthMode): number {
  if (widthMode === "markdown-conceal") {
    return measureWidth(toVisualTextForWidth(text));
  }
  return measureWidth(text);
}

function padCell(text: string, width: number, align: Align, widthMode: WidthMode): string {
  const s = text ?? "";
  const w = cellWidth(s, widthMode);
  if (w >= width) return s;
  const pad = width - w;
  if (align === "right") return " ".repeat(pad) + s;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return " ".repeat(left) + s + " ".repeat(right);
  }
  return s + " ".repeat(pad);
}

function escapeCell(text: string): string {
  // Keep this conservative: tool output should be plain ascii.
  return (text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderMarkdownTable(params: {
  headers: string[];
  rows: string[][];
  aligns?: Align[];
  widthMode?: WidthMode;
}): string {
  const aligns: Align[] = params.aligns ?? params.headers.map(() => "left");
  const widthMode: WidthMode = params.widthMode ?? "raw";
  const colCount = params.headers.length;

  const safeRows = params.rows.map((r) => {
    const out: string[] = [];
    for (let i = 0; i < colCount; i++) out.push(escapeCell(r[i] ?? ""));
    return out;
  });

  const headerCells = params.headers.map((h) => escapeCell(h));

  const widths = headerCells.map((h) => Math.max(3, cellWidth(h, widthMode)));
  for (const row of safeRows) {
    for (let i = 0; i < colCount; i++) {
      widths[i] = Math.max(widths[i], cellWidth(row[i] ?? "", widthMode));
    }
  }

  const fmtRow = (cells: string[]) =>
    `| ${cells.map((c, i) => padCell(c, widths[i], aligns[i] ?? "left", widthMode)).join(" | ")} |`;

  const sep = `| ${widths
    .map((w, i) => {
      const a = aligns[i] ?? "left";
      if (a === "right") return "-".repeat(Math.max(3, w - 1)) + ":";
      if (a === "center") return ":" + "-".repeat(Math.max(3, w - 2)) + ":";
      return "-".repeat(Math.max(3, w));
    })
    .join(" | ")} |`;

  const lines: string[] = [];
  lines.push(fmtRow(headerCells));
  lines.push(sep);
  for (const row of safeRows) lines.push(fmtRow(row));
  return lines.join("\n");
}
