/** @jsxImportSource solid-js */
/**
 * The strip at the bottom of the window (`window.bottom`), the TUI's status line: the same lines
 * from `view/text.ts` (`statusLayout`, or `bigStatusLine` for the "one" detail), in a fixed-width
 * font, each segment in its color role. It takes the window's width, measures its room in
 * characters (until then it shows every provider in full, cut at its edge), shows the most
 * detail that fits every provider, and pages when even "% only" does not fit: click "‹" or
 * "+N ›", or turn the mouse wheel. `statusLine.autoScrollSeconds` pages by itself;
 * `statusLine.width` caps its width. Click a provider to open the usage window.
 */
import type { Context } from "@opencode/plugin/gui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import {
  bigStatusLine,
  type Line,
  type StatusInput,
  statusLayout,
  statusLineInput,
} from "../view/text.js";
import { roleCss, segmentCss, stripRoom } from "./surfaces-model.js";

const CLOCK_MS = 60_000;
/** The strip's padding on both sides (`.oq-strip-bottom`). */
const PADDING_PX = 24;

type StripProps = {
  ctx: Context;
  snapshot: () => QuotaSnapshot | undefined;
  settings: () => Settings;
  openWindow: () => void;
};

function LineSpans(props: { line: Line; settings: Settings; onClick: () => void }) {
  return (
    <button type="button" class="oq-sline" onClick={() => props.onClick()}>
      <For each={props.line.segments}>
        {(segment) => (
          <span
            style={{
              color: segmentCss(props.settings, segment),
              "font-weight": segment.bold ? 600 : undefined,
            }}
          >
            {segment.text}
          </span>
        )}
      </For>
    </button>
  );
}

export function StatusStrip(props: StripProps) {
  const { ctx } = props;
  const [room, setRoom] = createSignal(0);
  const [start, setStart] = createSignal(0);
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));

  const [box, setBox] = createSignal<HTMLDivElement>();
  const [probe, setProbe] = createSignal<HTMLSpanElement>();
  // The room in characters: the strip's width over one character of its font.
  createEffect(() => {
    const strip = box();
    const character = probe();
    if (!strip || !character) return;
    const measure = () => {
      const cell = character.getBoundingClientRect().width / 10;
      if (cell > 0) setRoom(Math.max(0, Math.floor((strip.clientWidth - PADDING_PX) / cell) - 1));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    onCleanup(() => observer.disconnect());
  });

  const settings = () => props.settings();
  const input = (): StatusInput | undefined => {
    const shown = props.snapshot();
    return shown && statusLineInput(shown, settings(), nowMs());
  };
  const big = () => settings().statusLine.detail === "one";
  const layout = () => {
    const current = input();
    if (!current || big()) return undefined;
    const detail = settings().statusLine.detail;
    return statusLayout(current, stripRoom(room()), start(), detail === "one" ? "auto" : detail);
  };
  const count = () => input()?.groups.length ?? 0;
  const step = (delta: number) => setStart(Math.max(0, Math.min(count() - 1, start() + delta)));
  const color = (role: "arrows" | "separator") => roleCss(settings(), role);

  createEffect(() => {
    const seconds = settings().statusLine.autoScrollSeconds;
    if (!seconds) return;
    const timer = setInterval(() => {
      const current = layout();
      if (!current) return;
      setStart(current.hiddenAfter > 0 ? current.start + current.shown.length : 0);
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
      <span ref={setProbe} class="oq-probe" aria-hidden="true">
        0000000000
      </span>
      <Show when={big() ? input() : undefined}>
        {(current) => (
          <Show when={bigStatusLine(current(), room() || undefined)}>
            {(line) => <LineSpans line={line()} settings={settings()} onClick={props.openWindow} />}
          </Show>
        )}
      </Show>
      <Show when={layout()}>
        {(current) => (
          <>
            <Show when={current().start > 0 && current().shown.length > 0}>
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
            <For each={current().shown}>
              {(line, index) => (
                <>
                  <Show when={index() > 0}>
                    <span class="oq-ssep" style={{ color: color("separator") }}>
                      {settings().layout.separator}
                    </span>
                  </Show>
                  <LineSpans line={line} settings={settings()} onClick={props.openWindow} />
                </>
              )}
            </For>
            <Show when={current().hiddenAfter > 0 && current().shown.length > 0}>
              <button
                type="button"
                class="oq-sarrow"
                style={{ color: color("arrows") }}
                aria-label={ctx.t("strip.next")}
                onClick={() => step(1)}
              >
                {` +${current().hiddenAfter} ›`}
              </button>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
