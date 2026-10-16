/** @jsxImportSource @opentui/solid */
/**
 * The Quota panel in the session sidebar (§4.1) and its collapsed form (§4.2). Click the
 * title to collapse or expand it; OpenCode's plugin storage remembers the choice. The lines
 * come from `view/text.ts`; this file only colors them, and marks the line the quota window's
 * Settings tabs have selected.
 */
import type { BoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { DEFAULT_WORDS } from "../view/format.js";
import { type Surface, visibleGroups } from "../view/select.js";
import {
  type ColorRole,
  collapsedLines,
  collapsedTitle,
  type Line,
  type Segment,
  sidebarLines,
  sidebarTitle,
} from "../view/text.js";
import type { QuotaClient } from "./client.js";
import type { DisplaySettings } from "./display.js";
import { roleColor, segmentColor, type Theme } from "./theme.js";

/** What the quota window's Settings tabs tell the surfaces while you edit them. */
export type SurfaceEditing = {
  /** The provider or row id selected on the tab that edits `surface`; that surface marks it. */
  marked(surface: Surface): string | undefined;
  /** The Sidebar tab shows the panel expanded, the Collapsed tab collapsed. */
  panelOpen(): boolean | undefined;
  /** A sidebar panel is on screen until the returned function runs. */
  sidebarShown(): () => void;
  /**
   * The status line shows: it is on, and its tab is open, it shows next to the sidebar, or no
   * sidebar panel with quota is on screen.
   */
  statusLineShown(): boolean;
};

/** What every always-on surface reads. */
export type SurfaceHost = {
  theme: () => Theme;
  /** The saved display settings, or the draft while the Settings tabs edit it. */
  display: () => DisplaySettings;
  quota: QuotaClient;
  editing: SurfaceEditing;
};

/** Columns the panel uses until it knows its real width. */
const DEFAULT_SIDEBAR_WIDTH = 36;

/** The names of a marked line take the accent color; bars and numbers keep theirs. */
const MARKED_ROLES: ReadonlySet<Segment["role"]> = new Set<ColorRole>([
  "provider",
  "label",
  "statusName",
]);

/** One line of a surface, each segment in its color. A marked line has a soft background. */
export function LineText(props: { line: Line; host: SurfaceHost; marked?: boolean }): JSX.Element {
  const theme = () => props.host.theme();
  const color = (segment: Segment) =>
    props.marked && MARKED_ROLES.has(segment.role)
      ? theme().text.action.primary.selected
      : segmentColor(theme(), props.host.display(), segment);
  return (
    <text
      wrapMode="none"
      selectable={false}
      flexShrink={0}
      bg={props.marked ? theme().background.raised.high : undefined}
    >
      {props.line.segments.length === 0 ? " " : null}
      {props.line.segments.map((segment) => (
        <span
          style={{
            fg: color(segment),
            bold: segment.bold === true,
          }}
        >
          {segment.text}
        </span>
      ))}
    </text>
  );
}

export function SidebarPanel(props: {
  host: SurfaceHost;
  sessionID: string;
  open: () => boolean;
  setOpen: (open: boolean) => void;
}): JSX.Element {
  const host = props.host;
  const stop = host.quota.watch(props.sessionID);
  onCleanup(stop);
  onCleanup(host.editing.sidebarShown());
  const open = () => host.editing.panelOpen() ?? props.open();
  const [width, setWidth] = createSignal(DEFAULT_SIDEBAR_WIDTH);
  const [nowMs, setNowMs] = createSignal(Date.now());
  // Reset times count down between snapshots.
  const clock = setInterval(() => setNowMs(Date.now()), 60_000);
  onCleanup(() => clearInterval(clock));

  const display = () => host.display();
  const snapshot = () => host.quota.snapshot(props.sessionID);
  const words = () => snapshot()?.words ?? DEFAULT_WORDS;
  const groups = (surface: "sidebar" | "collapsed") => {
    const current = snapshot();
    return current ? visibleGroups(current, display(), surface, words()) : [];
  };
  const lines = (): Line[] => {
    const current = snapshot();
    if (!current) return [];
    if (!open()) {
      if (!display().surfaces.collapsed.enabled) return [];
      return collapsedLines({
        groups: groups("collapsed"),
        layout: display().layout,
        words: words(),
        nowMs: nowMs(),
        width: width(),
        window: display().window,
        runsOut: display().runsOut.collapsed,
      });
    }
    return sidebarLines({
      groups: groups("sidebar"),
      layout: display().layout,
      words: words(),
      nowMs: nowMs(),
      width: width(),
      runsOut: display().runsOut.sidebar,
      ...(display().sidebar.sessionTokens && current.sessionTokens
        ? { sessionTokens: current.sessionTokens }
        : {}),
    });
  };
  const title = () => (open() ? sidebarTitle(words()) : collapsedTitle(groups("collapsed")));
  const marked = () => host.editing.marked(open() ? "sidebar" : "collapsed");

  return (
    <Show when={display().surfaces.sidebar.enabled}>
      <box
        flexDirection="column"
        onSizeChange={function (this: BoxRenderable) {
          const measured = this.width;
          if (measured > 0) queueMicrotask(() => setWidth(measured));
        }}
      >
        <text
          fg={roleColor(host.theme(), display(), "title")}
          wrapMode="none"
          selectable={false}
          onMouseDown={() => props.setOpen(!open())}
        >
          <b>{title()}</b>
        </text>
        <Show when={snapshot()} fallback={<text fg={host.theme().text.muted}>Loading quota…</text>}>
          {lines().map((line) => (
            <LineText line={line} host={host} marked={line.id !== "" && line.id === marked()} />
          ))}
        </Show>
      </box>
    </Show>
  );
}
