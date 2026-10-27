/** @jsxImportSource solid-js */
/**
 * The usage window's Cost and Tokens views: the big total with its sessions and range, the
 * provider lines with their shares, the daily chart by provider, the totals by token kind, the
 * "by type" bar, the Breakdown table by model, provider or day, and the share of tokens without
 * a price. A click on a model row opens that model's popup. The numbers come from
 * `usage-model.ts`, written with the shared money, token and share formatters.
 */
import type { Context } from "@opencode/plugin/gui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { UsageByType, UsageReport } from "../core/usage.js";
import { formatShare, formatTokens, formatUsd, LOW_CACHE_MARK } from "../view/format.js";
import { Chart } from "./chart.js";
import {
  type BreakdownRow,
  breakdownRows,
  type ChartData,
  modelDetail,
  typeShares,
  type UsageBreakdown,
  type UsageMode,
  usageView,
} from "./usage-model.js";

type UsageProps = {
  ctx: Context;
  report: UsageReport;
  mode: UsageMode;
  providerId?: string;
  /** What the numbers cover: the range, or the session. */
  rangeLabel: string;
};

const BREAKDOWNS: readonly UsageBreakdown[] = ["model", "provider", "day"];
/** The widest a breakdown row's bar gets, in pixels. */
const ROW_BAR_MAX = 260;
/** The breakdown shows this many rows at most. */
const ROWS_MAX = 40;

/** "2026-10-27" as a local day. */
function dayOf(date: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Writes values and days in the mode and the interface language. */
function formatters(ctx: Context, mode: UsageMode) {
  const value = (amount: number) => (mode === "cost" ? formatUsd(amount) : formatTokens(amount));
  const dateLabel = (date: string, long: boolean) =>
    new Intl.DateTimeFormat(
      ctx.locale.locale(),
      long
        ? { weekday: "short", month: "short", day: "numeric" }
        : { month: "short", day: "numeric" },
    ).format(dayOf(date));
  return { value, dateLabel };
}

function TypeBar(props: { ctx: Context; byType: UsageByType; format: (value: number) => string }) {
  const parts = () => typeShares(props.byType);
  return (
    <>
      <div class="oq-types">
        <For each={parts()}>
          {(part) => <span class={`oq-${part.type}`} style={{ width: `${part.share * 100}%` }} />}
        </For>
      </div>
      <div class="oq-legend">
        <For each={parts()}>
          {(part) => (
            <span class={`oq-${part.type}`}>
              <i />
              {props.ctx.t(`usage.type.${part.type}`)} <b>{props.format(part.value)}</b>
            </span>
          )}
        </For>
      </div>
    </>
  );
}

function ChartOrNote(props: { ctx: Context; chart: ChartData; mode: UsageMode; height: number }) {
  const format = () => formatters(props.ctx, props.mode);
  return (
    <Show
      when={props.chart.dates.length > 1}
      fallback={<p class="oq-note">{props.ctx.t("usage.chartNeedsDays")}</p>}
    >
      <Chart
        chart={props.chart}
        width={640}
        height={props.height}
        format={format().value}
        dateLabel={format().dateLabel}
        totalLabel={props.ctx.t("usage.total")}
      />
    </Show>
  );
}

/** The popup of one model of the breakdown; it closes when a new report no longer has the model. */
function ModelPopup(props: {
  ctx: Context;
  report: UsageReport;
  mode: UsageMode;
  modelKey: string;
  providerId?: string;
  rangeLabel: string;
  close: () => void;
}) {
  const { ctx } = props;
  const detail = () => modelDetail(props.report, props.mode, props.modelKey, props.providerId);
  createEffect(() => {
    if (!detail()) props.close();
  });
  return (
    <Show when={detail()}>
      {(shown) => (
        <ctx.ui.Dialog
          title={shown().name}
          description={ctx.t("model.share", {
            provider: shown().providerName,
            share: formatShare(shown().share),
            what: ctx.t(props.mode === "cost" ? "model.what.cost" : "model.what.tokens"),
          })}
          size="large"
          footer={
            <ctx.ui.Button variant="contrast" onClick={props.close}>
              {ctx.t("model.close")}
            </ctx.ui.Button>
          }
        >
          <div class="oq-window" data-mode={ctx.appearance.mode()}>
            <div class="oq-muted oq-small">{props.rangeLabel}</div>
            <div class="oq-kv">
              <div>
                <div class="oq-k">{ctx.t("model.cost")}</div>
                <div class="oq-v">
                  {shown().model.priced ? formatUsd(shown().model.costUsd) : ctx.t("usage.noPrice")}
                </div>
              </div>
              <div>
                <div class="oq-k">{ctx.t("model.tokens")}</div>
                <div class="oq-v">{formatTokens(shown().model.tokens)}</div>
              </div>
              <div>
                <div class="oq-k">{ctx.t("model.perMillion")}</div>
                <div class="oq-v">
                  {shown().perMillionUsd === undefined
                    ? "—"
                    : formatUsd(shown().perMillionUsd ?? 0)}
                </div>
              </div>
              <div>
                <div class="oq-k">{ctx.t("model.cacheHit")}</div>
                <div class="oq-v">{shown().cache?.text ?? "—"}</div>
              </div>
            </div>
            <ChartOrNote ctx={ctx} chart={shown().chart} mode={props.mode} height={150} />
            <div class="oq-pair">
              <div>
                <div class="oq-section">{ctx.t("usage.costByType")}</div>
                <TypeBar ctx={ctx} byType={shown().model.costByType} format={formatUsd} />
              </div>
              <div>
                <div class="oq-section">{ctx.t("usage.tokensByType")}</div>
                <TypeBar ctx={ctx} byType={shown().model.tokensByType} format={formatTokens} />
              </div>
            </div>
          </div>
        </ctx.ui.Dialog>
      )}
    </Show>
  );
}

export function UsageView(props: UsageProps) {
  const { ctx } = props;
  const [by, setBy] = createSignal<UsageBreakdown>("model");
  const view = () => usageView(props.report, props.mode, props.providerId);
  const rows = createMemo(() => breakdownRows(props.report, props.mode, by(), props.providerId));
  const most = createMemo(() => Math.max(...rows().map((item) => item.value), 0));
  const format = () => formatters(ctx, props.mode);
  const cost = () => props.mode === "cost";
  const other = (row: { costUsd: number; tokens: number }) =>
    cost() ? formatTokens(row.tokens) : formatUsd(row.costUsd);
  const rowName = (row: BreakdownRow) =>
    by() === "day" ? format().dateLabel(row.name, true) : row.name;
  const barWidth = (row: BreakdownRow) =>
    most() > 0 ? Math.max(1.5, (row.value / most()) * ROW_BAR_MAX) : 0;
  const openModel = (key: string) => {
    ctx.dialogs.open((dialog) => (
      <ModelPopup
        ctx={ctx}
        report={props.report}
        mode={props.mode}
        modelKey={key}
        providerId={props.providerId}
        rangeLabel={props.rangeLabel}
        close={dialog.close}
      />
    ));
  };

  return (
    <Show when={view().tokens.processed > 0} fallback={<p>{ctx.t("usage.empty")}</p>}>
      <div class="oq-top">
        <div>
          <div class="oq-total">{format().value(view().total)}</div>
          <div class="oq-muted oq-small">
            {[
              ctx.plural("usage.sessions", view().sessions),
              cost() ? ctx.t("usage.apiEstimate") : ctx.t("usage.processed"),
              props.rangeLabel,
            ].join(" · ")}
          </div>
          <div class="oq-providers">
            <For each={view().providers}>
              {(provider) => (
                <div class={`oq-provider oq-c${provider.color}`}>
                  <div class="oq-l1">
                    <span class="oq-dot" />
                    <span>{provider.name}</span>
                    <span class="oq-muted oq-small">
                      {ctx.plural("usage.sessions", provider.sessions)}
                    </span>
                    <span class="oq-amount">
                      {cost() ? formatUsd(provider.costUsd) : formatTokens(provider.tokens)}
                    </span>
                  </div>
                  <div class="oq-l2">
                    {cost()
                      ? ctx.t("usage.costShare", {
                          share: formatShare(provider.share),
                          tokens: formatTokens(provider.tokens),
                        })
                      : ctx.t("usage.tokenShare", {
                          share: formatShare(provider.share),
                          cost: formatUsd(provider.costUsd),
                        })}
                    {provider.unpricedTokens > 0 ? ` · ${ctx.t("usage.noPrice")}` : ""}
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <div>
          <div class="oq-section">
            {cost() ? ctx.t("usage.dailyCost") : ctx.t("usage.dailyTokens")}
          </div>
          <ChartOrNote ctx={ctx} chart={view().chart} mode={props.mode} height={230} />
        </div>
      </div>

      <div class="oq-section">{ctx.t("usage.totals")}</div>
      <div class="oq-totals">
        <div>
          <div class="oq-k">{ctx.t("usage.processedTokens")}</div>
          <div class="oq-v">{formatTokens(view().tokens.processed)}</div>
        </div>
        <div>
          <div class="oq-k">{ctx.t("usage.cachedInput")}</div>
          <div class="oq-v">{formatTokens(view().tokens.cachedInput)}</div>
        </div>
        <div>
          <div class="oq-k">{ctx.t("usage.uncachedInput")}</div>
          <div class="oq-v">{formatTokens(view().tokens.uncachedInput)}</div>
        </div>
        <div>
          <div class="oq-k">{ctx.t("usage.output")}</div>
          <div class="oq-v">{formatTokens(view().tokens.output)}</div>
        </div>
        <Show when={view().cacheSavingsUsd !== undefined}>
          <div>
            <div class="oq-k">{ctx.t("usage.cacheSavings")}</div>
            <div class="oq-v">{formatUsd(view().cacheSavingsUsd ?? 0)}</div>
          </div>
        </Show>
      </div>

      <div class="oq-section">
        {cost() ? ctx.t("usage.costByType") : ctx.t("usage.tokensByType")}
      </div>
      <TypeBar ctx={ctx} byType={view().byType} format={format().value} />

      <div class="oq-section">
        {ctx.t("usage.breakdown")}
        <div class="oq-seg">
          <For each={BREAKDOWNS}>
            {(item) => (
              <button type="button" aria-pressed={by() === item} onClick={() => setBy(item)}>
                {ctx.t(`usage.by.${item}`)}
              </button>
            )}
          </For>
        </div>
      </div>
      <table class="oq-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{ctx.t(`usage.by.${by()}`)}</th>
            <th>{cost() ? ctx.t("view.cost") : ctx.t("view.tokens")}</th>
            <th>{ctx.t("usage.column.share")}</th>
            <th>{cost() ? ctx.t("view.tokens") : ctx.t("view.cost")}</th>
            <Show when={by() === "model"}>
              <th>{ctx.t("usage.column.cache")}</th>
            </Show>
          </tr>
        </thead>
        <tbody>
          <For each={rows().slice(0, ROWS_MAX)}>
            {(row, index) => (
              <tr
                class={by() === "model" ? "oq-click" : undefined}
                onClick={() => {
                  if (by() === "model") openModel(row.key);
                }}
              >
                <td>{index() + 1}</td>
                <td class={row.color === undefined ? undefined : `oq-c${row.color}`}>
                  <Show when={row.color !== undefined}>
                    <span class="oq-dot" />{" "}
                  </Show>
                  {rowName(row)}
                  <Show when={!row.priced}>
                    {" "}
                    <span class="oq-chip">{ctx.t("usage.noPrice")}</span>
                  </Show>
                  <div class="oq-rowbar" style={{ width: `${barWidth(row)}px` }} />
                </td>
                <td>{cost() && !row.priced ? "—" : format().value(row.value)}</td>
                <td>{formatShare(row.share)}</td>
                <td>{other(row)}</td>
                <Show when={by() === "model"}>
                  <td class={row.cache?.low ? "oq-warning" : undefined}>
                    {row.cache ? row.cache.text : "—"}
                    {row.cache?.low ? ` ${LOW_CACHE_MARK}` : ""}
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={view().unpricedShare > 0}>
        <div class="oq-note">
          {ctx.t("usage.unpriced", { share: formatShare(view().unpricedShare) })}
        </div>
      </Show>
    </Show>
  );
}
