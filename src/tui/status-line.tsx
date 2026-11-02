/** @jsxImportSource @opentui/solid */
/**
 * The quota status line under the message box (§4.3) and at the bottom of Home. It asks for
 * the room its narrowest form needs, up to a third of the footer row (`statusLineBasis`), and
 * takes all the room OpenCode's footer leaves free. It shows the most detail that fits every
 * provider, and scrolls when even "% only" does not fit: mouse wheel, or click "‹" / "+N ›".
 */
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { columnsOf } from "../view/columns.js";
import {
  bigStatusLine,
  type Line,
  type StatusInput,
  type StatusLayout,
  lineText,
  statusLayout,
  statusLineInput,
  statusLineWidth,
  statusMarkers,
} from "../view/text.js";
import { LineText, type SurfaceHost } from "./sidebar.js";
import { roleColor } from "./theme.js";

/**
 * The status line shows under a session's message box: it is on, and its Settings tab is open,
 * it shows next to the sidebar, or no sidebar panel with quota is on screen.
 */
export function statusLineShows(host: SurfaceHost): boolean {
  const settings = host.display();
  if (!settings.statusLine.show) return false;
  const sidebarQuota = host.editing.sidebarOnScreen() && settings.sidebar.show;
  return host.editing.tabOpen("statusLine") || settings.statusLine.withSidebar || !sidebarQuota;
}

/**
 * The flex basis of the status line's box: the width it asks for before the free room is
 * shared. OpenCode's session footer cuts its folder name to the room that name had at the last
 * layout, so at start a long folder name keeps all the free room, and a box with basis 0 stays
 * empty. With this basis the folder name gives room back: `wanted` columns (the line's
 * narrowest form), but never more than a third of the footer row, nor more than the
 * `statusLine.width` setting (0: no limit). The box still shrinks with the folder name when the
 * row is too narrow for both.
 */
export function statusLineBasis(wanted: number, rowWidth: number, maxWidth: number): number {
  const third = Math.floor(rowWidth / 3);
  const limit = maxWidth > 0 ? Math.min(third, maxWidth) : third;
  return Math.max(0, Math.min(wanted, limit));
}

export function StatusLine(props: {
  host: SurfaceHost;
  sessionID?: string;
  /** The terminal's width: the footer row's width until the box is first measured. */
  terminalWidth?: () => number;
}): JSX.Element {
  const host = props.host;
  onCleanup(host.quota.watch(props.sessionID));
  const [room, setRoom] = createSignal(0);
  // The width of the row the box sits in, read when the box is measured.
  const [rowWidth, setRowWidth] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const display = () => host.display();
  const input = (): StatusInput | undefined => {
    const snapshot = host.quota.snapshot(props.sessionID);
    return snapshot && statusLineInput(snapshot, display(), nowMs());
  };
  const big = () => display().statusLine.detail === "one";
  const layout = () => {
    const current = input();
    // The room is 0 until OpenCode measures the box: no markers on their own before that.
    if (!current || big() || room() === 0) return undefined;
    const detail = display().statusLine.detail;
    return statusLayout(current, room(), start(), detail === "one" ? "auto" : detail);
  };
  const count = () => input()?.groups.length ?? 0;
  const step = (delta: number) => setStart(Math.max(0, Math.min(count() - 1, start() + delta)));
  const color = (role: "arrows" | "separator") => roleColor(host.theme(), display(), role);
  // The narrowest whole line: every provider at "% only", or the big bar's one provider.
  const narrowest = (current: StatusInput): number => {
    if (!big()) return statusLineWidth(current, "numbers");
    const line = bigStatusLine(current);
    return line ? columnsOf(lineText(line)) : 0;
  };
  const basis = () => {
    const current = input();
    if (!current || current.groups.length === 0) return 0;
    // One spare column, like `room` below.
    const wanted = narrowest(current) + 1;
    return statusLineBasis(
      wanted,
      rowWidth() || (props.terminalWidth?.() ?? 0),
      display().statusLine.width,
    );
  };

  const marked = () => host.editing.marked("statusLine");
  // The provider selected on the Settings tab scrolls into view.
  createEffect(() => {
    const index = input()?.groups.findIndex((group) => group.providerId === marked()) ?? -1;
    const current = layout();
    if (index < 0 || !current || room() === 0) return;
    if (index < current.start || index >= current.start + current.shown.length) setStart(index);
  });

  // Optional: page through by itself every few seconds.
  createEffect(() => {
    const seconds = display().statusLine.autoScrollSeconds;
    if (!seconds) return;
    const timer = setInterval(() => {
      const current = layout();
      if (!current) return;
      setStart(current.hiddenAfter > 0 ? current.start + current.shown.length : 0);
    }, seconds * 1000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <box
      flexDirection="row"
      justifyContent="flex-end"
      flexGrow={1000}
      flexShrink={1}
      flexBasis={basis()}
      minWidth={0}
      maxWidth={display().statusLine.width || undefined}
      overflow="hidden"
      onSizeChange={function (this: BoxRenderable) {
        // In OpenCode's footer the box can end up one column narrower than measured here
        // (seen at 200 columns), which cut the first letter; one spare column avoids it.
        const width = Math.max(0, this.width - 1);
        const row = this.parent?.width ?? 0;
        queueMicrotask(() => {
          setRoom(width);
          setRowWidth(row);
        });
      }}
      onMouseScroll={(event: MouseEvent) => {
        const direction = event.scroll?.direction;
        if (direction === "down" || direction === "right") step(1);
        if (direction === "up" || direction === "left") step(-1);
      }}
    >
      <Show when={big() ? input() : undefined}>
        {(current: () => StatusInput) => (
          // The room is 0 until OpenCode measures the box; until then the line is drawn whole.
          <Show when={bigStatusLine(current(), room() || undefined)}>
            {(line: () => Line) => (
              <LineText line={line()} host={host} marked={line().id === marked()} />
            )}
          </Show>
        )}
      </Show>
      <Show when={layout()}>
        {(current: () => StatusLayout) => (
          <>
            <Show when={statusMarkers(current()).before}>
              {(marker: () => string) => (
                <text
                  fg={color("arrows")}
                  wrapMode="none"
                  flexShrink={0}
                  selectable={false}
                  onMouseUp={() => step(-1)}
                >
                  {marker()}
                </text>
              )}
            </Show>
            {current().shown.map((line: Line, index: number) => (
              <>
                <Show when={index > 0}>
                  <text fg={color("separator")} wrapMode="none" flexShrink={0} selectable={false}>
                    {display().layout.separator}
                  </text>
                </Show>
                <LineText line={line} host={host} marked={line.id === marked()} />
              </>
            ))}
            <Show when={statusMarkers(current()).after}>
              {(marker: () => string) => (
                <text
                  fg={color("arrows")}
                  wrapMode="none"
                  flexShrink={0}
                  selectable={false}
                  onMouseUp={() => step(1)}
                >
                  {marker()}
                </text>
              )}
            </Show>
          </>
        )}
      </Show>
    </box>
  );
}

/**
 * The bottom of Home: the maintainer notice line, then the status line when it is on for Home.
 * Home has its own switch (`statusLine.home`); the one for sessions does not hide it.
 */
export function HomeFooter(props: { host: SurfaceHost }): JSX.Element {
  const host = props.host;
  onCleanup(host.quota.watchHome());
  const showStatus = () => host.display().statusLine.home;
  return (
    <Show when={host.quota.homeLine() || showStatus()}>
      <box
        flexDirection="row"
        gap={2}
        flexGrow={showStatus() ? 1000 : 0}
        flexShrink={1}
        flexBasis={showStatus() ? 0 : "auto"}
        minWidth={0}
      >
        <Show when={host.quota.homeLine()}>
          <text fg={host.theme().text.muted} wrapMode="none" flexShrink={0}>
            {host.quota.homeLine()}
          </text>
        </Show>
        <Show when={showStatus()}>
          <StatusLine host={host} />
        </Show>
      </box>
    </Show>
  );
}
