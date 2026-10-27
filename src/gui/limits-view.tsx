/** @jsxImportSource solid-js */
/**
 * The usage window's Limits view: the session's tokens, when the providers were checked, one
 * card per provider account with its rows, and the legend of the bar colors. Each row has its
 * bar in its level's color with the even-use mark, its percent in your words, when it resets,
 * and its pace. The words of each row come from `limits-model.ts`.
 */
import type { Context } from "@opencode/plugin/gui";
import { For, Show } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import { formatDuration, type Level } from "../view/format.js";
import {
  type GuiDisplay,
  type LimitRow,
  lastCheckedMs,
  limitCards,
  sessionStrip,
} from "./limits-model.js";

/** Each level's mark, so a level reads without its color too. */
const LEVEL_MARK: Record<Level, string> = { good: "●", warning: "▲", low: "■" };

type LimitsProps = {
  ctx: Context;
  snapshot: QuotaSnapshot;
  display: GuiDisplay;
  nowMs: number;
  providerId?: string;
};

function Row(props: { ctx: Context; row: LimitRow }) {
  const { ctx } = props;
  const evenLeft = () => props.row.evenLeft ?? 0;
  const resetAt = () => {
    const ms = props.row.resetsAtMs;
    if (ms === undefined) return "";
    return new Intl.DateTimeFormat(ctx.locale.locale(), {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(ms);
  };
  return (
    <Show
      when={props.row.percent !== undefined}
      fallback={
        <div class="oq-row oq-plain">
          <span class="oq-label">{props.row.name}</span>
          <span class="oq-value">{props.row.value}</span>
        </div>
      }
    >
      <div class={`oq-row oq-${props.row.level ?? "good"}`}>
        <span class="oq-label" title={props.row.name}>
          {props.row.name}
        </span>
        <div class="oq-bar">
          <div
            class="oq-fill"
            style={{ width: `${Math.max(0, Math.min(100, props.row.percent ?? 0))}%` }}
          />
          {/* Not `when={evenLeft}`: at a window's very end even use leaves 0, which is still a mark. */}
          <Show when={props.row.evenLeft !== undefined}>
            <div
              class="oq-even"
              style={{ left: `${evenLeft()}%` }}
              title={ctx.t("limits.evenUse", { percent: Math.round(evenLeft()) })}
            />
          </Show>
        </div>
        <span class="oq-value">
          <span class="oq-mark">{LEVEL_MARK[props.row.level ?? "good"]}</span> {props.row.value}
        </span>
        <div class="oq-sub">
          <span>
            {props.row.reset
              ? `${ctx.t("limits.resetsIn", { time: props.row.reset })} · ${resetAt()}`
              : ctx.t("limits.noReset")}
          </span>
          <Show when={props.row.pace}>
            {(pace) => (
              <span class={pace().fast ? "oq-pace oq-fast" : "oq-pace"}>{pace().words}</span>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}

export function LimitsView(props: LimitsProps) {
  const { ctx } = props;
  const cards = () => limitCards(props.snapshot, props.display, props.nowMs, props.providerId);
  const strip = () => sessionStrip(props.snapshot, props.display.words);
  const checked = () => {
    const ms = lastCheckedMs(props.snapshot);
    if (ms === undefined) return undefined;
    const ago = props.nowMs - ms;
    return ago < 60_000
      ? ctx.t("limits.checkedNow")
      : ctx.t("limits.checked", { time: formatDuration(ago, "short", 0) });
  };
  const pace = () => props.display.colors.levelBy === "pace";
  return (
    <>
      <Show when={strip()}>
        {(shown) => (
          <div class="oq-strip">
            <span class="oq-muted">
              {shown().tree ? ctx.t("limits.sessionTree") : ctx.t("limits.session")}
            </span>
            <span>
              {ctx.t("limits.input")} <b>{shown().input}</b>
            </span>
            <span>
              {ctx.t("limits.cached")} <b>{shown().cached}</b>
            </span>
            <span>
              {ctx.t("limits.output")} <b>{shown().output}</b>
            </span>
          </div>
        )}
      </Show>
      <Show when={checked()}>{(text) => <div class="oq-note">{text()}</div>}</Show>
      <Show when={cards().length > 0} fallback={<p>{ctx.t("limits.none")}</p>}>
        <div class="oq-grid">
          <For each={cards()}>
            {(card) => (
              <div class={card.current ? "oq-card oq-current" : "oq-card"}>
                <div class="oq-card-head">
                  <span class="oq-name">{card.name}</span>
                  <Show when={card.account}>
                    {(account) => <span class="oq-chip">{account()}</span>}
                  </Show>
                  <Show when={card.current}>
                    <span class="oq-chip oq-current-chip">{ctx.t("limits.current")}</span>
                  </Show>
                </div>
                <Show when={card.error}>{(error) => <div class="oq-error">{error()}</div>}</Show>
                <For each={card.rows}>{(row) => <Row ctx={ctx} row={row} />}</For>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div class="oq-legend">
        <span class="oq-good">
          <span class="oq-mark">{LEVEL_MARK.good}</span> {ctx.t("legend.good")}
        </span>
        <span class="oq-warning">
          <span class="oq-mark">{LEVEL_MARK.warning}</span>{" "}
          {ctx.t(pace() ? "legend.warningPace" : "legend.warning", {
            percent: props.display.colors.warningBelow,
          })}
        </span>
        <span class="oq-low">
          <span class="oq-mark">{LEVEL_MARK.low}</span>{" "}
          {ctx.t(pace() ? "legend.lowPace" : "legend.low", {
            percent: props.display.colors.lowBelow,
          })}
        </span>
        <Show when={props.display.evenUse}>
          <span>
            <i class="oq-even-key" />
            {ctx.t("legend.evenUse")}
          </span>
        </Show>
      </div>
    </>
  );
}
