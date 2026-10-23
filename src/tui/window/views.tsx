/** @jsxImportSource @opentui/solid */
/**
 * The bodies of the quota window's Limits and Plugin tabs. Their text comes from pure
 * builders: `limits.ts`, and `noticeItems` and `statusLines` here; the views only color it.
 */
import { TextAttributes } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import type { Notice, QuotaRpcNoticeListOutput } from "../../rpc.js";
import { columnsOf } from "../../view/columns.js";
import { LineText, type SurfaceHost } from "../sidebar.js";
import { limitsLines } from "./limits.js";
import type { WindowTheme } from "./shell.js";

/** The active maintainer notices. */
export type NoticeBoard = QuotaRpcNoticeListOutput;

export type NoticeReport =
  | { state: "loading" }
  | { state: "ready"; board: NoticeBoard }
  | { state: "failed"; message: string };

/** The notices, or the one line that says there is none. */
export function noticeItems(board: NoticeBoard): { items: Notice[]; empty?: string } {
  return board.notices.length === 0
    ? { items: [], empty: "No notices right now." }
    : { items: board.notices };
}

export type StatusLine = { text: string; heading: boolean };

/** The status report's lead: it starts 3 columns into the window body. */
const STATUS_LEAD = 3;

/**
 * The status report on Plugin: the /quota_status report's lines, its title ("# ") and its
 * section titles (an unindented line that ends with ":") marked so they can be bold. A list
 * joined with " | " that is wider than `width` goes on under itself between items, lined up
 * after its "key: ", so an id like `google-gemini-cli` never breaks at its "-".
 */
export function statusLines(text: string, width = Number.POSITIVE_INFINITY): StatusLine[] {
  return text.split("\n").flatMap((line) => {
    const heading = line.startsWith("# ") || (/^[^\s-]/u.test(line) && line.endsWith(":"));
    return listRows(line, width).map((row) => ({ text: row, heading }));
  });
}

/** A " | " list in rows no wider than `width` (when each item fits), broken between items. */
function listRows(line: string, width: number): string[] {
  const items = line.split(" | ");
  if (items.length < 2 || columnsOf(line) <= width) return [line];
  const keyEnd = items[0].indexOf(": ");
  const lead = " ".repeat(keyEnd === -1 ? 0 : keyEnd + 2);
  const rows: string[] = [];
  let row = items[0];
  items.slice(1).forEach((item, index) => {
    const last = index === items.length - 2;
    const next = `${row} | ${item}`;
    if (columnsOf(next) + (last ? 0 : 2) <= width) {
      row = next;
      return;
    }
    rows.push(`${row} |`);
    row = `${lead}${item}`;
  });
  return [...rows, row];
}

export type StatusReport =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | { state: "failed"; message: string };

export function LimitsView(props: {
  host: SurfaceHost;
  sessionID: string;
  nowMs: number;
  width: number;
}): JSX.Element {
  const snapshot = () => props.host.quota.snapshot(props.sessionID);
  const lines = () => {
    const current = snapshot();
    if (!current) return [];
    const display = props.host.display();
    return limitsLines({ snapshot: current, display, nowMs: props.nowMs, width: props.width });
  };
  return (
    <Show
      when={snapshot()}
      fallback={<text fg={props.host.theme().text.muted}>{"   Loading quota…"}</text>}
    >
      {lines().map((line) => (
        <LineText line={line} host={props.host} />
      ))}
    </Show>
  );
}

/** Plugin's notices under their title: a bullet, the message, and its link under it. */
export function NoticesView(props: { theme: WindowTheme; report: NoticeReport }): JSX.Element {
  const theme = () => props.theme;
  const body = () => {
    const report = props.report;
    if (report.state === "loading") return { items: [], empty: "Loading…" };
    if (report.state === "failed") {
      return { items: [], empty: `Couldn't load the notices: ${report.message}` };
    }
    return noticeItems(report.board);
  };
  return (
    <box flexDirection="column">
      <text
        fg={theme().text.action.primary.selected}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        selectable={false}
      >
        {" Notices"}
      </text>
      <Show when={body().empty}>
        <text fg={theme().text.muted} wrapMode="word" selectable={false}>
          {`   ${body().empty}`}
        </text>
      </Show>
      {body().items.map((item) => (
        <box flexDirection="row">
          <text fg={theme().hue.accent[500]} wrapMode="none" selectable={false}>
            {"   • "}
          </text>
          <box flexDirection="column" flexShrink={1}>
            <text fg={theme().text.base} wrapMode="word">
              {sanitizeDisplayText(item.message)}
            </text>
            <Show when={item.url}>
              <text fg={theme().text.muted} wrapMode="none">
                {sanitizeDisplayText(item.url ?? "")}
              </text>
            </Show>
          </box>
        </box>
      ))}
    </box>
  );
}

/**
 * The /quota_status report as text you can select, all in the muted color (its section titles
 * bold): it is for pasting into an issue, and reads apart from the tab's own lines.
 */
export function StatusView(props: {
  theme: WindowTheme;
  report: StatusReport;
  width: number;
}): JSX.Element {
  const theme = () => props.theme;
  const lines = () => {
    const report = props.report;
    if (report.state === "loading") return [{ text: "Loading the report…", heading: false }];
    if (report.state === "failed") {
      return [{ text: `Couldn't load the report: ${report.message}`, heading: false }];
    }
    return statusLines(report.text, props.width - STATUS_LEAD);
  };
  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      {lines().map((line) => (
        <text
          fg={theme().text.muted}
          attributes={line.heading ? TextAttributes.BOLD : TextAttributes.NONE}
          wrapMode="word"
        >
          {line.text || " "}
        </text>
      ))}
    </box>
  );
}
