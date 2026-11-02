/**
 * Colored quota toasts (`src/tui/toast-colors.tsx`): the spans of a toast's lines, and when
 * they are sent instead of the plain message. JSX builds plain `{ type, props }` nodes here.
 */
import type { Owner } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaRow } from "../src/core/types.js";
import { defaultDisplaySettings } from "../src/tui/display.js";
import type { Theme } from "../src/tui/theme.js";
import { coloredMessage, createToastShow } from "../src/tui/toast-colors.js";
import type { ToastOptions } from "../src/tui/toasts.js";
import { DEFAULT_WORDS } from "../src/view/format.js";
import { visibleGroups } from "../src/view/select.js";
import { type Line, lineText, toastLines } from "../src/view/text.js";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { stubJsx } from "./helpers/fake-tui-host.js";
import { type Node, THEME } from "./helpers/jsx-tree.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

const provider = (id: string, label: string, rows: QuotaRow[], extra = {}): ProviderSnapshot =>
  providerSnapshot(id, label, rows, { okAtMs: NOW, checkedAtMs: NOW, ...extra });

const PROVIDERS = [
  provider("anthropic", "Claude", [
    quotaRow("anthropic.five_hour", {
      label: "5h",
      window: "five_hour",
      percentRemaining: 58,
      resetsAt: at(134 * MINUTE),
    }),
    // Used far faster than it refills, so it runs out before its reset.
    quotaRow("anthropic.weekly", {
      label: "Weekly",
      window: "week",
      percentRemaining: 12,
      resetsAt: at((3 * 24 * 60 + 4 * 60) * MINUTE),
    }),
  ]),
  provider("openrouter", "OpenRouter", [], { error: { code: "login_expired" } }),
];

/** A grouped toast of `providers`, 54 columns wide. */
function lines(providers = PROVIDERS) {
  const display = defaultDisplaySettings();
  const snapshot = { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
  return toastLines({
    groups: visibleGroups(snapshot, display, "toast", DEFAULT_WORDS),
    words: DEFAULT_WORDS,
    nowMs: NOW,
    layout: display.layout,
    colors: display.colors,
    toastLayout: "grouped",
    room: 54,
    runsOut: true,
  });
}

/** A toast's lines as its plain message. */
const plainMessage = (toast: Line[]) => toast.map(lineText).join("\n");

/** The text of the spans, "\n" included, like OpenCode's <text> draws it. */
function spansText(spans: unknown): string {
  return (spans as Array<string | Node>)
    .map((child) => (typeof child === "string" ? child : String(child.props.children)))
    .join("");
}

beforeEach(() => {
  stubJsx({ components: "keep" });
});

describe("colored quota toasts", () => {
  it("colors each segment like the sidebar, with the plain message's characters", () => {
    const toast = lines();
    const spans = coloredMessage(toast, THEME as unknown as Theme, defaultDisplaySettings());
    expect(spansText(spans)).toBe(plainMessage(toast));
    const colored = (spans as Array<string | Node>)
      .filter((child): child is Node => typeof child !== "string")
      .map(({ props }) => [props.children, props.style.fg, props.style.bold]);
    expect(colored).toEqual([
      ["Claude", "text", true],
      ["  5h ", "text", false],
      ["█████████", "green", false],
      ["┃", "text", false],
      ["██", "green", false],
      ["░░░░░░░░", "muted", false],
      ["  58% left", "green", false],
      ["  2h 14m", "muted", false],
      ["  7d ", "text", false],
      ["██", "red", false],
      ["░░░░░░░", "muted", false],
      ["┃", "text", false],
      ["░░░░░░░░░░", "muted", false],
      ["  12% left", "red", false],
      ["  3.2d", "muted", false],
      ["     runs out in 13h", "yellow", false],
      ["OpenRouter", "text", true],
      ["  Sign in again", "red", false],
    ]);
  });

  it("colors the bars by pace when they follow it, and by the share left without a pace", () => {
    const toast = lines([
      provider("anthropic", "Claude", [
        // 15% left 10 minutes before the reset: plenty to spare.
        quotaRow("anthropic.five_hour", {
          label: "5h",
          window: "five_hour",
          percentRemaining: 15,
          resetsAt: at(10 * MINUTE),
        }),
        // 60% left with 5 of its 7 days to come: used faster than it refills.
        quotaRow("anthropic.weekly", {
          label: "Weekly",
          window: "week",
          percentRemaining: 60,
          resetsAt: at(5 * 24 * 60 * MINUTE),
        }),
        // No reset, so no pace: 15% left stays almost out.
        quotaRow("anthropic.monthly", { label: "Monthly", window: "month", percentRemaining: 15 }),
      ]),
      provider("zai", "Z.ai", [
        // 5% left 10 minutes into the window: too early for pace, and nearly used up.
        quotaRow("zai.five_hour", {
          label: "5h",
          window: "five_hour",
          percentRemaining: 5,
          resetsAt: at(290 * MINUTE),
        }),
      ]),
    ]);
    const percentColors = (levelBy: "left" | "pace") => {
      const display = defaultDisplaySettings();
      display.colors.levelBy = levelBy;
      return (coloredMessage(toast, THEME as unknown as Theme, display) as Array<string | Node>)
        .filter((child): child is Node => typeof child !== "string")
        .filter(({ props }) => String(props.children).endsWith("% left"))
        .map(({ props }) => [String(props.children).trim(), props.style.fg]);
    };
    expect(percentColors("left")).toEqual([
      ["15% left", "red"],
      ["60% left", "green"],
      ["15% left", "red"],
      ["5% left", "red"],
    ]);
    expect(percentColors("pace")).toEqual([
      ["15% left", "green"],
      ["60% left", "red"],
      ["15% left", "red"],
      ["5% left", "red"],
    ]);
  });

  /** The renderer's root in the fake OpenTUI trees below. */
  const ROOT = { parent: null };

  /** A toast shown through an OpenCode toast that `show` stands for, once the TUI has drawn. */
  function showOn({
    show = () => {},
    drawn = true,
  }: {
    show?: (toast: ToastOptions) => void;
    drawn?: boolean;
  } = {}) {
    const owner = drawn ? ({} as Owner) : undefined;
    const shown = vi.fn(show);
    const showToast = createToastShow({
      show: shown,
      theme: () => THEME as unknown as Theme,
      display: defaultDisplaySettings,
      owner: () => owner,
      root: () => ROOT,
    });
    const toast = lines();
    const message = plainMessage(toast);
    const drawnToast = showToast({ variant: "info", message, duration: 9_000 }, toast);
    return {
      messages: shown.mock.calls.map(([options]) => options.message),
      message,
      drawnToast,
    };
  }

  it("sends the colored spans once the TUI has drawn", () => {
    const { messages, message } = showOn();
    expect(messages).toHaveLength(1);
    expect(typeof messages[0]).not.toBe("string");
    expect(spansText(messages[0])).toBe(message);
  });

  /**
   * The spans' toast as OpenTUI holds it: the toast's box under the renderer's root, its message
   * box, OpenCode's <text>, and the root text node that keeps the <text>'s spans.
   */
  function drawnTree() {
    const { messages, drawnToast } = showOn();
    const first = (messages[0] as unknown as Array<string | (Node & { parent?: unknown })>).find(
      (child) => typeof child !== "string",
    )!;
    const toastBox = { parent: ROOT as object | null, isDestroyed: false };
    const messageBox = { parent: toastBox as object | null, isDestroyed: false };
    const text = { parent: messageBox as object | null, isDestroyed: false };
    const textRoot = { parent: null, textParent: text, children: [first] };
    first.parent = textRoot;
    return { onScreen: () => drawnToast?.onScreen(), first, toastBox, messageBox, text, textRoot };
  }

  it("tells that the spans' toast is on screen while they hang under the renderer's root", () => {
    // Not in a <text> yet.
    expect(showOn().drawnToast?.onScreen()).toBe(false);
    expect(drawnTree().onScreen()).toBe(true);
  });

  it("tells that a titled toast replaced the spans' toast, also once their <text> is destroyed", () => {
    const { onScreen, first, messageBox, text, textRoot } = drawnTree();
    // OpenCode's toast draws a titled toast in another box: OpenTUI unlinks the old one at once...
    messageBox.parent = null;
    expect(onScreen()).toBe(false);
    // ...and destroys it a moment later. The <text> empties its span list; the span keeps its parent.
    messageBox.isDestroyed = true;
    text.parent = null;
    text.isDestroyed = true;
    textRoot.children.length = 0;
    expect(first.parent).toBe(textRoot);
    expect(onScreen()).toBe(false);
  });

  it("tells that the toast closed, or that another message replaced the spans", () => {
    const closed = drawnTree();
    closed.toastBox.parent = null;
    expect(closed.onScreen()).toBe(false);
    const replaced = drawnTree();
    replaced.first.parent = null;
    expect(replaced.onScreen()).toBe(false);
  });

  it("answers false on a loop in the parents", () => {
    const { onScreen, toastBox } = drawnTree();
    toastBox.parent = toastBox;
    expect(onScreen()).toBe(false);
  });

  it("sends the plain message when OpenCode's toast throws on the spans", () => {
    const { messages, message, drawnToast } = showOn({
      show: (toast) => {
        if (typeof toast.message !== "string") throw new Error("message must be a string");
      },
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(message);
    // A plain message can't tell whether it is on screen.
    expect(drawnToast).toBeUndefined();
  });

  it("sends the plain message before the TUI has drawn, or when making the spans fails", () => {
    const before = showOn({ drawn: false });
    expect(before.messages).toEqual([before.message]);
    expect(before.drawnToast).toBeUndefined();
    // Without a JSX runtime, making a span throws.
    vi.unstubAllGlobals();
    const { messages, message, drawnToast } = showOn();
    expect(messages).toEqual([message]);
    expect(drawnToast).toBeUndefined();
  });

  it("sends a toast without lines as it is", () => {
    const shown = vi.fn();
    const showToast = createToastShow({
      show: shown,
      theme: () => THEME as unknown as Theme,
      display: defaultDisplaySettings,
      owner: () => ({}) as Owner,
      root: () => ROOT,
    });
    const toast = { variant: "success", title: "Quota available", message: "reset", duration: 1 };
    showToast(toast as ToastOptions);
    expect(shown.mock.calls).toEqual([[toast]]);
  });
});
