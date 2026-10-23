import { describe, expect, it } from "vite-plus/test";
import type { ProviderSnapshot, QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import type { UsageProviderRow, UsageReport } from "../src/core/usage.js";
import { defaultDisplaySettings, setIn } from "../src/tui/display.js";
import { quickLookText, quotaProviderIdsOfUsage } from "../src/view/quick-look.js";
import { providerSnapshot, quotaRow as row } from "./helpers/fake-answers.js";

const NOW = new Date(2026, 9, 10, 15).getTime();
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
/** Lines at most this wide. */
const TOAST_45 = 33;

/** A provider whose rows were fetched and checked at NOW. */
const provider = (
  providerId: string,
  label: string,
  rows: QuotaRow[],
  extra: Partial<ProviderSnapshot> = {},
) => providerSnapshot(providerId, label, rows, { okAtMs: NOW, checkedAtMs: NOW, ...extra });

/** Half of the 5-hour window has passed with 30% left: even use would leave 50%. */
const ZAI = provider("zai", "Z.ai", [
  row("zai.five_hour", {
    label: "5h",
    window: "five_hour",
    percentRemaining: 30,
    resetsAt: at(150),
  }),
]);
const COPILOT = provider("copilot", "Copilot", [
  row("copilot.premium", { label: "Premium", percentRemaining: 80 }),
]);
const OPENROUTER = provider("openrouter", "OpenRouter", [], {
  error: { code: "provider_error", status: 500 },
});
/** A custom definition "team-accounting" (label "Team") that serves OpenCode's "team-gateway". */
const TEAM = provider("quota-providers", "Custom providers", [
  row("quota-providers.custom.team-accounting.monthly", {
    account: "Team",
    label: "Monthly",
    percentRemaining: 64,
  }),
]);
const TEAM_ROW_PROVIDERS = { "quota-providers.custom.team-accounting.": "team-gateway" };

function snapshot(providers: ProviderSnapshot[]): QuotaSnapshot {
  return { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
}

function usageRow(providerID: string, costUsd: number, tokens: number, sessions: number) {
  return { providerID, sessions, costUsd, costShare: 0, tokens, tokenShare: 0, unpricedTokens: 0 };
}

/** A report whose shares and totals come from its provider rows (most cost first). */
function report(rows: UsageProviderRow[], range: UsageReport["range"] = "7d"): UsageReport {
  const costUsd = rows.reduce((sum, item) => sum + item.costUsd, 0);
  const tokens = rows.reduce((sum, item) => sum + item.tokens, 0);
  const providers = rows.map((item) => ({
    ...item,
    costShare: costUsd > 0 ? item.costUsd / costUsd : 0,
    tokenShare: tokens > 0 ? item.tokens / tokens : 0,
  }));
  const days = [3, 0, 5, 9, 2, 4, 7].map((share, index) => ({
    date: `2026-10-0${index + 4}`,
    costUsd: (costUsd * share) / 30,
    costShare: share / 30,
    tokens: Math.round((tokens * share) / 30),
    tokenShare: share / 30,
    unpricedTokens: 0,
  }));
  return {
    range,
    generatedAtMs: NOW,
    totals: {
      costUsd,
      sessions: rows.reduce((sum, item) => sum + item.sessions, 0),
      tokens: {
        processed: tokens,
        cachedInput: tokens * 0.6,
        uncachedInput: tokens * 0.3,
        output: tokens * 0.1,
      },
      costByType: {
        input: costUsd * 0.2,
        cacheRead: costUsd * 0.3,
        cacheWrite: costUsd * 0.1,
        output: costUsd * 0.4,
      },
      tokensByType: {
        input: tokens * 0.3,
        cacheRead: tokens * 0.5,
        cacheWrite: tokens * 0.1,
        output: tokens * 0.1,
      },
      cacheSavingsUsd: 98.7,
      unpricedTokens: 0,
      unpricedShare: 0,
    },
    providers,
    models: [],
    days,
  };
}

/** OpenCode used Z.ai (as "zai-coding-plan") and Anthropic; quota checks Z.ai, Copilot, OpenRouter. */
const USAGE = report([
  usageRow("anthropic", 190.42, 2_900_000, 9),
  usageRow("zai-coding-plan", 12.5, 4_100_000, 3),
]);

describe("quick look: providers", () => {
  it("matches OpenCode's provider ids to quota providers", () => {
    expect(quotaProviderIdsOfUsage("zai-coding-plan")).toContain("zai");
    expect(quotaProviderIdsOfUsage("github-copilot")).toContain("copilot");
    expect(quotaProviderIdsOfUsage("team-gateway")).toEqual(["team-gateway"]);
  });
});

describe("quick look: short text", () => {
  const shortText = (fields: Partial<Parameters<typeof quickLookText>[0]> = {}) =>
    quickLookText({
      snapshot: snapshot([ZAI, COPILOT, OPENROUTER]),
      usage: USAGE,
      settings: defaultDisplaySettings(),
      nowMs: NOW,
      ...fields,
    });

  it("writes the range and totals, then one line per provider", () => {
    const lines = shortText().split("\n");
    expect(lines[0]).toBe("Quota · 7 days · $202.92 · 7.00M tokens");
    expect(lines.slice(1)).toEqual([
      "● Anthropic   $190.42",
      "● Z.ai        5h 30% left runs out in 1h 5m  $12.50",
      "● Copilot     Premium 80% left",
      "● OpenRouter  Provider error 500",
    ]);
  });

  it("keeps each amount and limit whole on lines as wide as the toast", () => {
    const message = shortText({
      snapshot: { ...snapshot([ZAI, TEAM]), customRowProviders: TEAM_ROW_PROVIDERS },
      usage: report([
        usageRow("zai-coding-plan", 12.5, 4_100_000, 3),
        usageRow("team-gateway", 3.39, 1_000_000, 2),
      ]),
      width: TOAST_45,
    });
    expect(message.split("\n")).toEqual([
      "Quota · 7 days · $15.89",
      "  5.10M tokens",
      "● Z.ai",
      "  5h 30% left runs out in 1h 5m",
      "  $12.50",
      "● Custom providers (T…",
      "  Monthly 64% left  $3.39",
    ]);
  });

  it("names each limit as the sidebar does: your name, else its window when no other has it", () => {
    const claude = provider("claude", "Claude", [
      row("claude.five_hour", { label: "5h", window: "five_hour", percentRemaining: 41 }),
      row("claude.weekly", { label: "Weekly", window: "week", percentRemaining: 68 }),
      row("claude.weekly_fable", { label: "Fable", window: "week", percentRemaining: 90 }),
    ]);
    const settings = setIn(defaultDisplaySettings(), ["sidebar", "names"], {
      "claude.five_hour": "Session",
    });
    expect(shortText({ snapshot: snapshot([claude]), usage: undefined, settings })).toBe(
      "Quota\n● Claude  Session 41% left · Weekly 68% left · Fable 90% left",
    );
  });

  it("says when quota found no provider", () => {
    expect(shortText({ snapshot: snapshot([]), usage: report([]) })).toBe(
      "Quota · 7 days · no usage\nNo quota providers found. Run /quota_status to see why.",
    );
  });
});
