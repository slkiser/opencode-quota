/**
 * The TUI plugin (`src/tui/index.tsx`) and its toasts (`toasts.ts`). The toasts on their own,
 * then the plugin on a fake OpenCode host: its commands, the quota commands typed in the prompt,
 * and what it does after a turn.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProviderSnapshot, QuotaSnapshot, ResetNotice } from "../src/core/types.js";
import { readActiveCredentialRowsCached, readCredentialRows } from "../src/lib/opencode-auth.js";
import type { QuotaClient } from "../src/tui/client.js";
import { type DisplaySettings, defaultDisplaySettings } from "../src/tui/display.js";
import plugin from "../src/tui/index.tsx";
import { createToasts, type ToastOptions, type TurnEnd, toastRoom } from "../src/tui/toasts.js";
import { createFakeTuiHost, type Route, stubJsx } from "./helpers/fake-tui-host.js";
import { THEME } from "./helpers/jsx-tree.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

/** The cleanups the TUI registers with Solid (on the server build they never run by themselves). */
const cleanups = vi.hoisted(() => [] as Array<() => void>);
vi.mock("solid-js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("solid-js")>()),
  onCleanup: (cleanup: () => void) => {
    cleanups.push(cleanup);
  },
}));
/** The TUI never reads logins: the server plugin does. */
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-auth.js")>();
  return {
    ...actual,
    readActiveCredentialRowsCached: vi.fn(actual.readActiveCredentialRowsCached),
    readCredentialRows: vi.fn(actual.readCredentialRows),
  };
});

function provider(label: string, percentRemaining?: number, resetsAt?: string): ProviderSnapshot {
  const providerId = label.toLowerCase();
  return {
    providerId,
    label,
    rows:
      percentRemaining === undefined
        ? []
        : [
            {
              id: `${providerId}.weekly`,
              providerId,
              label: "Weekly",
              type: "quota",
              method: "remote_api",
              authority: "provider_reported",
              window: "week",
              prominence: "primary",
              percentRemaining,
              ...(resetsAt ? { resetsAt } : {}),
            },
          ],
    okAtMs: NOW,
    checkedAtMs: NOW,
    ...(percentRemaining === undefined ? { error: { code: "timeout" as const } } : {}),
    refreshing: false,
    debug: [],
  };
}

function snapshot(providers: ProviderSnapshot[], resetNotices: ResetNotice[] = []): QuotaSnapshot {
  return {
    version: 6,
    providers,
    resetNotices,
    generatedAtMs: NOW,
    serverId: "server",
    revision: NOW,
  };
}

function startToasts(answer: QuotaSnapshot | undefined, change: (d: DisplaySettings) => void) {
  const display = defaultDisplaySettings();
  change(display);
  const show = vi.fn();
  const refresh = vi.fn(async () => answer);
  const toasts = createToasts({
    show,
    display: () => display,
    terminalWidth: () => 120,
    quota: { refresh, snapshot: () => answer } as unknown as QuotaClient,
    isChildSession: (sessionID) => sessionID === "child",
    now: () => NOW,
  });
  return { toasts, show, refresh };
}

/** Claude right after its limits reset, with the rows the reset notices name. */
function claudeAfterReset(): ProviderSnapshot {
  const claude = provider("Claude", 100);
  const row = claude.rows[0]!;
  // The weekly row is the "work" account's; the 5h row has no account.
  const weekly = { ...row, account: "work" };
  const fiveHour = { ...row, id: "claude.five_hour", label: "5h", window: "five_hour" as const };
  return { ...claude, rows: [weekly, fiveHour] };
}

const OK = snapshot([provider("Claude", 80)]);
const LOW = snapshot([provider("Claude", 10)]);
/** 60% left with 5 of its 7 days to come: used faster than it refills, but not getting low. */
const FAST = snapshot([provider("Claude", 60, new Date(NOW + 5 * 86_400_000).toISOString())]);

describe("quota toasts", () => {
  it.each<{
    name: string;
    trigger: TurnEnd;
    answer: QuotaSnapshot;
    change?: (display: DisplaySettings) => void;
    shown: boolean;
  }>([
    { name: "after compaction by default", trigger: "compaction", answer: OK, shown: true },
    { name: "not after a reply by default", trigger: "reply", answer: OK, shown: false },
    { name: "not after a question by default", trigger: "question", answer: OK, shown: false },
    {
      name: "after every reply when turned on",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "always";
      },
      shown: true,
    },
    {
      name: "after a reply only when quota is low, with the low setting",
      trigger: "reply",
      answer: LOW,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: true,
    },
    {
      name: "not after a reply with plenty left, with the low setting",
      trigger: "reply",
      answer: OK,
      change: (display) => {
        display.toast.afterReply = "low";
      },
      shown: false,
    },
    {
      name: "not after a reply for a fast pace alone, with the bar colors following pace",
      trigger: "reply",
      answer: FAST,
      change: (display) => {
        display.toast.afterReply = "low";
        display.colors.levelBy = "pace";
      },
      shown: false,
    },
    {
      name: "never when the toast surface is off",
      trigger: "compaction",
      answer: OK,
      change: (display) => {
        display.toast.show = false;
      },
      shown: false,
    },
  ])("shows a toast $name", async ({ trigger, answer, change, shown }) => {
    const { toasts, show, refresh } = startToasts(answer, change ?? (() => {}));
    await toasts.afterTurn(trigger, "ses_1");
    expect(refresh).toHaveBeenCalledWith("turn", "ses_1");
    const bar =
      answer === LOW ? `${"█".repeat(2)}${"░".repeat(18)}  10%` : `${"█".repeat(16)}░░░░  80%`;
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(
      shown ? [`Claude\n  7d ${bar} left`] : [],
    );
  });

  it("lays the toast out as picked on the Toast page, as wide as the terminal lets it", async () => {
    const message = async (layout: "grouped" | "detailed", terminalWidth: number) => {
      const show = vi.fn();
      const display = defaultDisplaySettings();
      display.toast.layout = layout;
      const toasts = createToasts({
        show,
        display: () => display,
        terminalWidth: () => terminalWidth,
        quota: { refresh: async () => OK } as unknown as QuotaClient,
        isChildSession: () => false,
        now: () => NOW,
      });
      await toasts.afterTurn("compaction", "ses_1");
      return show.mock.calls[0]?.[0].message;
    };
    expect({
      grouped: await message("grouped", 33),
      detailed: await message("detailed", 120),
      narrow: await message("detailed", 33),
    }).toEqual({
      // A 33-column terminal leaves the toast 18 columns of text beside its close "x".
      grouped: "Claude\n  7d ██░  80% left",
      detailed: `Claude\n7d\n${"█".repeat(33)}${"░".repeat(8)}  80% left`,
      narrow: "Claude\n7d\n██████░░  80% left",
    });
  });

  it("draws the even-use mark in the toast's bar only with Even-use mark on", async () => {
    // Half of the week has passed with 80% left: even use would leave 50%.
    const answer = snapshot([provider("Claude", 80)]);
    answer.providers[0]!.rows[0]!.resetsAt = new Date(NOW + 84 * 60 * 60_000).toISOString();
    const message = async (evenUse: boolean) => {
      const { toasts, show } = startToasts(answer, (display) => {
        display.layout.evenUse = evenUse;
      });
      await toasts.afterTurn("compaction", "ses_1");
      return show.mock.calls[0]?.[0].message;
    };
    expect({ off: await message(false), on: await message(true) }).toEqual({
      off: "Claude\n  7d ████████████████░░░░  80% left  3.5d",
      // The ┃ takes the place of the bar's middle cell; the bar keeps its 20 cells.
      on: "Claude\n  7d ██████████┃█████░░░░  80% left  3.5d",
    });
  });

  it.each([true, false])("previews the toast a turn shows, with toasts on: %s", async (on) => {
    const { toasts, show } = startToasts(OK, (display) => {
      display.toast.show = on;
    });
    await toasts.afterTurn("compaction", "ses_1");
    toasts.preview("ses_1");
    const [turn] = show.mock.calls;
    expect(show.mock.calls).toEqual(on ? [turn, turn] : []);
  });

  it("fits a toast's text in OpenCode's toast: 60 columns at most, 6 fewer than the terminal", () => {
    // Inside the toast: a border and 2 columns of padding on each side, then the close "x" 2
    // columns after the text, as a quota toast has no title.
    expect([toastRoom(200), toastRoom(66), toastRoom(50)]).toEqual([51, 51, 35]);
  });

  it("never asks or shows anything for a subagent session", async () => {
    const { toasts, show, refresh } = startToasts(OK, (display) => {
      display.toast.afterReply = "always";
    });
    await toasts.afterTurn("reply", "child");
    expect(refresh).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("says once that every provider fails, until one answers again", async () => {
    const failing = snapshot([provider("Claude"), provider("Copilot")]);
    let answer = failing;
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: defaultDisplaySettings,
      terminalWidth: () => 120,
      quota: { refresh: async () => answer } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    for (const next of [failing, failing, OK, failing]) {
      answer = next;
      await toasts.afterTurn("reply", "ses_1");
    }
    expect(show.mock.calls.map(([toast]) => [toast.variant, toast.message])).toEqual([
      ["error", "Claude  Timed out\nCopilot  Timed out"],
      ["error", "Claude  Timed out\nCopilot  Timed out"],
    ]);
  });

  it.each([
    { setting: "off", expected: [] },
    {
      setting: "weekly",
      expected: ["Weekly quota reset: Claude (work) Weekly is available again (100% left)."],
    },
    {
      setting: "all",
      expected: [
        [
          "Weekly quota reset: Claude (work) Weekly is available again (100% left).",
          "5h quota reset: Claude 5h is available again (97% left).",
        ].join("\n"),
      ],
    },
  ] as const)(
    "shows new reset notices once, in one toast, with the $setting setting",
    ({ setting, expected }) => {
      const notice = (id: string, fields: Partial<ResetNotice>): ResetNotice => ({
        id,
        rowId: "claude.weekly",
        providerId: "claude",
        label: "Weekly",
        window: "week",
        percentRemaining: 100,
        atMs: NOW,
        ...fields,
      });
      const notices = [
        notice("weekly", { account: "work" }),
        notice("five-hour", {
          rowId: "claude.five_hour",
          label: "5h",
          window: "five_hour",
          percentRemaining: 96.6,
        }),
        // A reset from before this TUI started was news to the TUI that saw it then.
        notice("old", { atMs: NOW - 1 }),
      ];
      const { toasts, show } = startToasts(undefined, (display) => {
        display.toast.resetNotice = setting;
      });
      toasts.showResetNotices(snapshot([claudeAfterReset()], notices));
      toasts.showResetNotices(snapshot([claudeAfterReset()], notices));
      expect(show.mock.calls.map(([toast]) => toast.message)).toEqual(expected);
    },
  );

  it.each([
    { percent: "used", words: "(3% used)" },
    { percent: "remaining", words: "(97% remaining)" },
    { percent: "bare", words: "(97%)" },
  ] as const)("says a reset notice's percent in the $percent words", ({ percent, words }) => {
    const notice: ResetNotice = {
      id: "five-hour",
      rowId: "claude.five_hour",
      providerId: "claude",
      label: "5h",
      window: "five_hour",
      percentRemaining: 96.6,
      atMs: NOW,
    };
    const { toasts, show } = startToasts(undefined, (display) => {
      display.toast.resetNotice = "all";
      display.words.percent = percent;
      display.toast.names["claude.five_hour"] = "Burst";
    });
    toasts.showResetNotices(snapshot([claudeAfterReset()], [notice]));
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual([
      `5h quota reset: Claude Burst is available again ${words}.`,
    ]);
  });

  it("names a reset notice's row by its account when accounts share the row id", () => {
    const copilot = provider("Copilot", 100);
    const row = copilot.rows[0]!;
    copilot.rows = [
      { ...row, account: "work", label: "Business" },
      { ...row, account: "home", label: "Pro" },
    ];
    const notice: ResetNotice = {
      id: "home-weekly",
      rowId: "copilot.weekly",
      providerId: "copilot",
      account: "home",
      label: "Pro",
      window: "week",
      percentRemaining: 100,
      atMs: NOW,
    };
    const { toasts, show } = startToasts(undefined, (display) => {
      display.toast.resetNotice = "all";
    });
    toasts.showResetNotices(snapshot([copilot], [notice]));
    expect(show.mock.calls.map(([toast]) => toast.message)).toEqual([
      "Weekly quota reset: Copilot (home) Pro is available again (100% left).",
    ]);
  });

  it("shows no reset notice for a row its provider no longer has", () => {
    const notice: ResetNotice = {
      id: "gone",
      rowId: "claude.daily",
      providerId: "claude",
      label: "Daily",
      window: "day",
      percentRemaining: 100,
      atMs: NOW,
    };
    const { toasts, show } = startToasts(undefined, (display) => {
      display.toast.resetNotice = "all";
    });
    toasts.showResetNotices(snapshot([claudeAfterReset()], [notice]));
    expect(show).not.toHaveBeenCalled();
  });

  /** Reset notices turned on, and a compaction turn whose refresh the test answers. */
  function turnWaitingForQuota() {
    let answer: (snapshot: QuotaSnapshot | undefined) => void = () => {};
    const show = vi.fn();
    const toasts = createToasts({
      show,
      display: () => {
        const display = defaultDisplaySettings();
        display.toast.resetNotice = "all";
        return display;
      },
      terminalWidth: () => 120,
      quota: {
        refresh: () =>
          new Promise<QuotaSnapshot | undefined>((resolve) => {
            answer = resolve;
          }),
      } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    const turn = toasts.afterTurn("compaction", "ses_1");
    const notice: ResetNotice = {
      id: "weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: NOW,
    };
    const withNotice = snapshot([provider("Claude", 100)], [notice]);
    const titles = () => show.mock.calls.map(([toast]) => toast.title);
    return { toasts, turn, answer: (value?: QuotaSnapshot) => answer(value), withNotice, titles };
  }

  it("shows a reset notice that comes during a turn after the turn's toast", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual([]);
    answer(OK);
    await turn;
    // The quota toast has no title: its rows say what it is.
    expect(titles()).toEqual([undefined, "Quota available"]);
  });

  it("drops the reset notices still waiting when the TUI leaves its server", async () => {
    const { toasts, turn, answer, withNotice, titles } = turnWaitingForQuota();
    toasts.showResetNotices(withNotice);
    toasts.cancel();
    // A stopped client answers nothing.
    answer(undefined);
    await turn;
    expect(titles()).toEqual([]);
    // Unshown, the notice shows when a snapshot brings it again.
    toasts.showResetNotices(withNotice);
    expect(titles()).toEqual(["Quota available"]);
  });
});

describe("the Toast page's preview", () => {
  /**
   * OpenCode's toast (2.0.26 to 2.0.28): one toast on screen, for its duration. While the mouse
   * is on it, it pauses, and the toasts shown meanwhile wait in a queue.
   */
  function fakeOpenCodeToast() {
    let current: ToastOptions | undefined;
    const queue: ToastOptions[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let startedAt = 0;
    let remaining = 0;
    let paused = false;
    const start = (duration: number) => {
      clearTimeout(timer);
      remaining = duration;
      startedAt = Date.now();
      timer = setTimeout(dismiss, duration);
    };
    const dismiss = () => {
      clearTimeout(timer);
      current = queue.shift();
      if (!current) {
        paused = false;
        return;
      }
      remaining = current.duration;
      if (!paused) start(current.duration);
    };
    return {
      show(toast: ToastOptions) {
        if (current && (paused || queue.length > 0)) {
          queue.push(toast);
          return;
        }
        current = toast;
        start(toast.duration);
      },
      /** The mouse moves onto the toast. */
      hover() {
        if (!current || paused) return;
        paused = true;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
        clearTimeout(timer);
      },
      /** The mouse moves away. */
      leave() {
        if (!current || !paused) return;
        paused = false;
        start(remaining);
      },
      current: () => current,
      waiting: () => queue.length,
    };
  }

  /**
   * Toasts on a fake OpenCode toast. A quota toast can tell whether it is the one on screen
   * when `drawn` (a colored toast) is true.
   */
  function startPreview(drawn = true) {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
    const display = defaultDisplaySettings();
    const opencode = fakeOpenCodeToast();
    const show = vi.fn((toast: ToastOptions) => {
      opencode.show(toast);
      return drawn ? { onScreen: () => opencode.current() === toast } : undefined;
    });
    const toasts = createToasts({
      show,
      display: () => display,
      terminalWidth: () => 120,
      quota: { snapshot: () => OK } as unknown as QuotaClient,
      isChildSession: () => false,
      now: () => NOW,
    });
    const shown = () => show.mock.calls.map(([toast]) => [toast.message, toast.duration]);
    /** The message on screen, if any. */
    const onScreen = () => opencode.current()?.message;
    return { toasts, display, opencode, shown, onScreen };
  }

  /** OpenCode draws the toast; the preview's microtask runs first. */
  const drawn = () => new Promise<void>((resolve) => queueMicrotask(resolve));
  const SECONDS = defaultDisplaySettings().toast.seconds * 1000;
  const COPY = 3000;
  const HOUR = 60 * 60 * 1000;
  const MESSAGE = "Claude\n  7d ████████████████░░░░  80% left";
  const NOTICE: ToastOptions = {
    variant: "success",
    title: "Quota available",
    message: "Weekly quota reset: Claude Weekly is available again (100% left).",
    duration: SECONDS,
  };

  it("shows like a turn's toast, then a 3 s copy every second while a copy is on screen", async () => {
    const { toasts, shown } = startPreview();
    toasts.preview("ses_1");
    expect(shown()).toEqual([[MESSAGE, SECONDS]]);
    await drawn();
    expect(shown()).toEqual([
      [MESSAGE, SECONDS],
      [MESSAGE, COPY],
    ]);
    vi.advanceTimersByTime(1000);
    expect(shown().at(-1)).toEqual([MESSAGE, COPY]);
    expect(shown()).toHaveLength(3);
  });

  it("stays open while the page shows, past toast.seconds and past an hour", async () => {
    const { toasts, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(2 * HOUR);
    expect(onScreen()).toBe(MESSAGE);
    expect(shown().at(-1)).toEqual([MESSAGE, COPY]);
  });

  it("shows a change at once and keeps the new toast open", async () => {
    const { toasts, display, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    display.toast.layout = "detailed";
    toasts.preview("ses_1");
    await drawn();
    const [changed] = shown()[2]!;
    expect(changed).not.toBe(MESSAGE);
    expect(shown().slice(2)).toEqual([
      [changed, SECONDS],
      [changed, COPY],
    ]);
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(changed);
  });

  it("closes the open preview with a copy that lasts 1 ms, and shows no more copies", async () => {
    const { toasts, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    toasts.closePreview();
    expect(shown().at(-1)).toEqual([MESSAGE, 1]);
    vi.advanceTimersByTime(1);
    expect(onScreen()).toBeUndefined();
    // Closed once: a second close shows nothing, and no copy comes later.
    toasts.closePreview();
    vi.advanceTimersByTime(HOUR);
    expect(shown()).toHaveLength(3);
  });

  it("leaves a titled toast that replaced the preview alone, and stops showing copies", async () => {
    const { toasts, opencode, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    opencode.show(NOTICE);
    vi.advanceTimersByTime(1000);
    expect(onScreen()).toBe(NOTICE.message);
    toasts.closePreview();
    expect(onScreen()).toBe(NOTICE.message);
    vi.advanceTimersByTime(HOUR);
    expect(shown()).toHaveLength(2);
  });

  it("keeps the preview open while the mouse is on it, with one copy held back", async () => {
    const { toasts, opencode, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(500);
    opencode.hover();
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(MESSAGE);
    // OpenCode holds back the next copy; quota adds none until that one shows.
    expect(opencode.waiting()).toBe(1);
    expect(shown()).toHaveLength(3);
    opencode.leave();
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(MESSAGE);
    expect(opencode.waiting()).toBe(0);
  });

  it("ends a preview whose page closed while the mouse was on it within 6 s of the mouse leaving", async () => {
    const { toasts, display, opencode, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(500);
    opencode.hover();
    vi.advanceTimersByTime(10_000);
    // A change on the page waits for the held-back copy instead of adding another.
    display.toast.layout = "detailed";
    toasts.preview("ses_1");
    expect(opencode.waiting()).toBe(1);
    // Leaving the page with the keyboard: OpenCode holds back the closing copy too.
    toasts.closePreview();
    expect(opencode.waiting()).toBe(2);
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(MESSAGE);
    opencode.leave();
    vi.advanceTimersByTime(6000);
    expect(onScreen()).toBeUndefined();
  });

  it("shows a change made while the mouse was on the preview once the held-back copy shows", async () => {
    const { toasts, display, opencode, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(500);
    opencode.hover();
    vi.advanceTimersByTime(10_000);
    display.toast.layout = "detailed";
    toasts.preview("ses_1");
    await drawn();
    opencode.leave();
    vi.advanceTimersByTime(6000);
    const [changed] = shown().at(-1)!;
    expect(changed).not.toBe(MESSAGE);
    expect(onScreen()).toBe(changed);
    expect(shown().filter(([message]) => message === changed)).not.toContainEqual([
      changed,
      SECONDS,
    ]);
  });

  it("shows a copy held back behind another toast for its 3 s after the page closed, then none", async () => {
    const { toasts, opencode, shown, onScreen } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(500);
    opencode.hover();
    vi.advanceTimersByTime(1000);
    // A reset notice comes while the mouse is on the preview: OpenCode holds it back too.
    opencode.show(NOTICE);
    opencode.leave();
    // The held-back copy shows, then the notice; the next copy waits behind the notice.
    vi.advanceTimersByTime(6000);
    expect(onScreen()).toBe(NOTICE.message);
    expect(opencode.waiting()).toBe(1);
    // A closing copy would wait behind that copy, which OpenCode shows for its whole 3 s.
    toasts.closePreview();
    expect(opencode.waiting()).toBe(1);
    vi.advanceTimersByTime(SECONDS);
    expect(onScreen()).toBe(MESSAGE);
    vi.advanceTimersByTime(COPY);
    expect(onScreen()).toBeUndefined();
    vi.advanceTimersByTime(HOUR);
    expect(shown()).toHaveLength(4);
  });

  it("keeps a preview closed in the same turn from staying open, and closes what it showed", async () => {
    const { toasts, shown } = startPreview();
    toasts.preview("ses_1");
    toasts.closePreview();
    await drawn();
    vi.advanceTimersByTime(HOUR);
    expect(shown()).toEqual([
      [MESSAGE, SECONDS],
      [MESSAGE, 1],
    ]);
  });

  it("shows a preview held back behind another toast once that one ends, then keeps it open", async () => {
    const { toasts, opencode, onScreen } = startPreview();
    opencode.show(NOTICE);
    opencode.hover();
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(NOTICE.message);
    opencode.leave();
    vi.advanceTimersByTime(HOUR);
    expect(onScreen()).toBe(MESSAGE);
  });

  it("shows for toast.seconds and is never closed when it can't tell what is on screen", async () => {
    const { toasts, shown } = startPreview(false);
    toasts.preview("ses_1");
    await drawn();
    vi.advanceTimersByTime(HOUR);
    toasts.closePreview();
    expect(shown()).toEqual([[MESSAGE, SECONDS]]);
  });

  it("closes the open preview when toasts are turned off", async () => {
    const { toasts, display, shown } = startPreview();
    toasts.preview("ses_1");
    await drawn();
    display.toast.show = false;
    toasts.preview("ses_1");
    expect(shown().slice(2)).toEqual([[MESSAGE, 1]]);
  });
});

/** The quota RPC the plugin calls; each test sets what it answers. */
const rpc = {
  snapshot: vi.fn(),
  refresh: vi.fn(),
  notices: vi.fn(),
  noticeList: vi.fn(),
  status: vi.fn(),
  usage: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  events: { on: vi.fn(() => () => {}) },
};

/** The TUI plugin on a fake OpenCode host, on Home or in a session, of `version` when given. */
function startTui(route: Route = { type: "home" }, version?: string) {
  const host = createFakeTuiHost({ rpc, route, version, theme: THEME, appOwner: true });
  plugin.setup(host.context as never);
  return host;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  cleanups.length = 0;
  for (const mock of [rpc.notices, rpc.events.on]) mock.mockClear();
  rpc.snapshot.mockReset().mockResolvedValue({ snapshot: snapshot([]) });
  rpc.refresh.mockReset().mockResolvedValue({ snapshot: OK });
  rpc.settings
    .mockReset()
    .mockResolvedValue({ values: {}, fromFile: [], providers: [], custom: [] });
  rpc.saveSettings.mockReset().mockResolvedValue({ ok: true, issues: [] });
  rpc.noticeList.mockReset().mockResolvedValue({ notices: [] });
  rpc.status.mockReset().mockResolvedValue({ text: "status" });
  // The Usage tab's data never arrives here: these tests check what opens.
  rpc.usage.mockReset().mockReturnValue(new Promise(() => {}));
});

describe("commands of the TUI plugin", () => {
  it("registers every quota command in the palette, and slash entries only for the TUI-only ones", () => {
    const { context, commands } = startTui();

    // The RPC client is made per call, never during setup.
    expect(context.client.rpc).not.toHaveBeenCalled();
    expect(commands().map((command) => command.id)).toEqual([
      "quota.limits",
      "quota.usage",
      "quota.status",
      "quota.settings",
    ]);
    expect(commands().every((command) => command.palette)).toBe(true);
    // The server lists /quota, /quota_usage and /quota_status in the "/" list.
    expect(commands().flatMap((command) => (command.slash ? [command.slash.name] : []))).toEqual([
      "quota_settings",
    ]);
    expect(context.ui.slot.mock.calls.map(([claim]) => claim.append)).toEqual([
      "app",
      "sidebar.content",
      "prompt.footer",
      "home.footer.status",
      "session.composer.top",
    ]);
    expect(context.data.on.mock.calls.map(([event]) => event)).toEqual([
      "session.execution.succeeded",
      "session.compaction.ended",
      "session.step.ended",
      "session.tool.input.started",
      "session.tool.success",
      "session.tool.failed",
    ]);
  });

  it("registers its layers and listeners again when OpenCode mounts the app slot again", () => {
    const { context, mountAppAgain } = startTui();
    const firstListeners = context.data.on.mock.results.map((result) => result.value);
    const firstLayers = context.keymap.layer.mock.calls.length;

    mountAppAgain();

    // The previous mount's layers left with it, so every layer is registered again.
    expect(context.keymap.layer).toHaveBeenCalledTimes(firstLayers * 2);
    expect(context.data.on).toHaveBeenCalledTimes(firstListeners.length * 2);
    for (const dispose of firstListeners) expect(dispose).toHaveBeenCalledOnce();
    const secondListeners = context.data.on.mock.results.slice(firstListeners.length);
    for (const { value: dispose } of secondListeners) expect(dispose).not.toHaveBeenCalled();
  });

  it("reads quota only over the RPC: one snapshot call serves a session's sidebar and status line", async () => {
    stubJsx();
    const settings = {
      values: { "toast.afterReply": "always" },
      fromFile: [],
      providers: [],
      custom: [],
    };
    rpc.snapshot.mockResolvedValue({ snapshot: { ...OK, settings } });
    rpc.refresh.mockResolvedValue({ snapshot: { ...OK, settings } });
    rpc.notices.mockResolvedValue({ homeLine: "" });
    // Drawn outside a Solid owner, so the toasts are plain text.
    const tui = createFakeTuiHost({ rpc, theme: THEME });
    plugin.setup(tui.context as never);
    tui.render("sidebar.content", { sessionID: "ses_1" });
    tui.render("prompt.footer", { sessionID: "ses_1" });
    tui.render("home.footer.status");
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    for (const command of tui.commands()) await command.run();
    // On Home the quota window only says to open a session, and the reply toast shows the quota.
    const messages = () => tui.toast.mock.calls.map(([toast]) => String(toast.message));
    await vi.waitFor(() =>
      expect(messages().filter((message) => message.startsWith("Claude\n  7d "))).toHaveLength(1),
    );

    expect(rpc.snapshot.mock.calls.filter(([input]) => input.sessionID === "ses_1")).toHaveLength(
      1,
    );
    expect(rpc.refresh.mock.calls.map(([input]) => input)).toEqual([
      { reason: "turn", sessionID: "ses_1" },
    ]);
    expect(rpc.notices).toHaveBeenCalledOnce();
    expect(readActiveCredentialRowsCached).not.toHaveBeenCalled();
    expect(readCredentialRows).not.toHaveBeenCalled();
  });

  it("catches a typed quota command with one Enter binding above OpenCode's prompt, only in the base mode", () => {
    const enter = startTui().layer("typedCommand");

    expect(enter.mode).toBeUndefined();
    expect(enter.commands).toHaveLength(1);
    expect(enter.commands[0]?.bind).toBe("return");
    expect(enter.commands[0]).not.toHaveProperty("id");
    expect(enter.commands[0]).not.toHaveProperty("slash");
  });

  it("opens the Limits tab for a typed /quota, with fresh rows", () => {
    const session = startTui({ type: "session", sessionID: "ses_open" });
    expect(session.typed("/quota")).toBeUndefined();
    expect(session.editor.clear).toHaveBeenCalledOnce();
    expect(session.toast).not.toHaveBeenCalled();
    expect(rpc.refresh).toHaveBeenCalledExactlyOnceWith(
      { reason: "manual", sessionID: "ses_open" },
      expect.anything(),
    );
  });

  it("opens the quota window for every typed quota command, and on Home says to open a session first", () => {
    const home = startTui();
    for (const name of ["quota", "quota_usage", "quota_status", "quota_settings"]) {
      expect(home.typed(`/${name}`)).toBeUndefined();
    }
    expect(home.editor.clear).toHaveBeenCalledTimes(4);
    expect(home.toast).toHaveBeenCalledTimes(4);
    expect(home.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Open a session first: the quota window opens above its message box.",
      }),
    );

    // A typed command runs synchronously: a returned promise would count as handled.
    const session = startTui({ type: "session", sessionID: "ses_open" });
    expect(session.typed("  /quota_status \n")).toBeUndefined();
    expect(session.toast).not.toHaveBeenCalled();
    expect(rpc.status).toHaveBeenCalledExactlyOnceWith(
      { sessionID: "ses_open" },
      expect.anything(),
    );
  });

  it("leaves other text and a missing editor to OpenCode's submit", () => {
    const tui = startTui();
    for (const text of ["hello", "/quotax", "/quota_statu", "/help", "hello /quota", "/", ""]) {
      expect(tui.typed(text)).toBe(false);
    }
    tui.context.renderer.currentFocusedEditor = null;
    expect(tui.press("typedCommand", "return")).toBe(false);
    expect(tui.editor.clear).not.toHaveBeenCalled();
  });
});

describe("turn events of the TUI plugin", () => {
  let tui: ReturnType<typeof startTui>;
  beforeEach(() => {
    tui = startTui();
  });

  it("refreshes quota after a question is answered, with no toast by default", async () => {
    tui.emit("session.tool.input.started", { name: "question", id: "call-1" });
    tui.emit("session.tool.success", { sessionID: "ses_1", id: "call-1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    expect(rpc.refresh).toHaveBeenCalledWith(
      { reason: "turn", sessionID: "ses_1" },
      expect.anything(),
    );
    // Only the subagent check reads the session.
    expect(tui.sessionGet).toHaveBeenCalledExactlyOnceWith("ses_1");
    expect(tui.toast).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a failed question", tool: "question", end: "session.tool.failed" },
    { name: "another tool", tool: "bash", end: "session.tool.success" },
  ])("does nothing after $name", ({ tool, end }) => {
    tui.emit("session.tool.input.started", { name: tool, id: "call-2" });
    tui.emit(end, { sessionID: "ses_1", id: "call-2" });
    expect(rpc.refresh).not.toHaveBeenCalled();
    expect(tui.sessionGet).not.toHaveBeenCalled();
  });

  it("asks for the snapshot once mounted, so Home gets all file settings too", () => {
    expect(rpc.snapshot).toHaveBeenCalledWith({}, expect.anything());
  });

  it("announces v5 conversion once without saving settings in plugin storage", async () => {
    rpc.refresh.mockResolvedValue({
      snapshot: { ...OK, settingsConverted: true, revision: OK.revision + 1 },
    });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith({
        variant: "info",
        title: "OpenCode Quota",
        message: "Your 4.x or 5.x settings are now in settings.jsonc, details in /quota_status",
        duration: 15_000,
      }),
    );
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledTimes(2));
    expect(tui.toast).toHaveBeenCalledTimes(1);
    expect(tui.context.storage.store.mock.calls.some(([key]) => key === "settings")).toBe(false);
  });

  it("loads file settings from live snapshot updates without a settings store", async () => {
    const settings = {
      values: { "toast.afterReply": "always" },
      fromFile: [],
      providers: [],
      custom: [],
    };
    rpc.refresh.mockResolvedValue({ snapshot: { ...OK, settings, revision: OK.revision + 1 } });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() =>
      expect(tui.toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "info", message: expect.stringContaining("80% left") }),
      ),
    );
  });

  it("stops listening when OpenCode unmounts the app slot", () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    expect(tui.listeners.size).toBe(0);
    expect(rpc.refresh).not.toHaveBeenCalled();
  });

  it("drops the reset notices still waiting when OpenCode unmounts the app slot", async () => {
    let answer: (output: { snapshot: QuotaSnapshot }) => void = () => {};
    rpc.refresh.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    // A reply's turn waits for quota; meanwhile the server announces a reset.
    tui.emit("session.execution.succeeded", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(rpc.refresh).toHaveBeenCalledOnce());
    const notice: ResetNotice = {
      id: "weekly",
      rowId: "claude.weekly",
      providerId: "claude",
      label: "Weekly",
      window: "week",
      percentRemaining: 100,
      atMs: Date.now() + 60_000,
    };
    const changed = rpc.events.on.mock.lastCall?.[1] as unknown as (event: {
      data: { snapshot: QuotaSnapshot };
    }) => void;
    changed({
      data: {
        snapshot: {
          ...snapshot([provider("Claude", 100)], [notice]),
          settings: {
            values: { "toast.resetNotice": "all" },
            fromFile: [],
            providers: [],
            custom: [],
          },
        },
      },
    });

    for (const cleanup of cleanups.splice(0)) cleanup();
    answer({ snapshot: OK });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.toast).not.toHaveBeenCalled();
  });

  it("refreshes after each step of a session, never of a subagent", () => {
    tui.sessionGet.mockImplementation((id: string) =>
      id === "child" ? { parentID: "ses_1" } : {},
    );
    tui.emit("session.step.ended", { sessionID: "child" });
    tui.emit("session.step.ended", { sessionID: "ses_1" });
    expect(rpc.refresh.mock.calls.map(([input]) => input)).toEqual([
      { reason: "turn", sessionID: "ses_1" },
    ]);
  });
});

describe("colored toasts of the TUI plugin", () => {
  const PLAIN = `Claude\n  7d ${"█".repeat(16)}░░░░  80% left`;

  /**
   * The messages OpenCode `version`'s toast gets after a compaction (its `show` stands for that
   * toast). JSX makes plain `{ type, props }` nodes here.
   */
  async function afterCompaction(version?: string, show?: (toast: { message: unknown }) => void) {
    stubJsx({ components: "keep" });
    const tui = startTui({ type: "session", sessionID: "ses_1" }, version);
    if (show) tui.toast.mockImplementation(show);
    tui.emit("session.compaction.ended", { sessionID: "ses_1" });
    await vi.waitFor(() => expect(tui.toast).toHaveBeenCalled());
    return tui.toast.mock.calls.map(([toast]) => toast.message as unknown);
  }

  /** What OpenCode's <text> draws of a message of spans. */
  const drawn = (message: unknown) =>
    (message as Array<string | { props: { children: string } }>)
      .map((child) => (typeof child === "string" ? child : child.props.children))
      .join("");

  it.each(["2.0.28", "2.1.0", undefined])(
    "colors the quota toast on OpenCode %s, with the plain message's text",
    async (version) => {
      const colored = await afterCompaction(version);
      expect(colored).toHaveLength(1);
      expect(typeof colored[0]).not.toBe("string");
      expect(drawn(colored[0])).toBe(PLAIN);
    },
  );

  it("shows the plain toast when OpenCode's toast throws on the colored one", async () => {
    const messages = await afterCompaction("2.0.28", (toast) => {
      if (typeof toast.message !== "string") throw new Error("message must be a string");
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(PLAIN);
  });
});
