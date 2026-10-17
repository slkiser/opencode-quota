/** @jsxImportSource @opentui/solid */
/**
 * The quota window's Usage tab: tokens and API cost from OpenCode's own history, laid out by
 * `view/usage.ts`, and the model detail popup. The window puts the range list (`Rail`) left of
 * the scrolling content (`View`), a muted line between them. The content's first line has the
 * chosen range and its dates, and Cost and Tokens at its right; the Breakdown heading has Model
 * and Day at its right.
 *
 * The range list has the keyboard when the tab shows: ↑↓ change the range. → or enter give the
 * keyboard to the model rows: ↑↓ walk them, the current one highlighted, enter opens a model's
 * details and ← goes back to the range list. Anywhere in the tab: c cost, t tokens, b by model
 * or by day, p download new prices, and d types the dates of "Between": the two date boxes show
 * on the first line, enter goes to the next date and then applies them, tab switches dates, esc
 * gives the keyboard back. A click picks a range, Cost or Tokens, Model or Day, or opens a model.
 *
 * The tab keeps Cost or Tokens and Model or Day while the window is open and closed. Switching
 * to the tab, or opening the window on it, shows the default range; `/quota_usage <range>` and
 * the `/tokens_*` commands show theirs. Each show asks the server again. An answer that arrives
 * after a newer question is dropped.
 */
import {
  type InputRenderable,
  type MouseEvent,
  type Renderable,
  RGBA,
  type ScrollBoxRenderable,
  TextAttributes,
} from "@opentui/core";
import { type JSX, useTerminalDimensions } from "@opentui/solid";
import { createSignal, Show } from "solid-js";
import {
  DEFAULT_USAGE_RANGE,
  USAGE_RANGES,
  type UsageRange,
  usageRangeLabel,
} from "../../core/usage-ranges.js";
import type { UsageModelRow, UsageQuery, UsageReport } from "../../core/usage.js";
import { parseCalendarDate } from "../../lib/calendar-date.js";
import { sanitizeDisplayText } from "../../lib/display-sanitize.js";
import { QuotaRpc } from "../../rpc.js";
import {
  breakdownModels,
  modelDetailTitle,
  modelDetailView,
  rangeDates,
  type UsageBreakdown,
  type UsageLine,
  type UsageMode,
  type UsageRole,
  usageView,
} from "../../view/usage.js";
import { errorToast, quotaCallOptions, rpcErrorMessage } from "../client.js";
import { KEY_LAYERS } from "../key-layers.js";
import { Rail, railRoom } from "./rail.js";
import type { KeyHint, WindowHost, WindowKey, WindowTheme } from "./shell.js";

/** OpenCode's theme also has categorical hue scales, for things told apart by color. */
type UsageTheme = WindowTheme & { categorical?: ReadonlyArray<Record<number, RGBA>> };

type UsageResult =
  | { state: "loading" }
  | { state: "ready"; report: UsageReport }
  | { state: "failed"; message: string };

/** OpenCode's "large" dialog width (dialogWidth in its ui/dialog.tsx). */
const DIALOG_WIDTH = 88;
/** Room for " esc" after the model popup's title. */
const CLOSE_LABEL_ROOM = " esc".length;
const KEYS = "Usage";
/** An option's two spaces around its label, inside its raised background. */
const OPTION_PAD = 2;
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);
/** The content starts one column after the range list's line. */
const RANGE_LIST_GAP = 1;
/** What the window keeps left of the content: the range list, the line after it and a gap. */
export const USAGE_RAIL_WIDTH = railRoom(RANGE_LIST_GAP);

/** How each "by type" part is shaded, from the muted color (0) to the text color (1). */
const PART_SHADES: Record<string, number> = {
  "part:cacheRead": 0,
  "part:input": 0.45,
  "part:cacheWrite": 0.75,
  "part:output": 1,
};

/** Where the tab's keyboard is: the range list, or the content with its model rows. */
type Area = "ranges" | "content";

/** A range's line in the range list. */
function rangeId(range: UsageRange): string {
  return `quota-usage-range-${range}`;
}

/** The range list's items, each with its element id. */
const RANGE_ITEMS = USAGE_RANGES.map((item) => ({
  key: item.range,
  label: item.label,
  id: rangeId(item.range),
}));

/** A model row's element id, to scroll it into view. */
function modelRowId(index: number): string {
  return `quota-usage-model-${index}`;
}

function isBreakdownHeading(line: UsageLine): boolean {
  return line.length === 1 && line[0].role === "heading" && line[0].text === "Breakdown";
}

/** `from` moved `share` of the way to `to`. */
function mix(from: RGBA, to: RGBA, share: number): RGBA {
  const step = (a: number, b: number) => a + (b - a) * share;
  return RGBA.fromValues(
    step(from.r, to.r),
    step(from.g, to.g),
    step(from.b, to.b),
    step(from.a, to.a),
  );
}

type DateField = "from" | "to";

/** The first day of this month and today, local dates like "2026-10-01". */
function thisMonth(nowMs: number): { from: string; to: string } {
  const now = new Date(nowMs);
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${month}-${String(now.getDate()).padStart(2, "0")}` };
}

function roleColor(theme: UsageTheme, role: UsageRole): RGBA {
  if (role.startsWith("provider:")) {
    const scales = theme.categorical ?? [];
    const scale = scales[Number(role.slice("provider:".length)) % Math.max(1, scales.length)];
    return scale?.[200] ?? theme.hue.accent[500] ?? theme.text.base;
  }
  if (role.startsWith("part:"))
    return mix(theme.text.muted, theme.text.base, PART_SHADES[role] ?? 1);
  switch (role) {
    case "muted":
      return theme.text.muted;
    case "warning":
      return theme.text.feedback.warning.base;
    case "good":
      return theme.text.feedback.success.base;
    case "bar":
      return theme.hue.accent[500] ?? theme.text.base;
    default:
      return theme.text.base;
  }
}

/**
 * One view line as one text, each span in its role's color on its `back` role's color (a chart
 * cell shared by two providers); title and headings bold.
 */
function UsageLineText(props: {
  line: UsageLine;
  theme: UsageTheme;
  id?: string;
  selected?: boolean;
  onClick?: () => void;
}): JSX.Element {
  const theme = () => props.theme;
  return (
    <text id={props.id} wrapMode="none" flexShrink={0} onMouseUp={props.onClick}>
      {props.line.length === 0 ? " " : null}
      {props.line.map((part) => (
        <span
          style={{
            fg: props.selected
              ? theme().text.action.primary.focused
              : roleColor(theme(), part.role),
            // A span keeps a background once drawn: set one always, so a line let go clears it.
            bg: props.selected
              ? theme().background.action.primary.focused
              : part.back
                ? roleColor(theme(), part.back)
                : TRANSPARENT,
            bold: part.role === "title" || part.role === "heading",
          }}
        >
          {sanitizeDisplayText(part.text)}
        </span>
      ))}
    </text>
  );
}

/** A tab of the window's tab bar: bold and underlined when it is the current one. */
export function Choice(props: {
  label: string;
  active: boolean;
  theme: UsageTheme;
  run: () => void;
}): JSX.Element {
  return (
    <text
      fg={props.active ? props.theme.text.action.primary.selected : props.theme.text.muted}
      attributes={
        props.active ? TextAttributes.BOLD | TextAttributes.UNDERLINE : TextAttributes.NONE
      }
      wrapMode="none"
      selectable={false}
      onMouseUp={props.run}
    >
      {props.label}
    </text>
  );
}

/**
 * An option inside the Usage tab (cost or tokens, model or day): the current one bold on
 * a raised background, so a row of options reads apart from the tab bar's underlined tabs. On
 * the highlighted line (`lit`) the other options take its text color.
 */
export function Option(props: {
  label: string;
  active: boolean;
  lit?: boolean;
  theme: UsageTheme;
  run: () => void;
}): JSX.Element {
  const idle = () => (props.lit ? props.theme.text.action.primary.focused : props.theme.text.muted);
  return (
    <box
      paddingLeft={OPTION_PAD / 2}
      paddingRight={OPTION_PAD / 2}
      flexShrink={0}
      backgroundColor={props.active ? props.theme.background.raised.high : TRANSPARENT}
      onMouseUp={props.run}
    >
      <text
        fg={props.active ? props.theme.text.action.primary.selected : idle()}
        attributes={props.active ? TextAttributes.BOLD : TextAttributes.NONE}
        wrapMode="none"
        selectable={false}
      >
        {props.label}
      </text>
    </box>
  );
}

/** The model detail popup, in OpenCode's dialog: scrolls with ↑↓, closes with esc. */
function ModelDetail(props: {
  api: WindowHost;
  report: UsageReport;
  model: UsageModelRow;
  mode: UsageMode;
}): JSX.Element {
  const theme = () => props.api.theme as UsageTheme;
  const dimensions = useTerminalDimensions();
  // The dialog is its size's width, at most the terminal's minus 2, inside this box's paddings
  // (2 + 2). The lines below the title leave a column for the scrollbar; the title leaves room
  // for " esc".
  const innerWidth = () => Math.min(DIALOG_WIDTH, dimensions().width - 2) - 4;
  const width = () => innerWidth() - 1;
  const title = () => modelDetailTitle(props.report, props.model, innerWidth() - CLOSE_LABEL_ROOM);
  // The dialog starts a quarter of the way down; the title row and paddings take 4 rows.
  const maxHeight = () => Math.max(1, Math.floor(dimensions().height * 0.75) - 4);
  const lines = () =>
    modelDetailView(props.report, props.model, { mode: props.mode, width: width() });
  let scroll: ScrollBoxRenderable | undefined;
  props.api.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: "Scroll up", group: KEYS, run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll down", group: KEYS, run: () => scroll?.scrollBy(1) },
    ],
  }));
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row">
        <UsageLineText line={title()} theme={theme()} />
        <box flexGrow={1} />
        <text
          fg={theme().text.muted}
          flexShrink={0}
          selectable={false}
          onMouseUp={() => props.api.ui.dialog.clear()}
        >
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => {
          scroll = element;
        }}
        maxHeight={maxHeight()}
      >
        {lines()
          .slice(1)
          .map((line) => (
            <UsageLineText line={line} theme={theme()} />
          ))}
      </scrollbox>
    </box>
  );
}

/** A range to show, with its dates for "between". */
export type UsageChoice = { range: UsageRange; from?: string; to?: string };

export type UsageTab = {
  /** Puts the tab on a range; the next `show` asks for it. */
  choose(choice: UsageChoice): void;
  /** True while one of the Between dates has the keyboard. */
  typingDate(): boolean;
  /** Gives the range list the keyboard and asks the server for the report again, for the window's session. */
  show(sessionID: string): void;
  /** The tab's keys for the window's bottom line; they follow where the keyboard is. */
  hints(): KeyHint[];
  /** The range list, left of the window's scrolling content. */
  Rail(): JSX.Element;
  View(props: { width: number; keyTarget: () => Renderable | undefined }): JSX.Element;
};

/** `scroll`: the window's scrollbox, which keeps the current model row in view. */
export function createUsageTab(
  api: WindowHost,
  scroll: () => ScrollBoxRenderable | undefined,
): UsageTab {
  const [range, setRange] = createSignal<UsageRange>(DEFAULT_USAGE_RANGE);
  const [mode, setMode] = createSignal<UsageMode>("cost");
  const [breakdown, setBreakdown] = createSignal<UsageBreakdown>("model");
  const [dates, setDates] = createSignal(thisMonth(Date.now()));
  const [area, setArea] = createSignal<Area>("ranges");
  /** The model row the content highlights while it has the keyboard (see `litModel`). */
  const [modelFocus, setModelFocus] = createSignal(0);
  const [result, setResult] = createSignal<UsageResult>({ state: "loading" });
  const [downloading, setDownloading] = createSignal(false);
  /** The two date boxes show on the first line in place of the dates. */
  const [editingDates, setEditingDates] = createSignal(false);
  let sessionID = "";
  let latestQuestion = 0;
  let fromInput: InputRenderable | undefined;
  let toInput: InputRenderable | undefined;
  let windowBox: () => Renderable | undefined = () => undefined;
  /** The date input that has the keyboard, if any. */
  const [dateFocus, setDateFocus] = createSignal<DateField>();

  function dateInput(field: DateField): InputRenderable | undefined {
    return field === "from" ? fromInput : toInput;
  }

  async function load(): Promise<void> {
    const question = ++latestQuestion;
    const query: UsageQuery = { range: range(), sessionID };
    if (range() === "between") Object.assign(query, dates());
    setResult({ state: "loading" });
    try {
      const { report } = await api.client.rpc(QuotaRpc).usage(query, quotaCallOptions(api));
      if (question === latestQuestion) setResult({ state: "ready", report });
    } catch (error) {
      if (question !== latestQuestion) return;
      setResult({ state: "failed", message: sanitizeDisplayText(rpcErrorMessage(error)) });
    }
  }

  /** Shows the date boxes and gives the first one the keyboard once it is drawn. */
  function typeDates(): void {
    setEditingDates(true);
    setTimeout(() => fromInput?.focus(), 50);
  }

  /** The range list keeps the keyboard; a click on "Between" (`typing`) types its dates. */
  function chooseRange(next: UsageRange, typing: boolean): void {
    setRange(next);
    setArea("ranges");
    void load();
    if (next === "between" && typing) typeDates();
  }

  /** Enter in a date: From goes on to To; To applies both when they are dates in order. */
  function submitDate(field: DateField): void {
    if (field === "from") {
      toInput?.focus();
      return;
    }
    const from = fromInput?.value.trim() ?? dates().from;
    const to = toInput?.value.trim() ?? dates().to;
    if (!parseCalendarDate(from) || !parseCalendarDate(to) || to < from) {
      api.ui.toast.show({
        variant: "warning",
        title: "Usage",
        message: "Type two dates like 2026-09-01, the first one not after the second.",
      });
      return;
    }
    setDates({ from, to });
    backToWindow();
    void load();
  }

  /** The keyboard back to the window; the dates show again in place of the boxes. */
  function backToWindow(): void {
    setDateFocus(undefined);
    setEditingDates(false);
    windowBox()?.focus();
  }

  async function downloadPrices(): Promise<void> {
    if (downloading()) return;
    setDownloading(true);
    try {
      const answer = await api.client.rpc(QuotaRpc).downloadPrices({}, quotaCallOptions(api));
      api.ui.toast.show({
        variant: answer.ok ? "success" : "error",
        title: "Prices",
        message: sanitizeDisplayText(answer.message),
        duration: 6_000,
      });
      if (answer.ok) void load();
    } catch (error) {
      api.ui.toast.show(errorToast(error, "Prices"));
    } finally {
      setDownloading(false);
    }
  }

  function readyReport(): UsageReport | undefined {
    const current = result();
    return current.state === "ready" ? current.report : undefined;
  }

  function failure(): string | undefined {
    const current = result();
    return current.state === "failed" ? current.message : undefined;
  }

  /** The models the breakdown shows as rows: none by day, without usage or without a report. */
  function modelRows(): UsageModelRow[] {
    const report = readyReport();
    return report && breakdown() === "model" ? breakdownModels(report, mode()) : [];
  }

  /**
   * The highlighted model row: while the content has the keyboard, the chosen row, or the last
   * one when a new report has fewer rows. Undefined without rows.
   */
  function litModel(): number | undefined {
    const count = modelRows().length;
    if (area() !== "content" || count === 0) return undefined;
    return Math.min(modelFocus(), count - 1);
  }

  function openModel(index: number): void {
    const report = readyReport();
    const model = modelRows()[index];
    if (!report || !model) return;
    setArea("content");
    setModelFocus(index);
    const shownMode = mode();
    api.ui.dialog.show(() => (
      <ModelDetail api={api} report={report} model={model} mode={shownMode} />
    ));
    api.ui.dialog.set({ size: "large" });
  }

  /** The breakdown's order follows the mode, so the first model row is the chosen one again. */
  function chooseMode(next: UsageMode): void {
    setMode(next);
    setModelFocus(0);
  }

  function chooseBreakdown(next: UsageBreakdown): void {
    setBreakdown(next);
    setModelFocus(0);
  }

  /** → or enter in the range list: the model rows get the keyboard, the first one in view. */
  function toModels(): ReturnType<WindowKey["run"]> {
    if (modelRows().length === 0) return false;
    setArea("content");
    setModelFocus(0);
    scroll()?.scrollChildIntoView(modelRowId(0));
  }

  /** ← in the content: the range list gets the keyboard back, the content its top line. */
  function toRanges(): void {
    setArea("ranges");
    scroll()?.scrollTo(0);
  }

  /**
   * ↑↓: the next range in the range list (applied at once); in the content the next model row,
   * scrolled into view. Past the first or last row, or without rows, the window scrolls.
   */
  function move(delta: number): ReturnType<WindowKey["run"]> {
    if (area() === "ranges") {
      const index = USAGE_RANGES.findIndex((item) => item.range === range());
      const next = USAGE_RANGES[index + delta];
      if (next) chooseRange(next.range, false);
      return;
    }
    const current = litModel();
    if (current === undefined) return false;
    const next = current + delta;
    if (next < 0 || next >= modelRows().length) return false;
    setModelFocus(next);
    scroll()?.scrollChildIntoView(modelRowId(next));
  }

  /** Enter: in the range list the model rows get the keyboard; in the content it opens the model. */
  function enter(): ReturnType<WindowKey["run"]> {
    if (area() === "ranges") return toModels();
    const model = litModel();
    if (model !== undefined) openModel(model);
  }

  function hints(): KeyHint[] {
    const field = dateFocus();
    if (field) {
      return [
        { key: "enter", label: field === "from" ? "next date" : "apply" },
        { key: "tab", label: "other date" },
        { key: "esc", label: "back" },
      ];
    }
    const hasRows = modelRows().length > 0;
    let moves: KeyHint[];
    if (area() === "ranges") {
      moves = [{ key: "↑↓", label: "range" }, ...(hasRows ? [{ key: "→", label: "models" }] : [])];
    } else if (hasRows) {
      moves = [
        { key: "↑↓", label: "models" },
        { key: "enter", label: "details" },
        { key: "←", label: "ranges" },
      ];
    } else {
      moves = [
        { key: "↑↓", label: "scroll" },
        { key: "←", label: "ranges" },
      ];
    }
    return [
      ...moves,
      ...(range() === "between" ? [{ key: "d", label: "type dates" }] : []),
      { key: "c", label: "cost" },
      { key: "t", label: "tokens" },
      { key: "b", label: "by model/day" },
      downloading() ? { label: "updating prices…" } : { key: "p", label: "update prices" },
      { key: "tab", label: "next tab" },
      { key: "esc", label: "close" },
    ];
  }

  /** The ranges (`rail.tsx`); a click picks one, and on "Between" types its dates. */
  function RangeList(): JSX.Element {
    return (
      <Rail
        items={RANGE_ITEMS}
        chosen={range()}
        theme={api.theme}
        gap={RANGE_LIST_GAP}
        pick={(next) => chooseRange(next, true)}
      />
    );
  }

  function View(props: { width: number; keyTarget: () => Renderable | undefined }): JSX.Element {
    const theme = () => api.theme as UsageTheme;
    windowBox = props.keyTarget;
    // A key's `window` action runs while the window has the keyboard, its `date` action while a
    // date input inside the window has it. A key without the action, or an action that returns
    // false, goes on to the window's own keys; letters and digits a date has no key for reach
    // the input.
    const keys: Array<{
      bind: string;
      title: string;
      window?: WindowKey["run"];
      date?: (field: DateField) => void;
    }> = [
      { bind: "up", title: "Previous range or model", window: () => move(-1) },
      { bind: "down", title: "Next range or model", window: () => move(1) },
      {
        bind: "right",
        title: "To the models",
        window: () => (area() === "ranges" ? toModels() : false),
        date: (field) => dateInput(field)?.moveCursorRight(),
      },
      {
        bind: "left",
        title: "Back to the ranges",
        window: () => (area() === "content" ? toRanges() : false),
        date: (field) => dateInput(field)?.moveCursorLeft(),
      },
      {
        bind: "return",
        title: "To the models, open a model, or the next date",
        window: enter,
        date: (field) => submitDate(field),
      },
      {
        bind: "tab",
        title: "Other date",
        date: (field) => dateInput(field === "from" ? "to" : "from")?.focus(),
      },
      { bind: "escape", title: "Back to the window", date: backToWindow },
      { bind: "c", title: "Show cost", window: () => chooseMode("cost") },
      { bind: "t", title: "Show tokens", window: () => chooseMode("tokens") },
      {
        bind: "b",
        title: "Breakdown by model or by day",
        window: () => chooseBreakdown(breakdown() === "model" ? "day" : "model"),
      },
      { bind: "p", title: "Update prices", window: () => void downloadPrices() },
      {
        bind: "d",
        title: "Type the dates",
        window: () => {
          if (range() === "between") typeDates();
        },
      },
    ];
    // Above the window's own keys; the window's target also covers the inputs inside it.
    api.keymap.layer(() => ({
      target: props.keyTarget,
      priority: KEY_LAYERS.tab,
      commands: keys.map((key) => ({
        bind: key.bind,
        title: key.title,
        group: KEYS,
        run: () => {
          const field = dateFocus();
          if (field) return key.date ? key.date(field) : false;
          return key.window ? key.window() : false;
        },
      })),
    }));

    const lines = () => {
      const report = readyReport();
      return report
        ? usageView(report, { mode: mode(), breakdown: breakdown(), width: props.width })
        : [];
    };
    /** The model rows follow the Breakdown heading and its column names (see `breakdownModels`). */
    const firstModelLine = () => {
      if (modelRows().length === 0) return Number.POSITIVE_INFINITY;
      return lines().findIndex(isBreakdownHeading) + 2;
    };
    const dateBox = (field: DateField) => (
      <input
        ref={(element: InputRenderable) => {
          if (field === "from") fromInput = element;
          else toInput = element;
          element.on("focused", () => setDateFocus(field));
          element.on("blurred", () => {
            setDateFocus((now) => (now === field ? undefined : now));
            // The keyboard went elsewhere (a click in the window): the dates show again.
            queueMicrotask(() => {
              if (dateFocus() === undefined) setEditingDates(false);
            });
          });
        }}
        // A date's 10 characters, the cursor after them, and the input's scroll margin.
        width={13}
        flexShrink={0}
        maxLength={10}
        value={dates()[field]}
        placeholder="YYYY-MM-DD"
        backgroundColor={theme().background.raised.high}
        textColor={theme().text.base}
        onMouseDown={(event: MouseEvent) => {
          // The window under the box would take the keyboard back and end the typing.
          event.stopPropagation();
          dateInput(field)?.focus();
        }}
      />
    );
    /** The report's dates after the range's name; a click on Between's types them. */
    const datesText = () => {
      const report = readyReport();
      const text = report ? rangeDates(report) : undefined;
      if (!text) return null;
      return (
        <text
          fg={theme().text.muted}
          wrapMode="none"
          flexShrink={0}
          selectable={false}
          onMouseUp={range() === "between" ? typeDates : undefined}
        >
          {`  ${text}`}
        </text>
      );
    };

    return (
      <box flexDirection="column" flexShrink={0} width={props.width}>
        <box flexDirection="row" flexShrink={0}>
          <text
            fg={theme().text.base}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            flexShrink={0}
            selectable={false}
          >
            {usageRangeLabel(range())}
          </text>
          <Show when={editingDates() && range() === "between"} fallback={datesText()}>
            <box flexDirection="row" columnGap={1} marginLeft={2} flexShrink={0}>
              {dateBox("from")}
              <text fg={theme().text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                to
              </text>
              {dateBox("to")}
            </box>
          </Show>
          <box flexGrow={1} />
          <Option
            label="Cost"
            active={mode() === "cost"}
            theme={theme()}
            run={() => chooseMode("cost")}
          />
          <Option
            label="Tokens"
            active={mode() === "tokens"}
            theme={theme()}
            run={() => chooseMode("tokens")}
          />
        </box>
        <box flexDirection="column" marginTop={1}>
          <Show when={result().state === "loading"}>
            <text fg={theme().text.muted}>Loading usage…</text>
          </Show>
          <Show when={failure()}>
            <text fg={theme().text.feedback.error.base} wrapMode="word">
              {`Couldn't load the usage: ${failure()}`}
            </text>
          </Show>
          {lines().map((line, index) => {
            if (isBreakdownHeading(line)) {
              return (
                <box flexDirection="row">
                  <UsageLineText line={line} theme={theme()} />
                  <box flexGrow={1} />
                  <box flexDirection="row" flexShrink={0}>
                    <Option
                      label="Model"
                      active={breakdown() === "model"}
                      theme={theme()}
                      run={() => chooseBreakdown("model")}
                    />
                    <Option
                      label="Day"
                      active={breakdown() === "day"}
                      theme={theme()}
                      run={() => chooseBreakdown("day")}
                    />
                  </box>
                </box>
              );
            }
            const model = index - firstModelLine();
            if (model < 0 || model >= modelRows().length) {
              return <UsageLineText line={line} theme={theme()} />;
            }
            return (
              <UsageLineText
                line={line}
                theme={theme()}
                id={modelRowId(model)}
                selected={litModel() === model}
                onClick={() => openModel(model)}
              />
            );
          })}
        </box>
      </box>
    );
  }

  return {
    choose(choice) {
      setRange(choice.range);
      if (choice.from && choice.to) setDates({ from: choice.from, to: choice.to });
      setArea("ranges");
    },
    typingDate: () => dateFocus() !== undefined,
    show(nextSessionID) {
      sessionID = nextSessionID;
      setArea("ranges");
      void load();
    },
    hints,
    Rail: RangeList,
    View,
  };
}
