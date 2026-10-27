import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { QUOTA_RPC_ID, QuotaRpc } from "../src/rpc.js";

type ValidateResult = { value?: unknown; issues?: ReadonlyArray<{ message: string }> };
type StandardSchema = {
  "~standard": {
    version: number;
    vendor: string;
    types?: unknown;
    validate: (value: unknown) => unknown;
  };
};

async function validate(schema: StandardSchema, value: unknown): Promise<ValidateResult> {
  return (await schema["~standard"].validate(value)) as ValidateResult;
}

async function expectAccepted(schema: StandardSchema, value: unknown): Promise<void> {
  const result = await validate(schema, value);
  expect(result.issues).toBeUndefined();
  expect(result.value).toBe(value);
}

async function expectRejected(schema: StandardSchema, value: unknown, message: string) {
  const result = await validate(schema, value);
  expect(result.issues).toEqual([{ message }]);
  expect(result).not.toHaveProperty("value");
}

const methods = QuotaRpc.methods;

describe("quota RPC definition", () => {
  it("defines the plain RPC id, the changed event and its methods", () => {
    expect(QUOTA_RPC_ID).toBe("slkiser.opencode-quota");
    expect(QuotaRpc.id).toBe(QUOTA_RPC_ID);
    expect(Object.keys(QuotaRpc.events)).toEqual(["changed"]);
    expect(Object.keys(methods)).toEqual([
      "snapshot",
      "refresh",
      "notices",
      "noticeList",
      "status",
      "usage",
      "downloadPrices",
      "settings",
      "saveSettings",
    ]);
  });

  it("uses Standard Schema v1 validators that carry no runtime types", () => {
    const schemas = [
      ...Object.values(methods).flatMap((method) => [method.input, method.output]),
      QuotaRpc.events.changed.schema,
    ];
    for (const schema of schemas) {
      expect(schema["~standard"]).toEqual(
        expect.objectContaining({ version: 1, vendor: "opencode-quota" }),
      );
      expect(schema["~standard"]).not.toHaveProperty("types");
    }
  });

  it("validates snapshot and refresh input", async () => {
    await expectAccepted(methods.snapshot.input, {});
    await expectAccepted(methods.snapshot.input, { sessionID: "session-1" });
    await expectRejected(methods.snapshot.input, null, "input must be an object");
    await expectRejected(methods.snapshot.input, { sessionID: 1 }, "sessionID must be a string");

    for (const reason of ["poll", "turn", "manual"]) {
      await expectAccepted(methods.refresh.input, { reason });
    }
    await expectAccepted(methods.refresh.input, {
      reason: "manual",
      providerIds: ["copilot", "anthropic"],
      sessionID: "session-1",
    });
    const reasonIssue = "reason must be one of poll, turn, manual";
    await expectRejected(methods.refresh.input, [], "input must be an object");
    await expectRejected(methods.refresh.input, {}, reasonIssue);
    // A retry refresh is the server's own; clients can't ask for one.
    await expectRejected(methods.refresh.input, { reason: "retry" }, reasonIssue);
    await expectRejected(
      methods.refresh.input,
      { reason: "manual", providerIds: "copilot" },
      "providerIds must be a list of strings",
    );
    await expectRejected(
      methods.refresh.input,
      { reason: "manual", providerIds: [1] },
      "providerIds must be a list of strings",
    );
    await expectRejected(
      methods.refresh.input,
      { reason: "poll", sessionID: false },
      "sessionID must be a string",
    );
  });

  it("validates notices input and requires a homeLine string in its output", async () => {
    await expectAccepted(methods.notices.input, {});
    for (const value of [undefined, null, []]) {
      await expectRejected(methods.notices.input, value, "input must be an object");
    }
    await expectAccepted(methods.notices.output, { homeLine: "" });
    for (const value of [null, {}, { homeLine: 1 }]) {
      await expectRejected(methods.notices.output, value, "output must carry a homeLine string");
    }
  });

  it("validates noticeList and status input and requires their output", async () => {
    await expectAccepted(methods.noticeList.input, {});
    for (const input of [undefined, null, []]) {
      await expectRejected(methods.noticeList.input, input, "input must be an object");
    }
    await expectAccepted(methods.noticeList.output, { notices: [] });
    await expectRejected(methods.noticeList.output, {}, "output must carry notices");

    await expectAccepted(methods.status.input, {});
    await expectAccepted(methods.status.input, { sessionID: "ses_1" });
    await expectRejected(methods.status.input, [], "input must be an object");
    await expectRejected(methods.status.input, { sessionID: 1 }, "sessionID must be a string");
    await expectAccepted(methods.status.output, { text: "" });
    await expectRejected(methods.status.output, { text: 1 }, "output must carry a text");
  });

  it("validates usage input", async () => {
    for (const range of ["today", "24h", "7d", "30d", "90d", "all"]) {
      await expectAccepted(methods.usage.input, { range });
    }
    await expectAccepted(methods.usage.input, { range: "session", sessionID: "ses_1" });
    await expectAccepted(methods.usage.input, {
      range: "session",
      sessionID: "ses_1",
      subagents: false,
    });
    // Leap days exist in leap years only (every 4th year, but not 1900; 2000 is one).
    for (const [from, to] of [
      ["2026-01-01", "2026-01-01"],
      ["2028-02-29", "2028-03-01"],
      ["2000-02-29", "2000-02-29"],
    ]) {
      await expectAccepted(methods.usage.input, { range: "between", from, to });
    }

    const rangeIssue = "range must be one of today, 24h, 7d, 30d, 90d, all, session, between";
    const cases: Array<[unknown, string]> = [
      [null, "input must be an object"],
      [{}, rangeIssue],
      [{ range: "session_tree", sessionID: "ses_1" }, rangeIssue],
      [{ range: "toString" }, rangeIssue],
      [{ range: "90d", sessionID: 1 }, "sessionID must be a string"],
      [{ range: "session", sessionID: "ses_1", subagents: "no" }, "subagents must be a boolean"],
      [{ range: "session" }, "sessionID is required for range session"],
      [{ range: "session", sessionID: "" }, "sessionID is required for range session"],
      [{ range: "between", to: "2026-01-01" }, "from must be a date like 2026-01-31"],
      [
        { range: "between", from: "2026-01-01", to: "1/2/2026" },
        "to must be a date like 2026-01-31",
      ],
      // Shaped like dates, but no such day: the report would fail on them.
      [
        { range: "between", from: "2026-02-31", to: "2026-03-01" },
        "from must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "2026-02-01", to: "2026-02-29" },
        "to must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "1900-02-29", to: "1900-03-01" },
        "from must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "2026-04-31", to: "2026-05-01" },
        "from must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "2026-13-01", to: "2026-13-02" },
        "from must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "2026-00-10", to: "2026-01-02" },
        "from must be a date like 2026-01-31",
      ],
      [
        { range: "between", from: "2026-01-00", to: "2026-01-02" },
        "from must be a date like 2026-01-31",
      ],
      [{ range: "between", from: "2026-01-02", to: "2026-01-01" }, "to must not be before from"],
    ];
    for (const [input, issue] of cases) {
      await expectRejected(methods.usage.input, input, issue);
    }
  });

  it("requires a report in usage output, and ok and a message in downloadPrices output", async () => {
    await expectAccepted(methods.usage.output, { report: { range: "90d" } });
    for (const value of [undefined, {}, { report: null }, { report: [] }]) {
      await expectRejected(methods.usage.output, value, "output must carry a report");
    }
    await expectAccepted(methods.downloadPrices.input, {});
    await expectRejected(methods.downloadPrices.input, null, "input must be an object");
    await expectAccepted(methods.downloadPrices.output, { ok: true, message: "Downloaded." });
    for (const value of [{}, { ok: "yes", message: "" }, { ok: false }]) {
      await expectRejected(
        methods.downloadPrices.output,
        value,
        "output must carry ok and a message",
      );
    }
  });

  it("validates settings and saveSettings", async () => {
    await expectAccepted(methods.settings.input, {});
    await expectRejected(methods.settings.input, null, "input must be an object");
    await expectAccepted(methods.settings.output, {
      values: {},
      fromFile: [],
      providers: [],
      custom: [],
    });
    for (const value of [
      {},
      { values: {}, fromFile: [], providers: [] },
      { values: [], fromFile: [], providers: [], custom: [] },
      { values: {}, providers: [], custom: [] },
    ]) {
      await expectRejected(
        methods.settings.output,
        value,
        "output must carry values, fromFile, providers and custom",
      );
    }
    await expectAccepted(methods.saveSettings.input, { patch: { words: { percent: "used" } } });
    await expectAccepted(methods.saveSettings.input, {
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "abc" } },
    });
    for (const value of [undefined, {}, { patch: null }, { patch: [] }]) {
      await expectRejected(methods.saveSettings.input, value, "input must carry a patch object");
    }
    for (const customEnabled of [[], { gw: true }, { gw: { enabled: true } }, null]) {
      await expectRejected(
        methods.saveSettings.input,
        { patch: {}, customEnabled },
        "customEnabled must map provider ids to { enabled, fingerprint }",
      );
    }
    await expectAccepted(methods.saveSettings.output, { ok: false, issues: [] });
    for (const value of [{}, { ok: "yes", issues: [] }, { ok: true }]) {
      await expectRejected(methods.saveSettings.output, value, "output must carry ok and issues");
    }
  });

  it("requires a snapshot in snapshot and refresh output and in the changed event", async () => {
    const snapshot = { version: 6, providers: [], resetNotices: [], generatedAtMs: 1 };
    for (const schema of [
      methods.snapshot.output,
      methods.refresh.output,
      QuotaRpc.events.changed.schema,
    ]) {
      await expectAccepted(schema, { snapshot });
      for (const value of [undefined, null, {}, { snapshot: null }, { snapshot: [] }]) {
        await expectRejected(schema, value, "output must carry a snapshot");
      }
    }
  });

  it("ships dist/rpc.js without loading any @opencode package", () => {
    const source = readFileSync(new URL("../dist/rpc.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*["']@opencode\//);
    expect(source).toContain('from "./lib/calendar-date.js"');
  });
});
