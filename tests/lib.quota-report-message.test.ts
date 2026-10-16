import { describe, expect, it } from "vite-plus/test";

import type { QuotaRow } from "../src/core/types.js";
import {
  containsQuotaReport,
  formatQuotaReportMessage,
  quotaLimitsText,
  quotaMessageText,
  removeQuotaReports,
} from "../src/lib/quota-report-message.js";

describe("quota report messages", () => {
  it("wraps the report in a fixed first and last line", () => {
    const message = formatQuotaReportMessage("# Quota\nopenai  ███░░ 42%");

    expect(message).toBe(
      "[OpenCode Quota report]\n# Quota\nopenai  ███░░ 42%\n[End of OpenCode Quota report]",
    );
    expect(containsQuotaReport(message)).toBe(true);
  });

  it("cuts every complete report out of text and leaves everything else", () => {
    const first = formatQuotaReportMessage("openai 42%");
    const second = formatQuotaReportMessage("anthropic 7%");
    const text = `[User]: hi\n\n[User]: ${first}\n\n[Assistant]: ok\n\n[User]: ${second}`;

    expect(removeQuotaReports(text)).toBe("[User]: hi\n\n[User]: \n\n[Assistant]: ok\n\n[User]: ");
    expect(removeQuotaReports("[OpenCode Quota report] without an end line")).toBe(
      "[OpenCode Quota report] without an end line",
    );
    expect(removeQuotaReports("no report")).toBe("no report");
  });

  it("writes the quick look of every limit, then all active notices", () => {
    const nowMs = Date.parse("2026-10-10T12:00:00.000Z");
    const row = (id: string, fields: Partial<QuotaRow>): QuotaRow => ({
      id,
      providerId: "anthropic",
      label: id.split(".")[1] ?? "",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      prominence: "primary",
      ...fields,
    });
    const snapshot = {
      version: 6,
      providers: [
        {
          providerId: "anthropic",
          label: "Claude",
          rows: [
            row("anthropic.5h", {
              percentRemaining: 58,
              resetsAt: new Date(nowMs + 134 * 60_000).toISOString(),
            }),
            // Web and Desktop have no display settings, so supplementary rows show too.
            row("anthropic.fable", { percentRemaining: 90, prominence: "supplementary" }),
          ],
          checkedAtMs: nowMs,
          refreshing: false,
          debug: [],
        },
      ],
      resetNotices: [],
      generatedAtMs: nowMs,
      words: {
        percent: "left",
        reset: "exact",
        resetDecimals: 1,
        detail: "detailed",
        runsOut: false,
        onlyCurrentModel: false,
        sessionTokens: "current",
        rowNames: "short",
      },
    } as const;
    const notices = [
      {
        id: "a",
        message: "Copilot moves to AI Credits.",
        url: "https://example.com/a",
      },
      { id: "b", message: "Another active notice." },
    ];

    expect(quotaMessageText({ snapshot, usage: undefined, notices, nowMs }).split("\n")).toEqual([
      "Quota",
      "● Claude  5h 58% left · fable 90% left",
      "",
      "Notices",
      "- Copilot moves to AI Credits.",
      "  https://example.com/a",
      "- Another active notice.",
    ]);
    expect(
      quotaMessageText({
        snapshot: { ...snapshot, providers: [] },
        usage: undefined,
        notices: [],
        nowMs,
      }),
    ).toBe("Quota\nNo quota providers found. Run /quota_status to see why.");
    const otherModel = {
      ...snapshot,
      words: { ...snapshot.words, onlyCurrentModel: true },
      currentModelProviderIds: [],
    };
    expect(quotaMessageText({ snapshot: otherModel, usage: undefined, notices: [], nowMs })).toBe(
      "Quota\nNo quota provider serves the session's current model. Run /quota_status to see why.",
    );

    // The TUI's Limits tab copies the same limits, without the notices and terminal escapes.
    expect(quotaLimitsText(snapshot, nowMs)).toBe(
      quotaMessageText({ snapshot, usage: undefined, notices: [], nowMs }),
    );
    const escaped = {
      ...snapshot,
      providers: [{ ...snapshot.providers[0], label: "Claude\u001b[31m" }],
    };
    expect(quotaLimitsText(escaped, nowMs)).toBe("Quota\n● Claude  5h 58% left · fable 90% left");
    // Like the Limits tab, the copy lists every provider whatever the session's model is.
    expect(quotaLimitsText(otherModel, nowMs)).toBe(quotaLimitsText(snapshot, nowMs));
  });
});
