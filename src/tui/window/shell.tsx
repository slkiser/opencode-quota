/** @jsxImportSource @opentui/solid */
/**
 * The quota window. `/quota`, `/quota_usage`, `/quota_status` and `/quota_settings` open it
 * above the message box of a session, where it covers the chat
 * with the same size on every tab: Usage, Limits, Plugin and the Settings tabs Layout, Colors
 * and Providers (`settings.tsx`); Layout has pages, All places and one per place. The tab bar is
 * one line: the window's title and the plugin's version, the tabs, and "esc" at its right end to
 * close the window. When its tabs don't fit, it drops the "Settings" label, then shows the tabs
 * around the current one between ‹ and ›. Usage keeps its range list and Layout its page list
 * left of the scrolling tab body (`rail.tsx`); a Settings tab's switch and warning sit above
 * that body. The bottom line lists the tab's keys (Usage's as key and label pairs); the Settings
 * tabs have Save and Discard above it. While the window is focused (it is after opening; click
 * it to give it the keyboard again) its keys work: ↑↓ select or scroll,
 * space/enter use a line, ←/→ change it, c on Limits copies its limits as text, tab switches
 * tabs, esc closes (the line rules are `option-line.ts`'s). Closing gives the keyboard back to
 * whatever had it before. Plugin shows the maintainer notices, the switches for other tools and
 * the status report (`plugin-tab.tsx`).
 */
import type { Plugin } from "@opencode/plugin/tui";
import type { BoxRenderable, Renderable, RGBA, ScrollBoxRenderable } from "@opentui/core";
import type { JSX } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { DEFAULT_USAGE_RANGE } from "../../core/usage-ranges.js";
import { quotaLimitsText } from "../../lib/quota-report-message.js";
import { getPackageVersion } from "../../lib/version.js";
import { columnsOf } from "../../view/columns.js";
import type { ClientHost } from "../client.js";
import type { SettingsTab } from "../display.js";
import { KEY_LAYERS } from "../key-layers.js";
import type { SurfaceHost } from "../sidebar.js";
import type { Theme } from "../theme.js";
import { type CopyWithToast, createPluginTab } from "./plugin-tab.js";
import { isSettingsTab, pagesRoom, SETTINGS_GROUPS, type SettingsEditor } from "./settings.js";
import { Choice, createUsageTab, USAGE_RAIL_WIDTH, type UsageChoice } from "./usage.js";
import { LimitsView } from "./views.js";

/** Columns inside the window until it knows its real width. */
const DEFAULT_WIDTH = 120;

export type WindowTab = "limits" | "usage" | "system" | SettingsTab;

/** A tab whose lines the window's own keys use (`option-line.ts` rules). */
type TabLines = {
  /** ↑↓: false past the first or last line, where the window scrolls. */
  select(delta: number): boolean;
  /** Space or enter. */
  activate(): void;
  /** ←/→. */
  step(delta: number): void;
};

/** A tab of the tab bar and the window tabs it shows: Layout shows one of its pages. */
type BarTab = { title: string; pages: readonly WindowTab[] };

/** The view tabs; the Settings tabs (`SETTINGS_GROUPS`) follow them under their own label. */
const TABS: ReadonlyArray<BarTab> = [
  { title: "Usage", pages: ["usage"] },
  { title: "Limits", pages: ["limits"] },
  { title: "Plugin", pages: ["system"] },
];
/** Every tab in the order the tab bar shows them and tab and shift+tab go through them. */
const BAR_TABS: ReadonlyArray<BarTab> = [...TABS, ...SETTINGS_GROUPS];

const WINDOW_TITLE = "OpenCode Quota";
const SETTINGS_LABEL = "Settings";
/** Between the tab bar's items. */
const TAB_GAP = 2;
/** "‹" or "›" and its gap. */
const ARROW_WIDTH = 1 + TAB_GAP;
/** The "esc" that closes the window, at the right end of the tab bar, and the gap before it. */
const CLOSE_WIDTH = "esc".length + TAB_GAP;

/** The tabs the tab bar shows, `first` to `last`, and whether "Settings" labels its group. */
const HINT_SEPARATOR = " · ";

/** The keyboard hint in `width` columns, its lines broken between " · " items, never inside one. */
export function hintLines(hint: string, width: number): string {
  const lines: string[] = [];
  for (const item of hint.split(HINT_SEPARATOR)) {
    const last = lines.length - 1;
    if (last >= 0 && columnsOf(lines[last] + HINT_SEPARATOR + item) <= width) {
      lines[last] += HINT_SEPARATOR + item;
    } else {
      lines.push(item);
    }
  }
  return lines.join("\n");
}

/** A key and what it does, for a tab's bottom line; without a key, a note such as "updating…". */
export type KeyHint = { key?: string; label: string };
const KEY_HINT_GAP = "  ";

function keyHintText(hint: KeyHint): string {
  return hint.key ? `${hint.key} ${hint.label}` : hint.label;
}

/** The key hints in `width` columns, two spaces apart, lines broken between hints, never inside one. */
export function keyHintLines(hints: readonly KeyHint[], width: number): KeyHint[][] {
  const lines: KeyHint[][] = [];
  let lineWidth = 0;
  for (const hint of hints) {
    const hintWidth = columnsOf(keyHintText(hint));
    const last = lines.at(-1);
    if (last && lineWidth + KEY_HINT_GAP.length + hintWidth <= width) {
      last.push(hint);
      lineWidth += KEY_HINT_GAP.length + hintWidth;
    } else {
      lines.push([hint]);
      lineWidth = hintWidth;
    }
  }
  return lines;
}

export type TabStrip = { first: number; last: number; settingsLabel: boolean };

/**
 * What fits in `room` columns after the window's title: every tab under both labels; every tab
 * with a │ before the Settings tabs; or the tabs around `active` between ‹ and ›.
 */
export function tabStrip(
  titles: readonly string[],
  settingsFrom: number,
  active: number,
  room: number,
): TabStrip {
  const runWidth = (first: number, last: number, label: boolean) => {
    let width = 0;
    for (let index = first; index <= last; index += 1) {
      width += titles[index].length + (index > first ? TAB_GAP : 0);
    }
    if (first < settingsFrom && last >= settingsFrom) {
      width += (label ? SETTINGS_LABEL.length : 1) + TAB_GAP;
    }
    return width;
  };
  const end = titles.length - 1;
  if (runWidth(0, end, true) <= room) return { first: 0, last: end, settingsLabel: true };
  if (runWidth(0, end, false) <= room) return { first: 0, last: end, settingsLabel: false };
  const fits = (first: number, last: number) =>
    runWidth(first, last, false) + (first > 0 ? ARROW_WIDTH : 0) + (last < end ? ARROW_WIDTH : 0) <=
    room;
  let first = active;
  let last = active;
  for (let grew = true; grew;) {
    grew = false;
    if (last < end && fits(first, last + 1)) {
      last += 1;
      grew = true;
    }
    if (first > 0 && fits(first - 1, last)) {
      first -= 1;
      grew = true;
    }
  }
  return { first, last, settingsLabel: false };
}

/** The theme tokens the window reads, besides the surfaces' ones (OpenCode's `ResolvedTheme`). */
export type WindowTheme = Theme & {
  text: Theme["text"] & { action: { primary: { focused: RGBA; selected: RGBA } } };
  background: { action: { primary: { focused: RGBA } }; raised: { high: RGBA } };
  border: { base: RGBA };
};

/** Returning false lets the key continue to the next layer. */
export type WindowKey = {
  bind: string;
  title: string;
  group: string;
  // OpenCode's keymap API types `run` this way.
  run: () => void | false;
};

/** What the window needs from OpenCode's TUI context (its theme and client types aren't installed). */
export type WindowHost = Pick<Plugin.Context, "keymap" | "renderer" | "themeMode" | "ui"> &
  ClientHost & { theme: WindowTheme };

/** The session on screen; undefined on Home. */
export function routeSessionID(api: {
  ui: { router: { current(): { type: string; sessionID?: string } } };
}): string | undefined {
  const route = api.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

const KEYS = "Quota window";

export type QuotaWindow = {
  /**
   * Opens the window on a tab, or switches to it; "settings" is the first Settings tab, and Usage
   * shows the default range. On Home it only says to open a session.
   */
  open(tab: WindowTab | "settings"): void;
  /** Opens the window on its Usage tab, on `choice`. */
  openUsage(choice: UsageChoice): void;
  /** The `session.composer.top` slot. */
  Slot(props: { sessionID: string }): JSX.Element;
};

export function createQuotaWindow(
  api: WindowHost,
  host: SurfaceHost,
  settings: SettingsEditor,
): QuotaWindow {
  const [tab, setTab] = createSignal<WindowTab>();
  /** The page each tab of the tab bar showed last, by its title: Layout goes back to it. */
  const lastPages = new Map<string, WindowTab>();
  let windowBox: BoxRenderable | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  /** What had the keyboard before the window opened (the message box), so closing gives it back. */
  let focusBefore: Renderable | null = null;
  /**
   * The window had the keyboard and nothing took it on purpose. A resize across the sidebar's
   * breakpoint makes OpenCode give the keyboard to its message box, and OpenCode can draw the
   * window again (a new box); the window then takes the keyboard back.
   */
  let keyboardWanted = false;
  /** The terminal was resized in this turn of the event loop. */
  let resizedThisTurn = false;
  const onResize = () => {
    resizedThisTurn = true;
    setTimeout(() => {
      resizedThisTurn = false;
    }, 0);
  };
  const usage = createUsageTab(api, () => scroll);
  const plugin = createPluginTab(api, settings, copyWithToast);
  /** The installed plugin's version from its package.json, like "v5.0.2", after the title. */
  const [version, setVersion] = createSignal("");
  void getPackageVersion().then((found) => {
    if (found) setVersion(`v${found}`);
  });

  /** The tab bar's tab that shows `shown`. */
  function barTabOf(shown: WindowTab | undefined): BarTab | undefined {
    return BAR_TABS.find((item) => shown !== undefined && item.pages.includes(shown));
  }

  /** The page a tab of the tab bar opens on: the one it showed last, else its first. */
  function pageOf(item: BarTab): WindowTab {
    return lastPages.get(item.title) ?? item.pages[0];
  }

  /**
   * Each tab asks the server again when it shows: Limits a refresh, the others their data. Usage
   * shows `choice`: the default range, unless a command named one.
   */
  function showTab(next: WindowTab, choice: UsageChoice = { range: DEFAULT_USAGE_RANGE }): void {
    const item = barTabOf(next);
    if (item) lastPages.set(item.title, next);
    settings.setTab(next);
    setTab(next);
    // A Settings line may have had the keyboard; it is gone with its tab.
    windowBox?.focus();
    const sessionID = routeSessionID(api);
    if (next === "limits") void host.quota.refresh("manual", sessionID);
    if (next === "system") plugin.show(sessionID);
    if (next === "usage") usage.choose(choice);
    if (next === "usage" && sessionID) usage.show(sessionID);
    scroll?.scrollTo(0);
  }

  /** Copies `text` and says in a toast titled `title` whether the terminal let it. */
  function copyWithToast(...[text, title, messages]: Parameters<CopyWithToast>): void {
    const copied = api.renderer.copyToClipboardOSC52(text);
    api.ui.toast.show({
      variant: copied ? "success" : "warning",
      title,
      message: copied ? messages.copied : messages.failed,
      duration: 4_000,
    });
  }

  /** c on Limits: every provider's limits as Web and Desktop /quota write them. */
  function copyLimits(sessionID: string): void {
    const snapshot = host.quota.snapshot(sessionID);
    if (!snapshot) {
      api.ui.toast.show({
        variant: "info",
        title: "Limits",
        message: "Quota is still loading.",
        duration: 4_000,
      });
      return;
    }
    const words = host.display().words;
    copyWithToast(quotaLimitsText({ ...snapshot, words }, Date.now()), "Limits", {
      copied: "Copied the limits report",
      failed: "This terminal doesn't allow copying.",
    });
  }

  /** Opens the window on `next`; on Usage, on `choice` (else the default range). */
  function open(next: WindowTab | "settings", choice?: UsageChoice): void {
    if (!routeSessionID(api)) {
      api.ui.toast.show({
        variant: "info",
        title: "OpenCode Quota",
        message: "Open a session first: the quota window opens above its message box.",
      });
      return;
    }
    if (tab() === undefined) focusBefore = api.renderer.currentFocusedRenderable;
    showTab(next === "settings" ? pageOf(BAR_TABS[TABS.length]) : next, choice);
    // The command leaves the message box focused; take the keyboard once it has settled.
    setTimeout(() => windowBox?.focus(), 50);
  }

  /** Esc or Close. With unsaved settings the bottom bar asks first. */
  function close(): void {
    if (settings.askBeforeClose()) return;
    settings.setTab(undefined);
    setTab(undefined);
    keyboardWanted = false;
    if (focusBefore && !focusBefore.isDestroyed) focusBefore.focus();
    focusBefore = null;
  }

  function switchTab(delta: number): void {
    const index = Math.max(0, BAR_TABS.indexOf(barTabOf(tab()) ?? BAR_TABS[0]));
    showTab(pageOf(BAR_TABS[(index + delta + BAR_TABS.length) % BAR_TABS.length]));
  }

  /**
   * The lines the window's own ↑↓, space, enter and ←/→ use: Plugin's. Usage and the Settings
   * tabs take those keys in their own layer; Limits has no lines.
   */
  const tabLines = (): TabLines | undefined => (tab() === "system" ? plugin : undefined);

  /** ↑↓ select the tab's next line; past the first or last one (or without lines) they scroll. */
  function select(delta: number): void {
    if (!tabLines()?.select(delta)) scroll?.scrollBy(delta);
  }

  function Window(props: { sessionID: string }): JSX.Element {
    const theme = () => api.theme;
    const [hasKeyboard, setHasKeyboard] = createSignal(false);
    const [width, setWidth] = createSignal(DEFAULT_WIDTH);
    const [nowMs, setNowMs] = createSignal(Date.now());
    // Reset times and the pace count on between snapshots.
    const clock = setInterval(() => setNowMs(Date.now()), 60_000);
    onCleanup(() => clearInterval(clock));
    const stopWatch = host.quota.watch(props.sessionID);
    onCleanup(stopWatch);

    // The window covers the whole chat, so it has the same size on every tab. OpenCode's
    // session column holds the messages box (its first child holds the messages scrollbox),
    // a one-line "Jump to latest" row, then the box with this slot and the message box. Room =
    // the column minus its 1-line bottom padding, the other rows, and whatever else sits in
    // that last box (the message box, queued prompts).
    const [roomHeight, setRoomHeight] = createSignal<number>();
    function measureRoom(): void {
      const box = windowBox;
      if (!box || box.isDestroyed) return;
      let child: Renderable = box;
      for (let parent = box.parent; parent; child = parent, parent = parent.parent) {
        const siblings = parent.getChildren();
        const messages = siblings[0];
        if (
          messages === child ||
          !messages?.getChildren().some((item) => "scrollChildIntoView" in item)
        ) {
          continue;
        }
        const otherRows = siblings
          .filter((item) => item !== child && item !== messages)
          .reduce((total, item) => total + item.height, 0);
        const room = Math.max(12, parent.height - 1 - otherRows - (child.height - box.height));
        if (room !== roomHeight()) queueMicrotask(() => setRoomHeight(room));
        return;
      }
    }
    onMount(() => {
      api.renderer.root.on("layout-changed", measureRoom);
      onCleanup(() => api.renderer.root.off("layout-changed", measureRoom));
    });
    api.renderer.on("resize", onResize);
    onCleanup(() => api.renderer.off("resize", onResize));
    // This window's own boxes: when OpenCode draws the window again, the new one may already
    // have set them before this one is cleaned up.
    let ownBox: BoxRenderable | undefined;
    let ownScroll: ScrollBoxRenderable | undefined;
    onCleanup(() => {
      if (windowBox === ownBox) windowBox = undefined;
      if (scroll === ownScroll) scroll = undefined;
    });

    // Keys work only while this box has the keyboard; the message box keeps its own keys.
    api.keymap.layer(() => ({
      target: () => windowBox,
      priority: KEY_LAYERS.window,
      // While a Settings line takes typed text, the keys go to its input.
      enabled: () => !settings.typing(),
      commands: [
        { bind: "up", title: "Previous line", group: KEYS, run: () => select(-1) },
        { bind: "down", title: "Next line", group: KEYS, run: () => select(1) },
        {
          bind: "pageup",
          title: "Scroll up one page",
          group: KEYS,
          run: () => scroll?.scrollBy(-(scroll.height || 1)),
        },
        {
          bind: "pagedown",
          title: "Scroll down one page",
          group: KEYS,
          run: () => scroll?.scrollBy(scroll.height || 1),
        },
        { bind: "space", title: "Use the line", group: KEYS, run: () => tabLines()?.activate() },
        { bind: "return", title: "Use the line", group: KEYS, run: () => tabLines()?.activate() },
        { bind: "left", title: "Change the line", group: KEYS, run: () => tabLines()?.step(-1) },
        { bind: "right", title: "Change the line", group: KEYS, run: () => tabLines()?.step(1) },
        {
          bind: "c",
          title: "Copy the limits report",
          group: KEYS,
          run: () => (tab() === "limits" ? copyLimits(props.sessionID) : false),
        },
        { bind: "tab", title: "Next tab", group: KEYS, run: () => switchTab(1) },
        { bind: "shift+tab", title: "Previous tab", group: KEYS, run: () => switchTab(-1) },
        { bind: "escape", title: "Close", group: KEYS, run: close },
      ],
    }));

    const settingsTab = () => {
      const shown = tab();
      return isSettingsTab(shown) ? shown : undefined;
    };
    const viewHint = () => {
      const end = "tab next tab · esc close";
      if (tab() === "limits") return `┃ where even use would be · c copy · ↑↓ scroll · ${end}`;
      return `↑↓ select · space/enter or click to use · ‹ › (or ←/→) change · ${end}`;
    };
    const hint = () =>
      settings.hint(tab() ?? "", hasKeyboard()) ??
      (hasKeyboard()
        ? viewHint()
        : "The keyboard is somewhere else (the message box, a dialog). Click this box to use ↑↓ space tab esc here.");
    /**
     * Usage's own key hints while the tab or one of its dates has the keyboard, unless the
     * bottom bar asks about unsaved settings.
     */
    const usageHints = (): KeyHint[] | undefined => {
      if (tab() !== "usage") return undefined;
      if (usage.typingDate()) return usage.hints();
      if (!hasKeyboard() || settings.hint(tab() ?? "", true) !== undefined) return undefined;
      return usage.hints();
    };
    /** Usage's key hints: each key bold in the text color, its label muted, two spaces apart. */
    const KeyHints = (hintProps: { hints: KeyHint[] }) => (
      <box flexDirection="column" flexShrink={0}>
        {keyHintLines(hintProps.hints, width()).map((line) => (
          <text wrapMode="none" selectable={false}>
            {line.flatMap((item, index) => [
              ...(index > 0
                ? [<span style={{ fg: theme().text.muted }}>{KEY_HINT_GAP}</span>]
                : []),
              ...(item.key ? [<b style={{ fg: theme().text.base }}>{item.key}</b>] : []),
              <span style={{ fg: theme().text.muted }}>
                {item.key ? ` ${item.label}` : item.label}
              </span>,
            ])}
          </text>
        ))}
      </box>
    );
    /** The title and the version, as the tab bar shows them. */
    const titleText = () => (version() ? `${WINDOW_TITLE} ${version()}` : WINDOW_TITLE);
    /** The drawn tab bodies' width: the scrollbar's column and a gap before it stay free. */
    const bodyWidth = () => width() - 2;
    const strip = () =>
      tabStrip(
        BAR_TABS.map((item) => item.title),
        TABS.length,
        Math.max(0, BAR_TABS.indexOf(barTabOf(tab()) ?? BAR_TABS[0])),
        width() - columnsOf(titleText()) - TAB_GAP - CLOSE_WIDTH,
      );
    const label = (text: string) => (
      <text fg={theme().text.base} wrapMode="none" selectable={false}>
        <b>{text}</b>
      </text>
    );
    const arrow = (text: string, delta: number) => (
      <text
        fg={theme().text.action.primary.selected}
        wrapMode="none"
        selectable={false}
        onMouseUp={settings.click(() => switchTab(delta))}
      >
        {text}
      </text>
    );
    /** The tab bar after the title: the shown tabs, with "Settings" or │ before the Settings tabs. */
    const stripItems = () => {
      const { first, last, settingsLabel } = strip();
      const items: JSX.Element[] = [];
      for (let index = first; index <= last; index += 1) {
        const item = BAR_TABS[index];
        if (index === TABS.length && index > first) {
          items.push(
            settingsLabel ? (
              label(SETTINGS_LABEL)
            ) : (
              <text fg={theme().text.muted} wrapMode="none" selectable={false}>
                │
              </text>
            ),
          );
        }
        items.push(
          <Choice
            label={item.title}
            active={barTabOf(tab()) === item}
            theme={theme()}
            run={settings.click(() => showTab(pageOf(item)))}
          />,
        );
      }
      return items;
    };

    return (
      <box
        ref={(element: BoxRenderable) => {
          windowBox = element;
          ownBox = element;
          element.on("focused", () => {
            keyboardWanted = true;
            setHasKeyboard(true);
          });
          element.on("blurred", () => {
            setHasKeyboard(false);
            // Decided once the event that took the keyboard is over: a resize took it (take it
            // back), or a click elsewhere or a dialog did (leave it). A box drawn again loses it
            // to its replacement, which takes it back.
            queueMicrotask(() => {
              if (windowBox !== element || element.isDestroyed) return;
              if (resizedThisTurn && keyboardWanted) element.focus();
              else keyboardWanted = false;
            });
          });
          // Drawn again while it had the keyboard: take it back once the new box is in place.
          if (keyboardWanted) {
            setTimeout(() => {
              if (keyboardWanted && windowBox === element) element.focus();
            }, 0);
          }
        }}
        focusable
        height={roomHeight()}
        border
        borderStyle="rounded"
        borderColor={hasKeyboard() ? theme().text.action.primary.selected : theme().border.base}
        paddingLeft={1}
        paddingRight={1}
        onMouseDown={() => {
          settings.pressed();
          if (!settings.typing()) windowBox?.focus();
        }}
        onSizeChange={function (this: BoxRenderable) {
          // Inside the border and the padding.
          const measured = this.width - 4;
          if (measured > 0 && measured !== width()) queueMicrotask(() => setWidth(measured));
        }}
      >
        <box flexDirection="row" flexShrink={0}>
          <box flexDirection="row" columnGap={TAB_GAP} flexGrow={1}>
            <text fg={theme().text.base} wrapMode="none" selectable={false}>
              <b>{WINDOW_TITLE}</b>
              <span style={{ fg: theme().text.muted }}>{version() ? ` ${version()}` : ""}</span>
            </text>
            <Show when={strip().first > 0}>{arrow("‹", -1)}</Show>
            {stripItems()}
            <Show when={strip().last < BAR_TABS.length - 1}>{arrow("›", 1)}</Show>
          </box>
          <text fg={theme().text.muted} selectable={false} onMouseUp={settings.click(close)}>
            esc
          </text>
        </box>
        <box
          flexDirection="row"
          // Basis 0: the tab body gets the room left over and scrolls; it never squeezes the rest.
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          marginTop={1}
        >
          <Show when={tab() === "usage"}>
            <usage.Rail />
          </Show>
          <Show when={settingsTab()}>
            {(shown: () => SettingsTab) => <settings.Pages tab={shown()} showPage={showTab} />}
          </Show>
          {/* On a short window a Settings tab's switch and warning end at the bottom line too. */}
          <box flexDirection="column" flexGrow={1} overflow="hidden">
            <Show when={settingsTab()}>
              {(shown: () => SettingsTab) => (
                <settings.Header tab={shown()} refocus={() => windowBox?.focus()} />
              )}
            </Show>
            <scrollbox
              ref={(element: ScrollBoxRenderable) => {
                scroll = element;
                ownScroll = element;
              }}
              flexGrow={1}
              flexBasis={0}
              minHeight={0}
            >
              <Show when={tab() === "system"}>
                <plugin.View width={bodyWidth()} />
              </Show>
              <Show when={tab() === "limits"}>
                <LimitsView
                  host={host}
                  sessionID={props.sessionID}
                  nowMs={nowMs()}
                  width={bodyWidth()}
                />
              </Show>
              <Show when={tab() === "usage"}>
                <usage.View width={bodyWidth() - USAGE_RAIL_WIDTH} keyTarget={() => windowBox} />
              </Show>
              <Show when={settingsTab()}>
                {(shown: () => SettingsTab) => (
                  <settings.Body
                    tab={shown()}
                    showPage={showTab}
                    host={host}
                    sessionID={props.sessionID}
                    box={() => windowBox}
                    scroll={() => scroll}
                    width={bodyWidth() - pagesRoom(shown())}
                    nowMs={nowMs()}
                  />
                )}
              </Show>
            </scrollbox>
          </box>
        </box>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <box flexDirection="row" gap={2}>
            <settings.Buttons
              tab={tab() ?? ""}
              host={host}
              sessionID={props.sessionID}
              box={() => windowBox}
              close={close}
            />
          </box>
          <Show
            when={usageHints()}
            fallback={
              <text fg={theme().text.muted} wrapMode="word" selectable={false}>
                {hintLines(hint(), width())}
              </text>
            }
          >
            {(hints: () => KeyHint[]) => <KeyHints hints={hints()} />}
          </Show>
        </box>
      </box>
    );
  }

  return {
    open,
    openUsage: (choice) => open("usage", choice),
    Slot: (props) => (
      <Show when={tab() !== undefined}>
        <Window sessionID={props.sessionID} />
      </Show>
    ),
  };
}
