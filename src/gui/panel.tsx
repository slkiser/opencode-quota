/** @jsxImportSource solid-js */
/**
 * The Quota tab in the session's side region, the TUI sidebar's Quota panel: open, every
 * provider the sidebar shows with its rows (bar in its level color, the even-use mark, percent,
 * reset time, "runs out in"), then the session's tokens; folded, a title with the providers and
 * errors, then the collapsed sidebar's one line per provider (when `collapsed.show` is on).
 * Click the title to fold or open it; plugin storage remembers that (`index.tsx`). The words and
 * the rows come from `surfaces-model.ts`. The rows of all providers share one set of columns
 * (`QuotaRows`), which quota toasts draw too.
 */
import type { Context } from "@opencode/plugin/gui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { QuotaSnapshot } from "../core/types.js";
import type { Settings } from "../settings/schema.js";
import { percentWord } from "../view/format.js";
import { type ColorRole } from "../view/text.js";
import {
  levelCss,
  panelView,
  pickedGroups,
  providerCounts,
  roleCss,
  type RowSettings,
  type SurfaceGroup,
  type SurfaceRow,
} from "./surfaces-model.js";

/** Reset times count down between snapshots. */
const CLOCK_MS = 60_000;

type PanelProps = {
  ctx: Context;
  snapshot: () => QuotaSnapshot | undefined;
  settings: () => Settings;
  open: () => boolean;
  setOpen: (open: boolean) => void;
};

export function Bar(props: { settings: RowSettings; row: SurfaceRow }) {
  const percent = () => props.row.percent ?? 0;
  return (
    <span class="oq-pbar" style={{ background: roleCss(props.settings, "empty") }}>
      <span
        class="oq-pfill"
        style={{
          width: `${Math.max(0, Math.min(100, percent()))}%`,
          background: levelCss(props.settings, percent(), props.row.paceLevel),
        }}
      />
      <Show when={props.row.evenLeft !== undefined}>
        <span
          class="oq-peven"
          style={{
            left: `${props.row.evenLeft ?? 0}%`,
            background: roleCss(props.settings, "label"),
          }}
        />
      </Show>
    </span>
  );
}

type RowsProps = {
  groups: SurfaceGroup[];
  settings: RowSettings;
  /** A group's error, or its "not checked yet". */
  state: (group: Pick<SurfaceGroup, "error" | "unchecked">) => string | undefined;
  /** Pixels between providers. */
  gap: number;
};

/**
 * Providers and their rows in one grid (`.oq-prows`), so each column (label, bar, percent, reset
 * time) starts and ends at the same x for every provider: each provider's name line, then a line
 * per row, then "runs out in" under the row's bar. The open panel and quota toasts
 * (`toast-rows.tsx`) draw these.
 */
export function QuotaRows(props: RowsProps) {
  const color = (role: ColorRole, row?: SurfaceRow) =>
    roleCss(props.settings, role, row?.percent, row?.paceLevel);
  return (
    <div class="oq-prows">
      <For each={props.groups}>
        {(group, index) => (
          <div class="oq-pgroup" style={{ "margin-top": index() > 0 ? `${props.gap}px` : 0 }}>
            <div class="oq-pname">
              <b style={{ color: color("provider") }}>{group.name}</b>
              <Show when={group.account}>
                {(account) => <span style={{ color: color("account") }}>{account()}</span>}
              </Show>
              <Show when={props.state(group)}>
                {(text) => (
                  <span style={{ color: color(group.error ? "error" : "value") }}>{text()}</span>
                )}
              </Show>
            </div>
            <For each={group.rows}>
              {(row) => (
                <>
                  <Show
                    when={row.percent !== undefined}
                    fallback={
                      <div class="oq-prow oq-plain">
                        <span style={{ color: color("label") }}>{row.name}</span>
                        <span style={{ color: color("value") }}>{row.value}</span>
                      </div>
                    }
                  >
                    <div class="oq-prow">
                      <span style={{ color: color("label", row) }}>{row.name}</span>
                      <Show when={props.settings.layout.bar !== "none"} fallback={<span />}>
                        <Bar settings={props.settings} row={row} />
                      </Show>
                      <span class="oq-pnum" style={{ color: color("percent", row) }}>
                        {row.value}
                      </span>
                      <span class="oq-pnum" style={{ color: color("reset", row) }}>
                        {row.reset}
                      </span>
                    </div>
                  </Show>
                  <Show when={row.pace}>
                    {(pace) => (
                      <div class="oq-ppace" style={{ color: color("warning") }}>
                        {pace().words}
                      </div>
                    )}
                  </Show>
                </>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

export function QuotaPanel(props: PanelProps) {
  const { ctx } = props;
  const [nowMs, setNowMs] = createSignal(Date.now());
  const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));

  const settings = () => props.settings();
  const color = (role: ColorRole, row?: SurfaceRow) =>
    roleCss(settings(), role, row?.percent, row?.paceLevel);
  const open = createMemo(() => {
    const shown = props.snapshot();
    return shown ? panelView(shown, settings(), nowMs()) : undefined;
  });
  const folded = createMemo(() => {
    const shown = props.snapshot();
    return shown ? pickedGroups(shown, settings(), "collapsed", nowMs()) : [];
  });
  const title = () => {
    if (props.open()) {
      const word = percentWord(settings().words);
      return word ? ctx.t("panel.titleWord", { word }) : ctx.t("panel.title");
    }
    const counts = providerCounts(folded());
    const providers = ctx.plural("panel.providers", counts.providers);
    return counts.errors > 0
      ? ctx.t("panel.foldedErrors", {
          providers,
          errors: ctx.plural("panel.errors", counts.errors),
        })
      : ctx.t("panel.folded", { providers });
  };
  const state = (group: Pick<SurfaceGroup, "error" | "unchecked">) =>
    group.error ?? (group.unchecked ? ctx.t("panel.notChecked") : undefined);

  return (
    <div class="oq-surface oq-panel" data-mode={ctx.appearance.mode()}>
      <button
        type="button"
        class="oq-panel-title"
        aria-expanded={props.open()}
        style={{ color: color("title") }}
        onClick={() => props.setOpen(!props.open())}
      >
        {props.open() ? "▾ " : "▸ "}
        {title()}
      </button>
      <Show when={props.snapshot()} fallback={<p class="oq-muted">{ctx.t("panel.loading")}</p>}>
        <Show when={props.open()}>
          <QuotaRows
            groups={open()?.groups ?? []}
            settings={settings()}
            state={state}
            gap={settings().layout.providerGap * 10}
          />
          <Show when={open()?.session}>
            {(session) => (
              <div
                class="oq-psession"
                style={{ "margin-top": `${settings().layout.providerGap * 10}px` }}
              >
                <b style={{ color: color("label") }}>{ctx.t("panel.session")}</b>{" "}
                <span style={{ color: color("value") }}>{session()}</span>
                <Show when={open()?.lowCache}>
                  {(text) => <div style={{ color: color("warning") }}>{text()}</div>}
                </Show>
              </div>
            )}
          </Show>
        </Show>
        <Show when={!props.open() && settings().collapsed.show}>
          <div class="oq-prows">
            <For each={folded()}>
              {(group) => (
                <>
                  <div class="oq-prow">
                    <span style={{ color: color("provider", group.row) }}>{group.title}</span>
                    <Show
                      when={group.row?.percent !== undefined ? group.row : undefined}
                      fallback={
                        <span
                          class="oq-pwide"
                          style={{ color: color(group.error ? "error" : "value") }}
                        >
                          {state(group) ?? group.row?.value ?? ""}
                        </span>
                      }
                    >
                      {(row) => (
                        <>
                          <Show when={settings().layout.bar !== "none"} fallback={<span />}>
                            <Bar settings={settings()} row={row()} />
                          </Show>
                          <span class="oq-pnum" style={{ color: color("percent", row()) }}>
                            {row().name} {row().value}
                          </span>
                          <span
                            class="oq-pnum"
                            style={{ color: color(group.error ? "error" : "reset", row()) }}
                          >
                            {group.error ?? row().reset}
                          </span>
                        </>
                      )}
                    </Show>
                  </div>
                  <Show when={group.row?.pace}>
                    {(pace) => (
                      <div class="oq-ppace" style={{ color: color("warning") }}>
                        {pace().words}
                      </div>
                    )}
                  </Show>
                </>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
