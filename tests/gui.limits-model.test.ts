import { describe, expect, it } from "vite-plus/test";
import type { QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import {
  displayOf,
  lastCheckedMs,
  limitCards,
  limitProviders,
  resetAtFormat,
  sessionStrip,
} from "../src/gui/limits-model.js";
import type { ClientSettings } from "../src/settings/index.js";
import { DEFAULT_WORDS } from "../src/view/format.js";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function row(id: string, fields: Partial<QuotaRow>): QuotaRow {
  return {
    id,
    providerId: id.split(".")[0] ?? id,
    label: id,
    type: "quota",
    method: "remote_api",
    authority: "provider_reported",
    prominence: "primary",
    ...fields,
  };
}

const SNAPSHOT: QuotaSnapshot = {
  version: 6,
  providers: [
    {
      providerId: "anthropic",
      label: "Anthropic",
      refreshing: false,
      checkedAtMs: NOW - 3 * 60_000,
      rows: [
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
        row("anthropic.extra", {
          label: "Extra usage",
          prominence: "supplementary",
          percentRemaining: 90,
        }),
      ],
    },
    {
      providerId: "openrouter",
      label: "OpenRouter",
      refreshing: false,
      checkedAtMs: NOW - 60 * 60_000,
      error: { code: "login_expired" },
      rows: [
        row("openrouter.balance", {
          label: "Balance",
          type: "balance",
          amount: { decimal: "12.4", unit: { kind: "currency", code: "USD" } },
        }),
      ],
    },
  ],
  currentModelProviderIds: ["anthropic"],
  sessionTokens: { input: 12_300, cachedInput: 1_200_000, output: 950 },
  resetNotices: [],
  generatedAtMs: NOW,
  serverId: "server-1",
  revision: 1,
};

function withValues(values: Record<string, unknown>): QuotaSnapshot {
  const settings: ClientSettings = { values, fromFile: [], providers: [], custom: [] };
  return { ...SNAPSHOT, settings };
}

describe("GUI limits display settings", () => {
  it("uses the defaults without settings", () => {
    const display = displayOf(undefined);
    expect(display.words).toEqual(DEFAULT_WORDS);
    expect(display.colors).toEqual({ levelBy: "left", warningBelow: 50, lowBelow: 20 });
    expect(display.evenUse).toBe(true);
    expect(display.rows.sidebar).toEqual({
      hidden: [],
      providerOrder: [],
      rowOrder: {},
      names: {},
    });
  });

  it("reads the colors, the even-use mark and the sidebar's order and names", () => {
    const display = displayOf(
      withValues({
        "colors.levelBy": "pace",
        "colors.warningBelow": 10,
        "colors.lowBelow": 30,
        "layout.evenUse": false,
        "sidebar.providerOrder": ["openrouter"],
        "sidebar.names": { "anthropic.week": "Week" },
        "sidebar.rowOrder": { anthropic: "not a list" },
      }),
    );
    // "Getting low" is never below "almost out".
    expect(display.colors).toEqual({ levelBy: "pace", warningBelow: 30, lowBelow: 30 });
    expect(display.evenUse).toBe(false);
    expect(display.rows.sidebar).toMatchObject({
      providerOrder: ["openrouter"],
      names: { "anthropic.week": "Week" },
      rowOrder: {},
    });
  });
});

describe("GUI limit cards", () => {
  it("shows each row's percent, reset, pace, even-use mark and level by share left", () => {
    const [anthropic] = limitCards(SNAPSHOT, displayOf(SNAPSHOT), NOW);
    expect(anthropic).toMatchObject({ name: "Anthropic", current: true });
    // The supplementary row shows only with words.detail "detailed".
    expect(anthropic?.rows.map((item) => item.name)).toEqual(["5h", "Weekly"]);
    const [fiveHour, week] = anthropic?.rows ?? [];
    expect(fiveHour).toMatchObject({
      value: "30% left",
      reset: "1h",
      level: "warning",
      pace: { words: "plenty to spare", fast: false },
      resetsAtMs: NOW + HOUR,
    });
    expect(fiveHour?.evenLeft).toBeCloseTo(20);
    expect(week).toMatchObject({ value: "10% left", level: "low", pace: { fast: true } });
    expect(week?.pace?.words).toMatch(/^runs out in /u);
  });

  it("colors by pace when the bar colors follow it, and leaves out the mark when it is off", () => {
    const snapshot = withValues({ "colors.levelBy": "pace", "layout.evenUse": false });
    const [fiveHour] = limitCards(snapshot, displayOf(snapshot), NOW)[0]?.rows ?? [];
    expect(fiveHour?.level).toBe("good");
    expect(fiveHour?.evenLeft).toBeUndefined();
  });

  it("shows the error, a value row without a bar, and your words for percents", () => {
    const snapshot = {
      ...withValues({ "sidebar.providerOrder": ["openrouter"] }),
      words: { ...DEFAULT_WORDS, percent: "used" as const, detail: "detailed" as const },
    };
    const cards = limitCards(snapshot, displayOf(snapshot), NOW);
    expect(cards.map((card) => card.providerId)).toEqual(["openrouter", "anthropic"]);
    expect(cards[0]).toMatchObject({ error: "Sign in again", current: false });
    expect(cards[0]?.rows[0]).toMatchObject({ value: "$12.40 left" });
    expect(cards[0]?.rows[0]?.level).toBeUndefined();
    expect(cards[1]?.rows.map((item) => item.value)).toEqual(["70% used", "90% used", "10% used"]);
  });

  it("shows one provider when it is picked", () => {
    const cards = limitCards(SNAPSHOT, displayOf(SNAPSHOT), NOW, "openrouter");
    expect(cards.map((card) => card.providerId)).toEqual(["openrouter"]);
    expect(limitProviders(SNAPSHOT)).toEqual([
      ["anthropic", "Anthropic"],
      ["openrouter", "OpenRouter"],
    ]);
  });
});

describe("GUI session strip and check time", () => {
  it("writes the session's tokens, and says whether they include subagents", () => {
    expect(sessionStrip(SNAPSHOT, DEFAULT_WORDS)).toEqual({
      tree: false,
      input: "12.3K",
      cached: "1.20M",
      output: "950",
    });
    expect(sessionStrip(SNAPSHOT, { ...DEFAULT_WORDS, sessionTokens: "tree" })?.tree).toBe(true);
    expect(sessionStrip({ ...SNAPSHOT, sessionTokens: undefined }, DEFAULT_WORDS)).toBeUndefined();
  });

  it("takes the latest check of any provider", () => {
    expect(lastCheckedMs(SNAPSHOT)).toBe(NOW - 3 * 60_000);
    expect(lastCheckedMs({ ...SNAPSHOT, providers: [] })).toBeUndefined();
  });
});

describe("GUI reset time", () => {
  it("writes the weekday and time, and the month and day too past 6 days", () => {
    const DAY = 24 * HOUR;
    expect(resetAtFormat(NOW + 6 * DAY, NOW)).toEqual({
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(resetAtFormat(NOW + 20 * DAY, NOW)).toMatchObject({ month: "short", day: "numeric" });
  });
});
