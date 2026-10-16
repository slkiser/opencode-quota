import { describe, expect, it } from "vite-plus/test";
import { OLD_USAGE_COMMANDS, parseUsageArguments, USAGE_RANGES } from "../src/core/usage-ranges.js";

describe("usage ranges", () => {
  it("lists every range in order, with its label", () => {
    expect(USAGE_RANGES.map((item) => [item.range, item.label])).toEqual([
      ["today", "Today"],
      ["24h", "24 hours"],
      ["7d", "7 days"],
      ["30d", "30 days"],
      ["90d", "90 days"],
      ["all", "All time"],
      ["session", "This session"],
      ["between", "Between"],
    ]);
  });

  it("shows today when /quota_usage has no range", () => {
    expect(parseUsageArguments("  ")).toEqual({ ok: true, range: "today" });
    expect(parseUsageArguments("90d")).toEqual({ ok: true, range: "90d" });
    expect(parseUsageArguments("all")).toEqual({ ok: true, range: "all" });
  });

  it("answers /quota_usage session_tree as an unknown range", () => {
    expect(parseUsageArguments("session_tree")).toEqual({
      ok: false,
      error: `Unknown range "session_tree".\nUsage: /quota_usage [today | 24h | 7d | 30d | 90d | all | session | between YYYY-MM-DD YYYY-MM-DD]`,
    });
  });

  it("runs the old session commands on this session and /tokens_all on all time", () => {
    expect(OLD_USAGE_COMMANDS).toEqual({
      tokens_today: "today",
      tokens_daily: "24h",
      tokens_weekly: "7d",
      tokens_monthly: "30d",
      tokens_all: "all",
      tokens_session: "session",
      tokens_session_all: "session",
      tokens_between: "between",
    });
  });
});
