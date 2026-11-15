import { describe, expect, it, vi } from "vite-plus/test";
import type { UsageQuery, UsageReport } from "../src/core/usage.js";
import type { GuiQuota } from "../src/gui/bridge.js";
import { createUsageAnswers } from "../src/gui/usage-answers.js";

const QUERY = { range: "7d" } as UsageQuery;
const REPORT = { range: "7d" } as UsageReport;

describe("the usage window's reports", () => {
  it("drops the answer to a question that went away, and stops loading", async () => {
    let answer = (_report: UsageReport) => {};
    const usage = vi.fn(
      () =>
        new Promise<UsageReport>((resolve) => {
          answer = resolve;
        }),
    );
    const answers = createUsageAnswers({ usage } as unknown as GuiQuota);

    answers.ask(QUERY, "/a", { range: "7d", scope: "all" });
    // The view moves to Limits, or Cost's dates go bad: no question now.
    answers.ask(undefined, "/a", { range: "7d", scope: "all" });
    answer(REPORT);
    await Promise.resolve();

    expect(answers.usage()).toEqual({ loading: false });
  });
});
