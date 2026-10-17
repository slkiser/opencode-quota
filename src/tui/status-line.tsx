/** @jsxImportSource @opentui/solid */
/**
 * The quota status line under the message box (§4.3) and at the bottom of Home. It takes only
 * the room OpenCode's footer leaves free (flexBasis 0), so it never squeezes the folder name or
 * other plugins, shows the most detail that fits every provider, and scrolls when even "% only"
 * does not fit: mouse wheel, or click "‹" / "+N ›".
 */
import type { BoxRenderable, MouseEvent } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { visibleGroups } from "../view/select.js";
import {
  bigStatusLine,
  type Line,
  type StatusInput,
  type StatusLayout,
  statusLayout,
} from "../view/text.js";
import { LineText, type SurfaceHost } from "./sidebar.js";
import { roleColor } from "./theme.js";

export function StatusLine(props: { host: SurfaceHost; sessionID?: string }): JSX.Element {
  const host = props.host;
  onCleanup(host.quota.watch(props.sessionID));
  const [room, setRoom] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const display = () => host.display();
  const input = (): StatusInput | undefined => {
    const snapshot = host.quota.snapshot(props.sessionID);
    if (!snapshot) return undefined;
    const words = display().words;
    return {
      groups: visibleGroups(snapshot, display(), "statusLine", words),
      layout: display().layout,
      words,
      nowMs: nowMs(),
      window: display().statusLine.window,
      runsOut: display().runsOut.statusLine,
    };
  };
  const big = () => display().statusLine.detail === "one";
  const layout = () => {
    const current = input();
    if (!current || big()) return undefined;
    const detail = display().statusLine.detail;
    return statusLayout(current, room(), start(), detail === "one" ? "auto" : detail);
  };
  const count = () => input()?.groups.length ?? 0;
  const step = (delta: number) => setStart(Math.max(0, Math.min(count() - 1, start() + delta)));
  const color = (role: "arrows" | "separator") => roleColor(host.theme(), display(), role);

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
      flexBasis={0}
      minWidth={0}
      maxWidth={display().statusLine.width || undefined}
      overflow="hidden"
      onSizeChange={function (this: BoxRenderable) {
        // In OpenCode's footer the box can end up one column narrower than measured here
        // (seen at 200 columns), which cut the first letter; one spare column avoids it.
        const width = Math.max(0, this.width - 1);
        queueMicrotask(() => setRoom(width));
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
            <Show when={current().start > 0 && current().shown.length > 0}>
              <text
                fg={color("arrows")}
                wrapMode="none"
                flexShrink={0}
                selectable={false}
                onMouseUp={() => step(-1)}
              >
                {"‹ "}
              </text>
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
            <Show when={current().hiddenAfter > 0 && current().shown.length > 0}>
              <text
                fg={color("arrows")}
                wrapMode="none"
                flexShrink={0}
                selectable={false}
                onMouseUp={() => step(1)}
              >
                {` +${current().hiddenAfter} ›`}
              </text>
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
