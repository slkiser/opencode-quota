import { describe, expect, it } from "vite-plus/test";
import type { QuotaRow, QuotaWindow, Words } from "../src/core/types.js";
import { DEFAULT_WORDS } from "../src/view/format.js";
import { errorWords, type Place, rowFacts } from "../src/view/row-facts.js";
import { type VisibleRow, visibleRow } from "../src/view/select.js";
import { quotaRow } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();

const words = (change: Partial<Words> = {}): Words => ({ ...DEFAULT_WORDS, ...change });
const place = (change: Partial<Place> = {}): Place => ({
  words: DEFAULT_WORDS,
  nowMs: NOW,
  names: "words",
  percent: "words",
  ...change,
});
/** The facts of a row shown alone. */
const factsOf = (row: QuotaRow, change: Partial<Place> = {}) =>
  rowFacts(visibleRow(row, {}), { rows: [] }, place(change));

/** A row of Claude's as a place shows it, under `name` when you named it. */
const shown = (label: string, window?: QuotaWindow, name?: string): VisibleRow => {
  const row = quotaRow(`claude.${label}`, { label, ...(window ? { window } : {}) });
  return visibleRow(row, name === undefined ? {} : { [row.id]: name });
};
const HOURLY = shown("Hourly limit", "hour");
/** Weekly and Fable both reset weekly. */
const WEEKLY = shown("Weekly", "week");
const FABLE = shown("Fable", "week");
const PREMIUM = shown("Premium requests");
const RENAMED = shown("Plan", "month", "Pro plan");
/** Named with its own label: your name still wins over "1d". */
const KEPT_NAME = shown("Daily", "day", "Daily");
const GROUP = { rows: [HOURLY, WEEKLY, FABLE, PREMIUM, RENAMED, KEPT_NAME] };

describe("row facts", () => {
  it.each([
    { names: "words", rowNames: "short", item: HOURLY, name: "1h" },
    { names: "words", rowNames: "short", item: FABLE, name: "Fable" },
    { names: "words", rowNames: "short", item: PREMIUM, name: "Premium requests" },
    { names: "words", rowNames: "short", item: RENAMED, name: "Pro plan" },
    { names: "words", rowNames: "short", item: KEPT_NAME, name: "Daily" },
    { names: "words", rowNames: "full", item: HOURLY, name: "Hourly limit" },
    { names: "label", rowNames: "short", item: RENAMED, name: "Pro plan" },
    { names: "label", rowNames: "short", item: HOURLY, name: "Hourly limit" },
  ] as const)(
    "names $item.label as $name ($names, rowNames $rowNames)",
    ({ names, rowNames, item, name }) => {
      expect(rowFacts(item, GROUP, place({ names, words: words({ rowNames }) })).name).toBe(name);
    },
  );

  it.each([
    { style: "number", percent: "left", left: 58, value: "58%" },
    { style: "number", percent: "used", left: 58, value: "42%" },
    { style: "words", percent: "left", left: 58, value: "58% left" },
    { style: "words", percent: "remaining", left: 58, value: "58% remaining" },
    { style: "words", percent: "bare", left: 58, value: "58%" },
    { style: "words", percent: "used", left: 58, value: "42% used" },
    { style: "usedWord", percent: "left", left: 58, value: "58%" },
    { style: "usedWord", percent: "used", left: 58, value: "42% used" },
    { style: "words", percent: "left", left: -12, value: "0% left" },
    { style: "words", percent: "used", left: 140, value: "0% used" },
  ] as const)(
    "writes $left% left as $value ($style, $percent)",
    ({ style, percent, left, value }) => {
      const row = quotaRow("x.a", { percentRemaining: left });
      expect(factsOf(row, { percent: style, words: words({ percent }) })).toMatchObject({
        percent: left,
        value,
      });
    },
  );

  it("gives a row without a percent its value, and no reset or pace", () => {
    const balance = quotaRow("x.balance", {
      label: "Balance",
      type: "balance",
      amount: { decimal: "1240.5", unit: { kind: "currency", code: "USD" } },
      resetsAt: at(60),
    });
    expect(factsOf(balance, { evenUse: true, pace: "all" })).toEqual({
      id: "x.balance",
      name: "Balance",
      value: "$1,240.50 left",
      reset: "",
      shortReset: "",
    });
  });

  /** 3 days 23 hours 58 minutes away. */
  const WEEK = at(3 * 1440 + 23 * 60 + 58);
  const decimals = { words: words({ reset: "decimal", resetDecimals: 2 }) };
  it.each([
    { resetsAt: WEEK, change: {}, reset: "4.0d", short: "3d 23h" },
    { resetsAt: WEEK, change: { times: "exact" }, reset: "3d 23h 58m", short: "3d 23h" },
    { resetsAt: at(134), change: decimals, reset: "2.23h", short: "2h" },
    { resetsAt: at(-5), change: {}, reset: "now", short: "now" },
    { resetsAt: undefined, change: {}, reset: "", short: "" },
  ] as const)("writes the reset time as $reset, short $short", ({ resetsAt, change, ...time }) => {
    const row = quotaRow("x.a", { percentRemaining: 50, ...(resetsAt ? { resetsAt } : {}) });
    expect(factsOf(row, change)).toMatchObject({ reset: time.reset, shortReset: time.short });
  });

  /** A 5-hour row with half of its window gone, so even use would leave 50%. */
  const paced = (left: number) =>
    quotaRow("x.five_hour", { window: "five_hour", percentRemaining: left, resetsAt: at(150) });
  it.each([
    { pace: undefined, left: 30, expected: undefined },
    { pace: "runsOut", left: 30, expected: { words: "runs out in 1h 5m", fast: true } },
    { pace: "runsOut", left: 0, expected: undefined },
    { pace: "fast", left: 0, expected: { words: "faster than it refills", fast: true } },
    { pace: "fast", left: 50, expected: undefined },
    { pace: "all", left: 50, expected: { words: "on track", fast: false } },
    { pace: "all", left: 80, expected: { words: "plenty to spare", fast: false } },
  ] as const)("shows $pace pace words at $left% left", ({ pace, left, expected }) => {
    expect(factsOf(paced(left), { pace }).pace).toEqual(expected);
  });

  it("writes the runs-out time in the place's times", () => {
    const compact = { words: words({ reset: "compact" }), pace: "runsOut" } as const;
    expect([
      factsOf(paced(30), compact).pace?.words,
      factsOf(paced(30), { ...compact, times: "exact" }).pace?.words,
    ]).toEqual(["runs out in 1h5m", "runs out in 1h 5m"]);
  });

  it("puts even use where the place draws the mark and the row has a pace", () => {
    const noReset = quotaRow("x.a", { percentRemaining: 30 });
    expect([
      factsOf(paced(30), { evenUse: true }).evenLeft,
      factsOf(paced(30), { evenUse: false }).evenLeft,
      factsOf(noReset, { evenUse: true }).evenLeft,
    ]).toEqual([50, undefined, undefined]);
  });

  it("gives a row with a pace its level by pace, whatever pace words the place shows", () => {
    const noReset = quotaRow("x.a", { percentRemaining: 30 });
    expect([
      factsOf(paced(80)).paceLevel,
      factsOf(paced(47)).paceLevel,
      factsOf(paced(30), { pace: "all" }).paceLevel,
      factsOf(noReset).paceLevel,
    ]).toEqual(["good", "warning", "low", undefined]);
  });

  it("says a group's last error in the words of `describeError`, with the group's name", () => {
    const failed = { name: "Claude", error: { code: "network" } } as const;
    expect([errorWords(failed, NOW), errorWords({ name: "Claude" }, NOW)]).toEqual([
      "Can't reach Claude",
      undefined,
    ]);
  });
});
