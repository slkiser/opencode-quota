/** @jsxImportSource solid-js */
/**
 * The usage window: a large dialog titled with the plugin's version, a header and one of three
 * views. The header has the provider filter, the sessions that count, the ranges, the views
 * (Cost, Tokens, Limits) and the refresh button, the same in every view; "Between" adds a row
 * with its two dates under it. It opens on Limits.
 *
 * Limits reads the quota snapshot of the folder on screen, with what it says about the session
 * on screen (its tokens, the providers serving its model). Cost and Tokens ask the server for a
 * usage report whenever the question changes; while a new one loads, the last stays on screen,
 * and an answer to an older question is dropped. A session scope counts the whole session, so
 * the ranges are off then, in every view; picking a range or the sessions on Limits shows Cost.
 * Refresh checks the providers again and, on Cost and Tokens, asks for the report again. The
 * session menu's item opens it on Cost for that session.
 */
import type { Context } from "@opencode/plugin/gui";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import type { UsageQuery, UsageReport } from "../core/usage.js";
import { rpcErrorMessage } from "../tui/client.js";
import { rangeDates } from "../view/usage.js";
import type { GuiQuota } from "./bridge.js";
import { displayOf, limitProviders } from "./limits-model.js";
import { LimitsView } from "./limits-view.js";
import {
  type UsageMode,
  usageProviders,
  usageQuery,
  type UsageScope,
  WINDOW_RANGES,
  type WindowRange,
} from "./usage-model.js";
import { UsageView } from "./usage-view.js";
import { PLUGIN_VERSION } from "./version.js";

export type WindowView = UsageMode | "limits";

const VIEWS: readonly WindowView[] = ["cost", "tokens", "limits"];
const SCOPES: readonly UsageScope[] = ["all", "session", "tree"];
/** How often the window updates the times it shows ("Checked 2m ago", reset times). */
const CLOCK_MS = 30_000;

/** The last report, with the range and sessions it was asked for (its label). */
type Answered = { report: UsageReport; range: WindowRange; scope: UsageScope };
type UsageState = { answered?: Answered; loading: boolean; error?: string };

type WindowProps = {
  ctx: Context;
  data: GuiQuota;
  /** The folder on screen (see `index.tsx`). */
  directory: () => string | undefined;
  /** The session on screen, when it runs on the app's own server. */
  sessionID: () => string | undefined;
  /** The view and the sessions that count when the window opens: Limits and all sessions. */
  view?: WindowView;
  scope?: UsageScope;
};

/** A local date like "2026-10-27". */
function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function UsageWindow(props: WindowProps) {
  const { ctx, data } = props;
  const today = new Date();
  const [view, setView] = createSignal<WindowView>(props.view ?? "limits");
  const [range, setRange] = createSignal<WindowRange>("7d");
  const [scope, setScope] = createSignal<UsageScope>(props.scope ?? "all");
  const [from, setFrom] = createSignal(
    localDate(new Date(today.getFullYear(), today.getMonth(), 1)),
  );
  const [to, setTo] = createSignal(localDate(today));
  const [limitProvider, setLimitProvider] = createSignal<string>();
  const [usageProvider, setUsageProvider] = createSignal<string>();
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [reloads, setReloads] = createSignal(0);
  const [refreshing, setRefreshing] = createSignal(false);
  const [usage, setUsage] = createSignal<UsageState>({ loading: false });

  const clock = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
  onCleanup(() => clearInterval(clock));
  // Watches the folder and session on screen, again whenever they change, until the window closes.
  createEffect(() => {
    onCleanup(data.watch(props.directory(), props.sessionID()));
  });

  const snapshot = () => data.snapshot(props.directory(), props.sessionID());
  const display = () => displayOf(snapshot());
  const failure = () => data.failure(props.directory());
  const failureText = () => {
    const shown = failure();
    if (!shown) return undefined;
    return shown.kind === "unavailable"
      ? ctx.t("window.unavailable")
      : ctx.t("window.error", { message: shown.message });
  };

  const query = createMemo<UsageQuery | undefined>(
    () => {
      if (view() === "limits") return undefined;
      return usageQuery({
        range: range(),
        scope: scope(),
        sessionID: props.sessionID(),
        from: from(),
        to: to(),
      });
    },
    undefined,
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  // Numbers every question, so an answer to an older one is dropped.
  let asked = 0;
  createEffect(() => {
    const current = query();
    // The window's own folder: the session's, for a window opened for one session.
    const directory = props.directory();
    reloads();
    if (!current) return;
    const call = ++asked;
    const asking = { range: untrack(range), scope: untrack(scope) };
    setUsage((previous) => ({ answered: previous.answered, loading: true }));
    data.usage(current, directory).then(
      (report) => {
        if (call === asked) setUsage({ answered: { report, ...asking }, loading: false });
      },
      (error: unknown) => {
        if (call === asked) setUsage({ loading: false, error: rpcErrorMessage(error) });
      },
    );
  });
  onCleanup(() => {
    asked += 1;
  });

  /** The providers the filter lists for the view on screen: [id, name]. */
  const providers = (): Array<[string, string]> => {
    if (view() === "limits") {
      const shown = snapshot();
      return shown ? limitProviders(shown) : [];
    }
    const answered = usage().answered;
    return answered ? usageProviders(answered.report) : [];
  };
  /** The picked provider when the view lists it; else all of them. */
  const picked = () => {
    const id = view() === "limits" ? limitProvider() : usageProvider();
    return providers().some(([providerId]) => providerId === id) ? id : undefined;
  };
  const pickProvider = (id: string | undefined) =>
    view() === "limits" ? setLimitProvider(id) : setUsageProvider(id);
  const providerName = () =>
    providers().find(([id]) => id === picked())?.[1] ?? ctx.t("provider.all");

  const rangeLabel = (answered: Answered) => {
    if (answered.scope !== "all") return ctx.t(`scope.${answered.scope}`);
    if (answered.range === "between") return rangeDates(answered.report) ?? ctx.t("range.between");
    return ctx.t(`range.${answered.range}`);
  };
  /** Why Cost and Tokens can't ask, when they can't. */
  const queryProblem = () => {
    if (view() === "limits" || query()) return undefined;
    return scope() !== "all" ? ctx.t("scope.needsSession") : ctx.t("range.badDates");
  };

  const pickRange = (next: WindowRange) => {
    setRange(next);
    if (view() === "limits") setView("cost");
  };
  const pickScope = (next: UsageScope) => {
    setScope(next);
    if (view() === "limits") setView("cost");
  };
  const refresh = () => {
    setRefreshing(true);
    if (view() !== "limits") setReloads((count) => count + 1);
    data.refresh(props.directory(), props.sessionID()).finally(() => setRefreshing(false));
  };

  // Like the TUI window's title: "OpenCode Quota v6.1.0".
  const title = PLUGIN_VERSION
    ? `${ctx.t("window.title")} v${PLUGIN_VERSION}`
    : ctx.t("window.title");
  const header: JSX.Element = (
    <div class="oq-head">
      {/* The menus' labels show the pick; each group names what it picks. */}
      <span role="group" aria-label={ctx.t("provider.filter")}>
        <ctx.ui.Menu
          trigger="button"
          icon="chevron-down"
          label={providerName()}
          items={[
            { label: ctx.t("provider.all"), onSelect: () => pickProvider(undefined) },
            { type: "separator" },
            ...providers().map(([id, name]) => ({ label: name, onSelect: () => pickProvider(id) })),
          ]}
          placement="bottom-start"
        />
      </span>
      <span role="group" aria-label={ctx.t("scope.label")}>
        <ctx.ui.Menu
          trigger="button"
          icon="chevron-down"
          label={ctx.t(`scope.${scope()}`)}
          items={SCOPES.map((item) => ({
            label: ctx.t(`scope.${item}`),
            onSelect: () => pickScope(item),
          }))}
          placement="bottom-start"
        />
      </span>
      <div class="oq-right">
        <div class="oq-seg">
          <For each={WINDOW_RANGES}>
            {(item) => (
              <button
                type="button"
                aria-pressed={view() !== "limits" && range() === item}
                disabled={scope() !== "all"}
                title={scope() !== "all" ? ctx.t("range.wholeSession") : undefined}
                onClick={() => pickRange(item)}
              >
                {ctx.t(`range.${item}`)}
              </button>
            )}
          </For>
        </div>
        <div class="oq-seg">
          <For each={VIEWS}>
            {(item) => (
              <button type="button" aria-pressed={view() === item} onClick={() => setView(item)}>
                {ctx.t(`view.${item}`)}
              </button>
            )}
          </For>
        </div>
        <ctx.ui.Tooltip value={ctx.t("window.refresh")}>
          <ctx.ui.IconButton
            icon="refresh"
            label={ctx.t("window.refresh")}
            busy={refreshing() || (view() !== "limits" && usage().loading)}
            onClick={refresh}
          />
        </ctx.ui.Tooltip>
      </div>
    </div>
  );
  // Under the header, so picking "Between" does not move the header's buttons.
  const dates: JSX.Element = (
    <Show when={view() !== "limits" && scope() === "all" && range() === "between"}>
      <div class="oq-between">
        {ctx.t("range.from")}
        <input
          type="date"
          value={from()}
          aria-label={ctx.t("range.from")}
          onChange={(event) => setFrom(event.currentTarget.value)}
        />
        {ctx.t("range.to")}
        <input
          type="date"
          value={to()}
          aria-label={ctx.t("range.to")}
          onChange={(event) => setTo(event.currentTarget.value)}
        />
      </div>
    </Show>
  );

  return (
    <ctx.ui.Dialog title={title} size="x-large">
      <div class="oq-window" data-mode={ctx.appearance.mode()}>
        {header}
        {dates}
        <Show when={failureText()}>{(text) => <p class="oq-error">{text()}</p>}</Show>
        <Switch>
          <Match when={view() === "limits"}>
            <Show
              when={snapshot()}
              fallback={
                <Show when={!failure()}>
                  <ctx.ui.Loader size="large" />
                  <p class="oq-note">{ctx.t("window.loading")}</p>
                </Show>
              }
            >
              {(shown) => (
                <LimitsView
                  ctx={ctx}
                  snapshot={shown()}
                  display={display()}
                  nowMs={nowMs()}
                  providerId={picked()}
                />
              )}
            </Show>
          </Match>
          <Match when={queryProblem()}>{(problem) => <p class="oq-note">{problem()}</p>}</Match>
          <Match when={usage().error}>
            {(error) => <p class="oq-error">{ctx.t("usage.error", { message: error() })}</p>}
          </Match>
          <Match when={usage().answered}>
            {(answered) => (
              <UsageView
                ctx={ctx}
                report={answered().report}
                mode={view() === "tokens" ? "tokens" : "cost"}
                providerId={picked()}
                rangeLabel={rangeLabel(answered())}
              />
            )}
          </Match>
          <Match when={usage().loading}>
            <ctx.ui.Loader size="large" />
            <p class="oq-note">{ctx.t("usage.loading")}</p>
          </Match>
        </Switch>
      </div>
    </ctx.ui.Dialog>
  );
}
