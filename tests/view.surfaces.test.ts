/**
 * What every always-on surface draws for one fixed snapshot and one set of settings, at three
 * widths: the sidebar panel open and collapsed, the status line in "auto" and "one provider" detail,
 * and the toast in both layouts. Each surface reads its own section of the settings (names,
 * hidden rows, order, window, "runs out in …"), so a surface that reads another's shows here.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { defaultSettings } from "../src/settings/schema.js";
import type { QuotaClient } from "../src/tui/client.js";
import type { DisplaySettings } from "../src/tui/display.js";
import { createToasts } from "../src/tui/toasts.js";
import { visibleGroups } from "../src/view/select.js";
import {
  bigStatusLine,
  lineText,
  plainLines,
  sidebarPanel,
  statusLayout,
  statusLineInput,
} from "../src/view/text.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const provider = (...args: Parameters<typeof providerSnapshot>) =>
  providerSnapshot(args[0], args[1], args[2], { okAtMs: NOW, checkedAtMs: NOW, ...args[3] });

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    provider("anthropic", "Claude", [
      row("anthropic.five_hour", {
        label: "5h",
        window: "five_hour",
        percentRemaining: 58,
        resetsAt: at(134 * MINUTE),
        windowStartedAt: at(-166 * MINUTE),
      }),
      // Used far faster than it refills, so it runs out before its reset.
      row("anthropic.weekly", {
        label: "Weekly",
        window: "week",
        percentRemaining: 12,
        resetsAt: at((3 * 24 * 60 + 4 * 60) * MINUTE),
        windowStartedAt: at(-(3 * 24 * 60 + 20 * 60) * MINUTE),
      }),
    ]),
    provider("opencode", "OpenCode Zen", [
      row("opencode.balance", {
        label: "Balance",
        type: "balance",
        amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
      }),
    ]),
    provider(
      "copilot",
      "Copilot",
      [
        row("copilot.allowance", {
          account: "work",
          label: "Plan",
          window: "month",
          percentRemaining: 40,
        }),
        row("copilot.allowance", {
          account: "home",
          label: "Plan",
          window: "month",
          percentRemaining: 90,
        }),
      ],
      { error: { code: "timeout" } },
    ),
    provider("openrouter", "OpenRouter", [], { error: { code: "login_expired" } }),
  ],
  resetNotices: [],
  generatedAtMs: NOW,
  serverId: "server",
  revision: 1,
  sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
};

/** Each surface's own choices, so each shows something only its own section asks for. */
function settings(): DisplaySettings {
  const display = defaultSettings();
  display.sidebar.names = { "anthropic.five_hour": "Burst" };
  display.sidebar.hidden = ["opencode"];
  display.collapsed.runsOut = true;
  display.collapsed.window = { anthropic: "five_hour" };
  display.collapsed.providerOrder = ["openrouter"];
  display.statusLine.runsOut = true;
  display.statusLine.window = { anthropic: "week" };
  display.statusLine.hidden = ["copilot"];
  display.toast.names = { "anthropic.weekly": "Week" };
  display.toast.runsOut = false;
  display.toast.sessionTokens = true;
  display.toast.rowOrder = { anthropic: ["anthropic.weekly"] };
  return display;
}

function panel(display: DisplaySettings, width: number, open: boolean) {
  const { title, lines } = sidebarPanel(SNAPSHOT, display, { nowMs: NOW, width, open });
  return [title, ...lines.map(lineText)];
}

function statusLine(display: DisplaySettings, room: number) {
  const input = statusLineInput(SNAPSHOT, display, NOW);
  const layout = statusLayout(input, room, 0, "auto");
  const shown = layout.shown.map(lineText).join(display.layout.separator);
  return {
    auto: `${shown}${layout.hiddenAfter > 0 ? ` +${layout.hiddenAfter} ›` : ""}`,
    one: lineText(bigStatusLine(input, room)!),
  };
}

function toast(display: DisplaySettings, terminalWidth: number, snapshot = SNAPSHOT) {
  const show = vi.fn();
  const toasts = createToasts({
    show,
    display: () => display,
    terminalWidth: () => terminalWidth,
    quota: { snapshot: () => snapshot } as unknown as QuotaClient,
    isChildSession: () => false,
    now: () => NOW,
  });
  toasts.preview("ses_1");
  return String(show.mock.calls[0]?.[0].message).split("\n");
}

function surfaces(display: DisplaySettings, widths: readonly [number, number, number]) {
  const detailed = { ...display, toast: { ...display.toast, layout: "detailed" as const } };
  return widths.map((width) => ({
    width,
    open: panel(display, width, true),
    collapsed: panel(display, width, false),
    statusLine: statusLine(display, width * 2),
    grouped: toast(display, width + 20),
    detailed: toast(detailed, width + 20),
  }));
}

describe("every surface for one snapshot", () => {
  it("draws each surface at three widths from its own settings", () => {
    expect(surfaces(settings(), [24, 36, 48])).toEqual(GOLDEN);
  });

  it("titles a panel without lines, and leaves out tokens the sidebar doesn't show", () => {
    const quiet = settings();
    quiet.collapsed.show = false;
    quiet.sidebar.sessionTokens = false;
    expect(panel(quiet, 36, false)).toEqual(["▶ Quota (4 providers, 2 errors)"]);
    expect(panel(quiet, 36, true).at(-1)).toBe("OpenRouter  Sign in again");
    // Before the first snapshot: the titles alone.
    const view = { nowMs: NOW, width: 36 };
    expect(sidebarPanel(undefined, quiet, { ...view, open: true })).toEqual({
      title: "▼ Quota left",
      lines: [],
    });
    expect(sidebarPanel(undefined, quiet, { ...view, open: false }).title).toBe(
      "▶ Quota (0 providers)",
    );
  });
});

const GOLDEN = [
  {
    width: 24,
    open: [
      "▼ Quota left",
      "Claude",
      " Burst ██┃░░  58% 2h 14m",
      " 7d    █░┃░░  12%   3.2d",
      "       runs out in 13h",
      "",
      "Copilot (work)  Timed o…",
      " 30d   ██░░░  40%       ",
      "",
      "Copilot (home)",
      " 30d   █████  90%       ",
      "",
      "OpenRouter  Sign in aga…",
      "",
      "Session  12.3K in · 2.1…",
    ],
    collapsed: [
      "▶ Quota (4 providers, 2 errors)",
      "OpenRout… Sign in again",
      "Claude    Bur…   58%  2…",
      "OpenCode… $1,240.50 left",
      "Copilot…  30d    40%  T…",
      "Copilot…  30d    90%…   ",
    ],
    statusLine: {
      auto: "Claude 12% (runs out in 13h) +2 ›",
      one: "Claude 7d █░░░░┃░░░░ 12% left · 3.2d · runs out…",
    },
    grouped: [
      "Claude",
      "  Week ░░┃░  12% left  3.2d",
      "  5h   ██┃░  58% left  2h 14m",
      "OpenCode Zen",
      "  Balance  $1,240.50 left",
      "Copilot (work)  Timed out",
      "  30d  ██░░  40% left",
      "Copilot (home)",
      "  30d  ████  90% left",
      "OpenRouter  Sign in again",
      "Session  12.3K in · 2.10K out",
    ],
    detailed: [
      "Claude",
      "Week                     3.2d",
      "██░░░░░░░┃░░░░░░░░░  12% left",
      "5h                     2h 14m",
      "████████┃██░░░░░░░░  58% left",
      "",
      "OpenCode Zen",
      "Balance        $1,240.50 left",
      "",
      "Copilot (work)",
      "Timed out",
      "30d",
      "████████░░░░░░░░░░░  40% left",
      "",
      "Copilot (home)",
      "30d",
      "█████████████████░░  90% left",
      "",
      "OpenRouter",
      "Sign in again",
      "",
      "Session  12.3K in · 2.10K out",
    ],
  },
  {
    width: 36,
    open: [
      "▼ Quota left",
      "Claude",
      " Burst ████████┃█░░░░░░░  58% 2h 14m",
      " 7d    ██░░░░░░┃░░░░░░░░  12%   3.2d",
      "       runs out in 13h",
      "",
      "Copilot (work)  Timed out",
      " 30d   ███████░░░░░░░░░░  40%       ",
      "",
      "Copilot (home)",
      " 30d   ███████████████░░  90%       ",
      "",
      "OpenRouter  Sign in again",
      "",
      "Session  12.3K in · 2.10K out",
    ],
    collapsed: [
      "▶ Quota (4 providers, 2 errors)",
      "OpenRout… Sign in again",
      "Claude    Bur… ████┃░░░  58%  2h 14m",
      "OpenCode… $1,240.50 left",
      "Copilot…  30d  ███░░░░░  40%  Timed…",
      "Copilot…  30d  ███████░  90%        ",
    ],
    statusLine: {
      auto: "Claude 12% (runs out in 13h) · OpenCode Zen $1,240.50 left +1 ›",
      one: "Claude 7d █░░░░┃░░░░ 12% left · 3.2d · runs out in 13h",
    },
    grouped: [
      "Claude",
      "  Week ██░░░░░┃░░░░░░░░  12% left  3.2d",
      "  5h   ███████┃█░░░░░░░  58% left  2h 14m",
      "OpenCode Zen",
      "  Balance  $1,240.50 left",
      "Copilot (work)  Timed out",
      "  30d  ██████░░░░░░░░░░  40% left",
      "Copilot (home)",
      "  30d  ██████████████░░  90% left",
      "OpenRouter  Sign in again",
      "Session  12.3K in · 2.10K out",
    ],
    detailed: [
      "Claude",
      "Week                                 3.2d",
      "████░░░░░░░░░░┃░░░░░░░░░░░░░░░░  12% left",
      "5h                                 2h 14m",
      "██████████████┃███░░░░░░░░░░░░░  58% left",
      "",
      "OpenCode Zen",
      "Balance                    $1,240.50 left",
      "",
      "Copilot (work)",
      "Timed out",
      "30d",
      "████████████░░░░░░░░░░░░░░░░░░░  40% left",
      "",
      "Copilot (home)",
      "30d",
      "████████████████████████████░░░  90% left",
      "",
      "OpenRouter",
      "Sign in again",
      "",
      "Session              12.3K in · 2.10K out",
    ],
  },
  {
    width: 48,
    open: [
      "▼ Quota left",
      "Claude",
      " Burst █████████┃██░░░░░░░░  58% 2h 14m",
      " 7d    ██░░░░░░░┃░░░░░░░░░░  12%   3.2d",
      "       runs out in 13h",
      "",
      "Copilot (work)  Timed out",
      " 30d   ████████░░░░░░░░░░░░  40%       ",
      "",
      "Copilot (home)",
      " 30d   ██████████████████░░  90%       ",
      "",
      "OpenRouter  Sign in again",
      "",
      "Session  12.3K in · 2.10K out",
    ],
    collapsed: [
      "▶ Quota (4 providers, 2 errors)",
      "OpenRout… Sign in again",
      "Claude    Bur… ████┃█░░░░  58%  2h 14m",
      "OpenCode… $1,240.50 left",
      "Copilot…  30d  ████░░░░░░  40%  Timed out",
      "Copilot…  30d  █████████░  90%        ",
    ],
    statusLine: {
      auto: "Claude █░┃░░ 12% 3.2d (runs out in 13h) · OpenCode Zen $1,240.50 left · OpenRouter Sign in again",
      one: "Claude 7d █░░░░┃░░░░ 12% left · 3.2d · runs out in 13h",
    },
    grouped: [
      "Claude",
      "  Week ██░░░░░░░┃░░░░░░░░░░  12% left  3.2d",
      "  5h   █████████┃██░░░░░░░░  58% left  2h 14m",
      "OpenCode Zen",
      "  Balance  $1,240.50 left",
      "Copilot (work)  Timed out",
      "  30d  ████████░░░░░░░░░░░░  40% left",
      "Copilot (home)",
      "  30d  ██████████████████░░  90% left",
      "OpenRouter  Sign in again",
      "Session  12.3K in · 2.10K out",
    ],
    detailed: [
      "Claude",
      "Week                                           3.2d",
      "█████░░░░░░░░░░░░░░┃░░░░░░░░░░░░░░░░░░░░░  12% left",
      "5h                                           2h 14m",
      "██████████████████┃█████░░░░░░░░░░░░░░░░░  58% left",
      "",
      "OpenCode Zen",
      "Balance                              $1,240.50 left",
      "",
      "Copilot (work)",
      "Timed out",
      "30d",
      "████████████████░░░░░░░░░░░░░░░░░░░░░░░░░  40% left",
      "",
      "Copilot (home)",
      "30d",
      "█████████████████████████████████████░░░░  90% left",
      "",
      "OpenRouter",
      "Sign in again",
      "",
      "Session                        12.3K in · 2.10K out",
    ],
  },
];

/** A month with a known start and 28 of its 31 days left, and a month without a start. */
const SHARE_SNAPSHOT: QuotaSnapshot = {
  ...SNAPSHOT,
  providers: [
    provider("alibaba", "Alibaba", [
      row("alibaba.month", {
        label: "Token Plan",
        window: "month",
        percentRemaining: 0,
        resetsAt: at(28 * 24 * 60 * MINUTE),
        windowStartedAt: at(-3 * 24 * 60 * MINUTE),
      }),
    ]),
    provider("copilot", "Copilot", [
      row("copilot.allowance", {
        label: "Plan",
        window: "month",
        percentRemaining: 40,
        resetsAt: at(12 * 24 * 60 * MINUTE),
      }),
    ]),
  ],
};

describe("the percent reset style", () => {
  const percentStyle = (percent: DisplaySettings["words"]["percent"] = "left") => {
    const display = defaultSettings();
    display.words.reset = "percent";
    display.words.percent = percent;
    return display;
  };
  const statusOf = (display: DisplaySettings) => {
    const input = statusLineInput(SHARE_SNAPSHOT, display, NOW);
    return {
      auto: statusLayout(input, 200, 0, "auto").shown.map(lineText),
      one: lineText(bigStatusLine(input)!),
    };
  };

  it("writes the time share right after the percent on the status line, the time alone without a window start", () => {
    expect(statusOf(percentStyle())).toEqual({
      auto: ["Alibaba ░░░░┃ 0%/90% 28d", "Copilot ██░░░ 40% 12d"],
      one: "Alibaba 30d ░░░░░░░░░┃ 0% left/90% 28d",
    });
  });

  it("writes the time used when the percent is the share used", () => {
    expect(statusOf(percentStyle("used")).auto).toEqual([
      "Alibaba ┃████ 100% used/10% 28d",
      "Copilot ███░░ 60% used 12d",
    ]);
  });

  it("starts the reset a space after the percent in the sidebar, open and collapsed", () => {
    const lines = (open: boolean) =>
      sidebarPanel(SHARE_SNAPSHOT, percentStyle(), { nowMs: NOW, width: 40, open }).lines.map(
        lineText,
      );
    expect(lines(true).slice(0, 5)).toEqual([
      "Alibaba",
      " 30d ░░░░░░░░░░░░░░░░░░┃░   0%/90% 28d",
      "",
      "Copilot",
      " 30d ████████░░░░░░░░░░░░  40% 12d",
    ]);
    expect(lines(false)).toEqual([
      "Alibaba   30d  ░░░░░░░░░┃   0%/90% 28d",
      "Copilot   30d  ████░░░░░░  40% 12d",
    ]);
  });

  it("writes the time share right after the percent in the /quota text", () => {
    const display = percentStyle();
    const groups = visibleGroups(SHARE_SNAPSHOT, display, "sidebar", display.words);
    expect(plainLines({ groups, words: display.words, nowMs: NOW })).toEqual([
      "Alibaba Token Plan  0% left/90% 28d",
      "Copilot Plan        40% left      12d",
    ]);
  });

  it("writes the share next to the percent in toasts, without its slash where no percent comes before it", () => {
    const display = percentStyle();
    display.toast.sessionTokens = false;
    const detailed = { ...display, toast: { ...display.toast, layout: "detailed" as const } };
    expect(toast(display, 60, SHARE_SNAPSHOT)).toEqual([
      "Alibaba",
      "  30d ░░░░░░░░░░░░░░░░░┃░   0% left/90% 28d",
      "Copilot",
      "  30d ████████░░░░░░░░░░░  40% left  12d",
    ]);
    expect(toast(detailed, 30, SHARE_SNAPSHOT)).toEqual([
      "Alibaba",
      "30d     90% 28d",
      "░░░░┃   0% left",
      "",
      "Copilot",
      "30d         12d",
      "██░░░  40% left",
    ]);
  });
});
