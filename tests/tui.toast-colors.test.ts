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
import { plainMessage, type ToastOptions } from "../src/tui/toasts.js";
import { DEFAULT_WORDS } from "../src/view/format.js";
import { visibleGroups } from "../src/view/select.js";
import { toastLines } from "../src/view/text.js";
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
    toastLayout: "grouped",
    room: 54,
    runsOut: true,
  });
}

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
    const percentColors = (levelBy: "left" | "pace") =>
      (
        coloredMessage(toast, THEME as unknown as Theme, {
          ...defaultDisplaySettings(),
          levelBy,
        }) as Array<string | Node>
      )
        .filter((child): child is Node => typeof child !== "string")
        .filter(({ props }) => String(props.children).endsWith("% left"))
        .map(({ props }) => [String(props.children).trim(), props.style.fg]);
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
    });
    const toast = lines();
    const message = plainMessage(toast);
    showToast({ variant: "info", message, duration: 9_000 }, toast);
    return { messages: shown.mock.calls.map(([options]) => options.message), message };
  }

  it("sends the colored spans once the TUI has drawn", () => {
    const { messages, message } = showOn();
    expect(messages).toHaveLength(1);
    expect(typeof messages[0]).not.toBe("string");
    expect(spansText(messages[0])).toBe(message);
  });

  it("sends the plain message when OpenCode's toast throws on the spans", () => {
    const { messages, message } = showOn({
      show: (toast) => {
        if (typeof toast.message !== "string") throw new Error("message must be a string");
      },
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(message);
  });

  it("sends the plain message before the TUI has drawn, or when making the spans fails", () => {
    const before = showOn({ drawn: false });
    expect(before.messages).toEqual([before.message]);
    // Without a JSX runtime, making a span throws.
    vi.unstubAllGlobals();
    const { messages, message } = showOn();
    expect(messages).toEqual([message]);
  });

  it("sends a toast without lines as it is", () => {
    const shown = vi.fn();
    const showToast = createToastShow({
      show: shown,
      theme: () => THEME as unknown as Theme,
      display: defaultDisplaySettings,
      owner: () => ({}) as Owner,
    });
    const toast = { variant: "success", title: "Quota available", message: "reset", duration: 1 };
    showToast(toast as ToastOptions);
    expect(shown.mock.calls).toEqual([[toast]]);
  });
});
