import { describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import {
  ROLE_THEME,
  SURFACE_DEFAULTS,
  SURFACE_GROUPS,
  surfaceSettings,
} from "../src/gui/surface-settings.js";
import {
  currentModelPick,
  groupTone,
  levelCss,
  levelTone,
  panelView,
  pickedGroups,
  pickedText,
  providerCounts,
  roleCss,
  segmentCss,
  statusStripShows,
  stripLayout,
  toastView,
} from "../src/gui/surfaces-model.js";
import type { ClientSettings } from "../src/settings/index.js";
import { defaultSettings } from "../src/settings/schema.js";
import { THEME_COLORS } from "../src/tui/display.js";
import { wantsResetNotice } from "../src/tui/toasts.js";
import { listenForTurns, type SessionEvent } from "../src/tui/turn-events.js";
import { toastInput } from "../src/view/text.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    providerSnapshot(
      "anthropic",
      "Anthropic",
      [
        // An hour of five left: even use leaves 20%, and 30% is left.
        row("anthropic.five_hour", {
          label: "5h",
          window: "five_hour",
          percentRemaining: 30,
          resetsAt: new Date(NOW + HOUR).toISOString(),
        }),
        // Half the week gone, 10% left: it runs out before the reset.
        row("anthropic.week", {
          label: "Weekly",
          window: "week",
          percentRemaining: 10,
          resetsAt: new Date(NOW + 84 * HOUR).toISOString(),
        }),
      ],
      { checkedAtMs: NOW - 60_000 },
    ),
    providerSnapshot(
      "openai",
      "OpenAI",
      [
        row("openai.week", {
          label: "Weekly",
          window: "week",
          percentRemaining: 80,
          resetsAt: new Date(NOW + 84 * HOUR).toISOString(),
        }),
      ],
      { checkedAtMs: NOW - 60_000 },
    ),
    providerSnapshot("zai", "Z.ai", [], { error: { code: "login_expired" } }),
  ],
  currentModelProviderIds: ["openai"],
  sessionTokens: { input: 12_300, cachedInput: 0, output: 2_100 },
  resetNotices: [],
  generatedAtMs: NOW,
  serverId: "server-1",
  revision: 1,
};

function withValues(values: Record<string, unknown>): QuotaSnapshot {
  const settings: ClientSettings = { values, fromFile: [], providers: [], custom: [] };
  return { ...SNAPSHOT, settings };
}

function settingsWith(values: Record<string, unknown>) {
  const snapshot = withValues(values);
  return { snapshot, settings: surfaceSettings(snapshot) };
}

describe("GUI surface settings", () => {
  it("copies the schema's defaults of every group the surfaces read", () => {
    const defaults = defaultSettings();
    for (const group of SURFACE_GROUPS) {
      expect(SURFACE_DEFAULTS[group], group).toEqual(defaults[group]);
    }
  });

  it("copies the TUI's theme color of every role", () => {
    expect(ROLE_THEME).toEqual(THEME_COLORS);
  });

  it("puts the snapshot's values over the defaults, and only into the surface groups", () => {
    const settings = surfaceSettings(
      withValues({
        "sidebar.show": false,
        "statusLine.window": { anthropic: "week" },
        "providers.off": ["zai"],
        "constructor.name": "x",
      }),
    );
    expect(settings.sidebar.show).toBe(false);
    expect(settings.statusLine.window).toEqual({ anthropic: "week" });
    expect(settings.toast.seconds).toBe(9);
    expect("providers" in settings).toBe(false);
    expect(surfaceSettings(undefined)).toEqual(SURFACE_DEFAULTS);
  });
});

describe("GUI Quota panel", () => {
  it("shows the sidebar's providers in its order, with your names, runs-out and the session", () => {
    const { snapshot, settings } = settingsWith({
      "sidebar.providerOrder": ["openai"],
      "sidebar.hidden": ["anthropic.five_hour"],
      "sidebar.names": { "anthropic.week": "Week" },
    });
    const view = panelView(snapshot, settings, NOW);
    expect(view.groups.map((group) => group.providerId)).toEqual(["openai", "anthropic", "zai"]);
    const anthropic = view.groups[1];
    expect(anthropic?.rows.map((item) => item.name)).toEqual(["Week"]);
    expect(anthropic?.rows[0]).toMatchObject({ value: "10%", level: "low" });
    expect(anthropic?.rows[0]?.pace?.words).toMatch(/^runs out in /u);
    expect(view.groups[2]).toMatchObject({ error: expect.any(String), rows: [] });
    expect(view.session).toBe("12.3K in · 2.10K out");
  });

  it("leaves out runs-out and the session when they are off, and hides providers", () => {
    const { snapshot, settings } = settingsWith({
      "sidebar.runsOut": false,
      "sidebar.sessionTokens": false,
      "sidebar.hidden": ["zai"],
    });
    const view = panelView(snapshot, settings, NOW);
    expect(view.groups.map((group) => group.providerId)).toEqual(["anthropic", "openai"]);
    expect(view.groups[0]?.rows.every((item) => item.pace === undefined)).toBe(true);
    expect(view.session).toBeUndefined();
  });
});

describe("GUI quota toast", () => {
  it("shows the toast's providers as the panel's rows, each percent with its word", () => {
    const { snapshot, settings } = settingsWith({ "toast.names": { "anthropic.week": "Week" } });
    const balance = providerSnapshot("openrouter", "OpenRouter", [
      row("openrouter.balance", {
        label: "Balance",
        type: "balance",
        amount: { decimal: "12.4", unit: { kind: "currency", code: "USD" } },
      }),
    ]);
    const shown = { ...snapshot, providers: [...snapshot.providers, balance] };
    const view = toastView(toastInput(shown, settings, { nowMs: NOW, width: 51 }));

    expect(view.groups.map((group) => group.providerId)).toEqual([
      "anthropic",
      "openai",
      "zai",
      "openrouter",
    ]);
    const anthropic = view.groups[0];
    expect(anthropic?.rows.map((item) => item.name)).toEqual(["5h", "Week"]);
    expect(anthropic?.rows[1]).toMatchObject({ value: "10% left", level: "low" });
    expect(anthropic?.rows[1]?.pace?.words).toMatch(/^runs out in /u);
    expect(view.groups[2]).toMatchObject({ error: expect.any(String), rows: [] });
    const balanceRow = view.groups[3]?.rows[0];
    expect(balanceRow?.name).toBe("Balance");
    expect(balanceRow?.percent).toBeUndefined();
    expect(balanceRow?.value).toMatch(/12\.40/u);
    expect(view.session).toBe("12.3K in · 2.10K out");
  });
});

describe("GUI one-row surfaces", () => {
  it("picks each provider's row by the collapsed window, else the lowest", () => {
    const { snapshot, settings } = settingsWith({ "collapsed.hidden": ["zai"] });
    const lowest = pickedGroups(snapshot, settings, "collapsed", NOW);
    expect(lowest.map((group) => [group.providerId, group.row?.id])).toEqual([
      ["anthropic", "anthropic.week"],
      ["openai", "openai.week"],
    ]);
    const windowed = settingsWith({ "collapsed.window": { anthropic: "five_hour" } });
    const [anthropic] = pickedGroups(windowed.snapshot, windowed.settings, "collapsed", NOW);
    expect(anthropic?.row).toMatchObject({ id: "anthropic.five_hour", value: "30%" });
  });

  it("shows runs-out only when the surface's runsOut is on", () => {
    const off = settingsWith({});
    expect(
      pickedGroups(off.snapshot, off.settings, "collapsed", NOW)[0]?.row?.pace,
    ).toBeUndefined();
    const on = settingsWith({ "collapsed.runsOut": true });
    expect(pickedGroups(on.snapshot, on.settings, "collapsed", NOW)[0]?.row?.pace).toBeDefined();
  });

  it("writes a group's text: its percent, its pace, its error or not checked", () => {
    const { snapshot, settings } = settingsWith({ "collapsed.runsOut": true });
    const groups = pickedGroups(snapshot, settings, "collapsed", NOW);
    expect(pickedText(groups[0]!, "not checked yet")).toMatch(
      /^Anthropic 10% \(runs out in .+\)$/u,
    );
    expect(pickedText(groups[1]!, "not checked yet", true)).toBe("OpenAI 7d 80%");
    expect(pickedText(groups[2]!, "not checked yet")).toBe(`Z.ai ${groups[2]?.error}`);
    expect(pickedText({ ...groups[2]!, error: undefined, unchecked: true }, "not checked")).toBe(
      "Z.ai not checked",
    );
    expect(providerCounts(groups)).toEqual({ providers: 3, errors: 1 });
  });

  it("gives the composer pill the current model's provider, as the status line shows it", () => {
    const { snapshot, settings } = settingsWith({});
    const pick = currentModelPick(snapshot, settings, NOW);
    expect(pick).toMatchObject({ providerId: "openai", row: { value: "80% left", level: "good" } });
    expect(pick?.row?.pace?.words).toBe("plenty to spare");
    expect(levelTone(pick?.row?.level)).toBe("success");
    const hidden = settingsWith({ "statusLine.hidden": ["openai"] });
    expect(currentModelPick(hidden.snapshot, hidden.settings, NOW)).toBeUndefined();
    const noModel = { ...snapshot, currentModelProviderIds: undefined };
    expect(currentModelPick(noModel, settings, NOW)).toBeUndefined();
  });

  it("gives the composer pill a failed provider's error, in the danger tone", () => {
    const { snapshot, settings } = settingsWith({});
    const failed = { ...snapshot, currentModelProviderIds: ["zai"] };
    const pick = currentModelPick(failed, settings, NOW);
    expect(pick).toMatchObject({ providerId: "zai", error: expect.any(String) });
    expect(pickedText(pick!, "not checked yet", true)).toBe(`Z.ai ${pick?.error}`);
    expect(groupTone(pick!)).toBe("danger");
    expect(groupTone(currentModelPick(snapshot, settings, NOW)!)).toBe("success");
  });
});

describe("GUI bottom strip", () => {
  it("shows by default next to the Quota tab; Home has its own switch", () => {
    const shows = (values: Record<string, unknown>, home: boolean, panelOnScreen: boolean) =>
      statusStripShows(surfaceSettings(withValues(values)), { home, panelOnScreen });
    expect(shows({}, false, false)).toBe(true);
    expect(shows({}, false, true)).toBe(true);
    expect(shows({ "statusLine.withSidePanel": false }, false, true)).toBe(false);
    expect(shows({ "statusLine.withSidePanel": false }, false, false)).toBe(true);
    expect(shows({ "statusLine.withSidePanel": false, "sidebar.show": false }, false, true)).toBe(
      true,
    );
    // The TUI's own setting does not reach Desktop.
    expect(
      shows({ "statusLine.withSidebar": true, "statusLine.withSidePanel": false }, false, true),
    ).toBe(false);
    expect(shows({ "statusLine.withSidebar": false }, false, true)).toBe(true);
    expect(shows({ "statusLine.show": false }, false, false)).toBe(false);
    expect(shows({ "statusLine.show": false }, false, true)).toBe(false);
    expect(shows({}, true, false)).toBe(false);
    expect(shows({ "statusLine.home": true, "statusLine.show": false }, true, false)).toBe(true);
  });

  const widths = {
    full: [100, 100, 100],
    bar: [80, 80, 80],
    reset: [60, 60, 60],
    numbers: [40, 40, 40],
  };
  const layoutIn = (room: number, start = 0, detail: "auto" | "full" = "auto") =>
    stripLayout({ widths, separator: 10, previous: 15, next: 30, room, start, detail });

  it("shows every provider in full until it has measured its room", () => {
    expect(layoutIn(0)).toEqual({ detail: "full", start: 0, count: 3, hiddenAfter: 0 });
  });

  it("shows the most detail that fits every provider, as the TUI status line does", () => {
    expect(layoutIn(320).detail).toBe("full");
    expect(layoutIn(260)).toEqual({ detail: "bar", start: 0, count: 3, hiddenAfter: 0 });
    expect(layoutIn(140)).toEqual({ detail: "numbers", start: 0, count: 3, hiddenAfter: 0 });
    expect(layoutIn(260, 0, "full")).toEqual({
      detail: "full",
      start: 0,
      count: 2,
      hiddenAfter: 1,
    });
  });

  it("pages when even the numbers do not fit, keeping room for the buttons", () => {
    expect(layoutIn(100)).toEqual({ detail: "numbers", start: 0, count: 1, hiddenAfter: 2 });
    expect(layoutIn(100, 1)).toEqual({ detail: "numbers", start: 1, count: 1, hiddenAfter: 1 });
    expect(layoutIn(100, 2)).toEqual({ detail: "numbers", start: 2, count: 1, hiddenAfter: 0 });
    // Not even the first fits: it still shows, cut at the edge.
    expect(layoutIn(20)).toEqual({ detail: "numbers", start: 0, count: 1, hiddenAfter: 2 });
    expect(layoutIn(20, 9).start).toBe(2);
  });
});

describe("GUI surface colors", () => {
  it("follows the color settings: theme names, fixed colors and the bar's level", () => {
    const settings = surfaceSettings(
      withValues({ "colors.provider": "#ff0000", "colors.low": "blue", "colors.label": "bar" }),
    );
    expect(roleCss(settings, "provider")).toBe("#ff0000");
    expect(roleCss(settings, "reset")).toBe("var(--oq-n-muted)");
    expect(levelCss(settings, 10)).toBe("var(--oq-n-blue)");
    expect(levelCss(settings, 30)).toBe("var(--oq-n-yellow)");
    expect(roleCss(settings, "label", 90)).toBe("var(--oq-n-green)");
    expect(segmentCss(settings, { text: "█", role: "bar", percent: 5 })).toBe("var(--oq-n-blue)");
    const odd = surfaceSettings(withValues({ "colors.provider": "#zzz;x" }));
    expect(roleCss(odd, "provider")).toBe("var(--oq-n-text)");
  });
});

describe("turn events shared by the TUI and the GUI", () => {
  it("reports replies, compactions, answered questions and steps", () => {
    const handlers = new Map<string, (event: SessionEvent) => void>();
    const stops: Array<() => void> = [];
    const on = (type: string, handler: (event: SessionEvent) => void) => {
      handlers.set(type, handler);
      const stop = vi.fn();
      stops.push(stop);
      return stop;
    };
    const afterTurn = vi.fn();
    const stepEnded = vi.fn();
    const stop = listenForTurns(on, { afterTurn, stepEnded });
    const emit = (type: string, data: Record<string, unknown>) =>
      handlers.get(type)?.({ location: { directory: "/work" }, data });

    emit("session.execution.succeeded", { sessionID: "ses_1" });
    emit("session.compaction.ended", { sessionID: "ses_1" });
    emit("session.step.ended", { sessionID: "ses_1" });
    emit("session.tool.input.started", { name: "question", id: "call-1" });
    emit("session.tool.input.started", { name: "bash", id: "call-2" });
    emit("session.tool.success", { sessionID: "ses_1", id: "call-2" });
    emit("session.tool.success", { sessionID: "ses_1", id: "call-1" });
    emit("session.tool.success", { sessionID: "ses_1", id: "call-1" });
    emit("session.execution.succeeded", {});

    expect(afterTurn.mock.calls.map(([trigger, sessionID]) => [trigger, sessionID])).toEqual([
      ["reply", "ses_1"],
      ["compaction", "ses_1"],
      ["question", "ses_1"],
    ]);
    expect(afterTurn.mock.calls[0]?.[2]).toMatchObject({ location: { directory: "/work" } });
    expect(stepEnded).toHaveBeenCalledWith("ses_1", expect.anything());
    stop();
    for (const each of stops) expect(each).toHaveBeenCalledOnce();
  });

  it("asks for reset notices by toast.resetNotice, while toasts are on", () => {
    const notice = (window: ResetNotice["window"]): ResetNotice => ({
      id: "n",
      rowId: "anthropic.week",
      providerId: "anthropic",
      label: "Weekly",
      window,
      percentRemaining: 100,
      atMs: NOW,
    });
    const wants = (values: Record<string, unknown>, window: ResetNotice["window"]) =>
      wantsResetNotice(surfaceSettings(withValues(values)), notice(window));
    expect(wants({}, "week")).toBe(false);
    expect(wants({ "toast.resetNotice": "weekly" }, "week")).toBe(true);
    expect(wants({ "toast.resetNotice": "weekly" }, "five_hour")).toBe(false);
    expect(wants({ "toast.resetNotice": "all" }, "five_hour")).toBe(true);
    expect(wants({ "toast.resetNotice": "all", "toast.show": false }, "week")).toBe(false);
  });
});
