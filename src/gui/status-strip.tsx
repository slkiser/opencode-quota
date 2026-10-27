/** @jsxImportSource solid-js */
/**
 * The strip at the bottom of the window (`window.bottom`), the TUI's status line drawn with the
 * Quota tab's parts: each provider the status line shows, with the row its window setting picks
 * (`pickedGroups`), as a name, a thin bar with the even-use mark, the percent, the reset time and
 * "runs out in", each in its color role. A hidden copy of every provider at every detail level
 * gives their widths in pixels; `stripLayout` then shows the most detail that fits every
 * provider and pages when even "numbers" does not fit: click "‹" or "+N ›", or turn the mouse
 * wheel. `statusLine.autoScrollSeconds` pages by itself; `statusLine.width` caps its width in
 * characters. The "one" detail shows the first provider with its row name, a wider bar and its
 * percent in words.
 * Click a provider to open the usage window.
 */
import type { Context } from "@opencode/plugin/gui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { type ColorRole } from "../view/text.js";
import { Bar } from "./panel.js";
import {
  type PickedGroup,
  pickedGroups,
  roleCss,
  STRIP_DETAILS,
  type StripDetail,
  stripLayout,
} from "./surfaces-model.js";

const CLOCK_MS = 60_000;
/** The strip's padding on both sides (`.oq-strip-bottom`). */
const PADDING_PX = 24;
/** Where the status line has no room for the reset time, a failed check shows only this mark. */
const ERROR_MARK = "⚠";

type StripProps = {
  ctx: Context;
  snapshot: () => QuotaSnapshot | undefined;
  settings: () => Settings;
  openWindow: () => void;
};

type ItemDetail = StripDetail | "one";

function StripItem(props: {
  ctx: Context;
  group: PickedGroup;
  detail: ItemDetail;
  settings: Settings;
  onClick: () => void;
}) {
  const row = () => props.group.row;
  const color = (role: ColorRole) =>
    roleCss(props.settings, role, row()?.percent, row()?.paceLevel);
  const withBar = () =>
    props.settings.layout.bar !== "none" &&
    (props.detail === "full" || props.detail === "bar" || props.detail === "one");
  const withReset = () =>
    props.detail === "full" || props.detail === "reset" || props.detail === "one";
  const state = () =>
    props.group.error ??
    (props.group.unchecked ? props.ctx.t("panel.notChecked") : (row()?.value ?? ""));
  return (
    <button type="button" class="oq-sitem" onClick={() => props.onClick()}>
      <span class="oq-sname" style={{ color: color("statusName") }}>
        {props.group.title}
      </span>
      <Show
        when={row()?.percent !== undefined ? row() : undefined}
        fallback={
          <span style={{ color: color(props.group.error ? "error" : "value") }}>{state()}</span>
        }
      >
        {(shown) => (
          <>
            <Show when={props.detail === "one"}>
              <span style={{ color: color("label") }}>{shown().name}</span>
            </Show>
            <Show when={withBar()}>
              <span class={props.detail === "one" ? "oq-sbarbox oq-wide" : "oq-sbarbox"}>
                <Bar settings={props.settings} row={shown()} />
              </span>
            </Show>
            <span style={{ color: color("percent") }}>{shown().value}</span>
            <Show
              when={props.group.error}
              fallback={
                <Show when={withReset() && shown().reset}>
                  <span style={{ color: color("reset") }}>{shown().reset}</span>
                </Show>
              }
            >
              {(error) => (
                <span style={{ color: color("error") }}>{withReset() ? error() : ERROR_MARK}</span>
              )}
            </Show>
            <Show when={shown().pace}>
              {(pace) => <span style={{ color: color("warning") }}>({pace().words})</span>}
            </Show>
          </>
        )}
      </Show>
    </button>
  );
}

export function StatusStrip(props: StripProps) {
  const { ctx } = props;
  const [room, setRoom] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [widths, setWidths] = createSignal<Record<StripDetail, number[]>>();
  const [markers, setMarkers] = createSignal({ separator: 0, previous: 0, next: 0 });
  const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));

  const settings = () => props.settings();
  const one = () => settings().statusLine.detail === "one";
  const groups = createMemo(() => {
    const shown = props.snapshot();
    if (!shown) return [];
    return one()
      ? pickedGroups(shown, settings(), "statusLine", nowMs(), { percent: "words" }).slice(0, 1)
      : pickedGroups(shown, settings(), "statusLine", nowMs());
  });

  const [fontsLoaded, setFontsLoaded] = createSignal(false);
  void document.fonts?.ready.then(() => setFontsLoaded(true));
  const [box, setBox] = createSignal<HTMLDivElement>();
  const [measure, setMeasure] = createSignal<HTMLDivElement>();
  createEffect(() => {
    const strip = box();
    if (!strip) return;
    // Rounded down: the items' widths are fractional, and a name cut by a fraction of a pixel
    // would show an ellipsis.
    const update = () =>
      setRoom(Math.max(0, Math.floor(strip.getBoundingClientRect().width) - PADDING_PX));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(strip);
    onCleanup(() => observer.disconnect());
  });
  // Every provider's width at every detail level, read from the hidden copy after it renders.
  createEffect(() => {
    const copy = measure();
    groups();
    settings();
    // Also when the strip's size changes or the fonts finish loading: a copy measured while the
    // strip was hidden, or in a fallback font, has wrong widths.
    room();
    fontsLoaded();
    if (!copy || one()) return;
    const width = (element: Element | null | undefined) =>
      element ? element.getBoundingClientRect().width : 0;
    const read = {} as Record<StripDetail, number[]>;
    for (const detail of STRIP_DETAILS) {
      const items = copy.querySelectorAll(`[data-detail="${detail}"] > .oq-sitem`);
      read[detail] = Array.from(items, (item) => width(item));
    }
    setWidths(read);
    setMarkers({
      separator: width(copy.querySelector(".oq-ssep")),
      previous: width(copy.querySelector("[data-marker='previous']")),
      next: width(copy.querySelector("[data-marker='next']")),
    });
  });

  const layout = () => {
    const measured = widths();
    if (one() || !measured || measured.full.length !== groups().length) return undefined;
    const detail = settings().statusLine.detail;
    return stripLayout({
      widths: measured,
      ...markers(),
      room: room(),
      start: start(),
      detail: detail === "one" ? "auto" : detail,
    });
  };
  const shown = () => {
    const current = layout();
    if (one()) return groups();
    // Until the copy is measured, every provider shows in full.
    if (!current) return groups();
    return groups().slice(current.start, current.start + current.count);
  };
  const detailShown = (): ItemDetail => (one() ? "one" : (layout()?.detail ?? "full"));
  const count = () => groups().length;
  const step = (delta: number) => setStart(Math.max(0, Math.min(count() - 1, start() + delta)));
  const color = (role: ColorRole) => roleCss(settings(), role);
  const separator = () => settings().layout.separator;

  createEffect(() => {
    const seconds = settings().statusLine.autoScrollSeconds;
    if (!seconds) return;
    const timer = setInterval(() => {
      const current = layout();
      if (!current) return;
      setStart(current.hiddenAfter > 0 ? current.start + current.count : 0);
    }, seconds * 1000);
    onCleanup(() => clearInterval(timer));
  });

  const width = () => settings().statusLine.width;
  return (
    <div
      ref={setBox}
      class="oq-surface oq-strip-bottom"
      data-mode={ctx.appearance.mode()}
      style={{ "max-width": width() > 0 ? `${width()}ch` : undefined }}
      onWheel={(event) => {
        if (event.deltaY === 0 && event.deltaX === 0) return;
        step((event.deltaY || event.deltaX) > 0 ? 1 : -1);
      }}
    >
      <div ref={setMeasure} class="oq-smeasure" aria-hidden="true">
        <For each={STRIP_DETAILS}>
          {(detail) => (
            <div data-detail={detail}>
              <For each={one() ? [] : groups()}>
                {(group) => (
                  <StripItem
                    ctx={ctx}
                    group={group}
                    detail={detail}
                    settings={settings()}
                    onClick={() => undefined}
                  />
                )}
              </For>
            </div>
          )}
        </For>
        <span class="oq-ssep">{separator()}</span>
        <span class="oq-sarrow" data-marker="previous">
          {"‹ "}
        </span>
        <span class="oq-sarrow" data-marker="next">
          {` +${count()} ›`}
        </span>
      </div>
      <Show when={(layout()?.start ?? 0) > 0}>
        <button
          type="button"
          class="oq-sarrow"
          style={{ color: color("arrows") }}
          aria-label={ctx.t("strip.previous")}
          onClick={() => step(-1)}
        >
          {"‹ "}
        </button>
      </Show>
      <For each={shown()}>
        {(group, index) => (
          <>
            <Show when={index() > 0}>
              <span class="oq-ssep" style={{ color: color("separator") }}>
                {separator()}
              </span>
            </Show>
            <StripItem
              ctx={ctx}
              group={group}
              detail={detailShown()}
              settings={settings()}
              onClick={props.openWindow}
            />
          </>
        )}
      </For>
      <Show when={(layout()?.hiddenAfter ?? 0) > 0}>
        <button
          type="button"
          class="oq-sarrow"
          style={{ color: color("arrows") }}
          aria-label={ctx.t("strip.next")}
          onClick={() => step(1)}
        >
          {` +${layout()?.hiddenAfter ?? 0} ›`}
        </button>
      </Show>
    </div>
  );
}
