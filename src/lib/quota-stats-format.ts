import type { AggregateResult, TokenBuckets } from "./quota-stats.js";
import { renderMarkdownTable } from "./markdown-table.js";

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function totalTokens(t: TokenBuckets): number {
  return t.input + t.output + t.reasoning + t.cache_read + t.cache_write;
}

/**
 * Format a timestamp as human-readable local time: "HH:MM YYYY-MM-DD"
 */
function fmtLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} ${year}-${month}-${day}`;
}

function fmtWindow(params: { sinceMs?: number; untilMs?: number }): string {
  if (!params.sinceMs && !params.untilMs) return "all time";
  const since = typeof params.sinceMs === "number" ? fmtLocalDateTime(params.sinceMs) : "-";
  const until = typeof params.untilMs === "number" ? fmtLocalDateTime(params.untilMs) : "now";
  return `${since} .. ${until}`;
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const units: Array<{ v: number; s: string }> = [
    { v: 1_000_000_000, s: "B" },
    { v: 1_000_000, s: "M" },
    { v: 1_000, s: "K" },
  ];
  for (const u of units) {
    if (abs >= u.v) {
      const x = abs / u.v;
      // Keep output stable and compact: 1 decimal unless very large.
      const digits = x >= 100 ? 0 : 1;
      return `${sign}${x.toFixed(digits)}${u.s}`;
    }
  }
  return `${Math.trunc(n)}`;
}

function normalizeSourceName(providerID: string): string {
  const p = (providerID ?? "unknown").toLowerCase();
  if (p === "opencode" || p.includes("opencode")) return "OpenCode";
  if (p.includes("cursor")) return "Cursor";
  if (p.includes("claude") || p.includes("anthropic")) return "Claude";
  if (p.includes("github") || p.includes("copilot")) return "Copilot";
  if (p.includes("openai") || p.includes("chatgpt") || p.includes("codex")) return "OpenAI";
  if (p.includes("google") || p.includes("antigravity") || p.includes("gemini")) return "Google";
  // Common OpenCode provider ids people use
  if (p.includes("azure")) return "Azure";
  return providerID || "Unknown";
}

function normalizeSourceModelId(modelID: string): string {
  return (modelID ?? "unknown").trim();
}

function sourceSortKey(source: string): number {
  const s = source.toLowerCase();
  if (s === "opencode") return 1;
  if (s === "claude") return 2;
  if (s === "cursor") return 3;
  if (s === "copilot") return 4;
  if (s === "openai") return 5;
  if (s === "google") return 6;
  if (s === "azure") return 7;
  return 99;
}

/**
 * Truncate a title to first 10 + last 10 chars with ellipsis in the middle.
 */
function truncateTitle(title: string | undefined): string {
  if (!title) return "(untitled)";
  const trimmed = title.trim();
  if (trimmed.length <= 23) return trimmed;
  // first 10 + ellipsis + last 10
  return trimmed.slice(0, 10) + "\u2026" + trimmed.slice(-10);
}

export function formatQuotaStatsReport(params: {
  title: string;
  result: AggregateResult;
  topModels?: number;
  topSessions?: number;
  focusSessionID?: string;
  /** When true, hides Window/Sessions columns and Top Sessions section (for session-only reports) */
  sessionOnly?: boolean;
}): string {
  const topModels = params.topModels ?? 12;
  const topSessions = params.topSessions ?? 8;
  const r = params.result;
  const sessionOnly = params.sessionOnly ?? false;

  const lines: string[] = [];

  lines.push(`# ${params.title}`);
  lines.push("");

  // For session-only reports, show a simpler summary without Window/Sessions columns
  if (sessionOnly) {
    lines.push(
      renderMarkdownTable({
        headers: ["Messages", "Tokens", "Cost"],
        aligns: ["right", "right", "right"],
        rows: [
          [
            fmtCompact(r.totals.messageCount),
            fmtCompact(totalTokens(r.totals.priced) + totalTokens(r.totals.unknown)),
            fmtUsd(r.totals.costUsd),
          ],
        ],
      }),
    );
  } else {
    lines.push(
      renderMarkdownTable({
        headers: ["Window", "Messages", "Sessions", "Tokens", "Cost"],
        aligns: ["left", "right", "right", "right", "right"],
        rows: [
          [
            fmtWindow(r.window),
            fmtCompact(r.totals.messageCount),
            fmtCompact(r.totals.sessionCount),
            fmtCompact(totalTokens(r.totals.priced) + totalTokens(r.totals.unknown)),
            fmtUsd(r.totals.costUsd),
          ],
        ],
      }),
    );
  }

  const hasAnyReasoning = r.totals.priced.reasoning > 0 || r.totals.unknown.reasoning > 0;

  const headers = ["Source", "Model", "Input", "Output", "C.Read", "C.Write"];
  const aligns: Array<"left" | "right"> = ["left", "left", "right", "right", "right", "right"];
  if (hasAnyReasoning) {
    headers.push("Reasoning");
    aligns.push("right");
  }
  headers.push("Total", "Cost");
  aligns.push("right", "right");

  const rows: string[][] = [];
  const grouped = new Map<string, AggregateResult["bySourceModel"]>();
  for (const row of r.bySourceModel) {
    const src = normalizeSourceName(row.sourceProviderID);
    const list = grouped.get(src);
    if (list) list.push(row);
    else grouped.set(src, [row]);
  }

  const sources = Array.from(grouped.keys()).sort((a, b) => {
    const ka = sourceSortKey(a);
    const kb = sourceSortKey(b);
    if (ka !== kb) return ka - kb;
    return a.localeCompare(b);
  });

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]!;
    const list = grouped.get(src)!;
    list.sort((a, b) => b.costUsd - a.costUsd);

    for (const row of list.slice(0, topModels)) {
      const t = row.tokens;
      const out: string[] = [
        src,
        normalizeSourceModelId(row.sourceModelID),
        fmtCompact(t.input),
        fmtCompact(t.output),
        fmtCompact(t.cache_read),
        fmtCompact(t.cache_write),
      ];
      if (hasAnyReasoning) out.push(fmtCompact(t.reasoning));
      out.push(fmtCompact(totalTokens(t)), fmtUsd(row.costUsd));
      rows.push(out);
    }

    // blank separator row between source groups
    if (i !== sources.length - 1) {
      rows.push(new Array(headers.length).fill(""));
    }
  }

  if (rows.length > 0) {
    lines.push("");
    lines.push(`## Models`);
    lines.push("");
    lines.push(renderMarkdownTable({ headers, rows, aligns }));
  }

  // Skip Top Sessions for session-only reports (e.g., /quota_session)
  if (r.bySession.length > 0 && !sessionOnly) {
    lines.push("");
    lines.push(`## Top Sessions`);
    lines.push("");

    const sessionRows: string[][] = [];
    const focus = params.focusSessionID
      ? r.bySession.find((s) => s.sessionID === params.focusSessionID)
      : undefined;
    if (focus) {
      sessionRows.push([
        "current",
        focus.sessionID,
        fmtUsd(focus.costUsd),
        fmtCompact(totalTokens(focus.tokens)),
        fmtCompact(focus.messageCount),
        truncateTitle(focus.title),
      ]);
    }

    const rest = params.focusSessionID
      ? r.bySession.filter((s) => s.sessionID !== params.focusSessionID)
      : r.bySession;
    for (const row of rest.slice(0, topSessions)) {
      sessionRows.push([
        "",
        row.sessionID,
        fmtUsd(row.costUsd),
        fmtCompact(totalTokens(row.tokens)),
        fmtCompact(row.messageCount),
        truncateTitle(row.title),
      ]);
    }

    lines.push(
      renderMarkdownTable({
        headers: ["", "Session", "Cost", "Tokens", "Msgs", "Title"],
        aligns: ["left", "left", "right", "right", "right", "left"],
        rows: sessionRows,
      }),
    );
  }

  if (r.unknown.length > 0) {
    lines.push("");
    lines.push(`## Unknown Pricing`);
    lines.push("");
    lines.push(
      renderMarkdownTable({
        headers: ["Source", "Model", "Mapped", "Tokens", "Msgs"],
        aligns: ["left", "left", "left", "right", "right"],
        rows: r.unknown.slice(0, 20).map((u) => {
          const mapped =
            u.key.mappedProvider && u.key.mappedModel
              ? `${u.key.mappedProvider}/${u.key.mappedModel}`
              : "-";
          return [
            normalizeSourceName(u.key.sourceProviderID),
            u.key.sourceModelID,
            mapped,
            fmtCompact(totalTokens(u.tokens)),
            fmtCompact(u.messageCount),
          ];
        }),
      }),
    );
    lines.push("");
    lines.push(`Run /tool quota_status to see the full unknown pricing report.`);
  }

  return lines.join("\n");
}
