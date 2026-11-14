import { afterEach, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import type { QuotaSnapshot } from "../src/core/types.js";
import { panelView, pickedGroups } from "../src/gui/surfaces-model.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { openaiProvider } from "../src/providers/openai.js";
import { defaultSettings } from "../src/settings/schema.js";
import { visibleGroups } from "../src/view/select.js";
import {
  lineText,
  plainLines,
  sidebarPanel,
  statusLayout,
  statusLineInput,
  toastInput,
  toastLines,
} from "../src/view/text.js";
import { fakeHttp, requestHeader } from "./helpers/provider-fetch.js";

vi.mock("../src/lib/opencode-auth.js", async (original) => ({
  ...(await original<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));
afterEach(() => vi.unstubAllGlobals());

async function snapshot(credits: unknown, several = false): Promise<QuotaSnapshot> {
  vi.mocked(readCredentialRows).mockResolvedValue(
    (several ? ["A", "B"] : ["A"]).map((label) => ({
      id: label,
      integrationId: "openai",
      label,
      active: label === "A",
      value: { type: "oauth", access: label },
    })),
  );
  const http = fakeHttp((_url, init) => ({
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        limit_window_seconds: 18000,
        used_percent: 28,
      },
    },
    credits:
      several && requestHeader(init, "Authorization") === "Bearer B"
        ? { has_credits: true, balance: "2500.25" }
        : credits,
  }));
  const fetched = rowsFromProviderResult(
    "openai",
    await openaiProvider.fetch({ config: {} } as never),
  );
  expect(fetched.error).toBeUndefined();
  expect(http).toHaveBeenCalledTimes(several ? 2 : 1);
  return {
    version: 6,
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        rows: fetched.rows,
        checkedAtMs: 0,
        refreshing: false,
      },
    ],
    resetNotices: [],
    generatedAtMs: 0,
    serverId: "test",
    revision: 1,
  };
}

it.each(["1250.5", "0", "0.000001", "9007199254740993.123456789000"])(
  "keeps exact decimal %s",
  async (balance) => {
    const result = await snapshot({ has_credits: true, balance });
    expect(
      result.providers[0]!.rows.find((row) => row.id === "openai.codex_credits")?.amount?.decimal,
    ).toBe(balance);
  },
);
it.each([
  undefined,
  null,
  {},
  { has_credits: false },
  { has_credits: false, unlimited: false, balance: null },
  { has_credits: false, balance: "0" },
  { balance: "12.5" },
])("adds no credits row for %j", async (credits) => {
  const rows = (await snapshot(credits)).providers[0]!.rows;
  expect(rows.map((row) => row.id)).toEqual(["openai.five_hour"]);
});
it.each([
  { has_credits: true },
  { has_credits: true, balance: null },
  { has_credits: true, balance: "bad" },
  { has_credits: true, balance: 12 },
  { has_credits: true, balance: "-1" },
])("shows no data for %j", async (credits) => {
  const row = (await snapshot(credits)).providers[0]!.rows.find(
    (item) => item.id === "openai.codex_credits",
  );
  expect(row?.text).toBe("No data");
  expect(row?.amount).toBeUndefined();
});
it("honors explicit unlimited before the balance", async () => {
  const row = (await snapshot({ unlimited: true, balance: "0" })).providers[0]!.rows.at(-1);
  expect(row?.text).toBe("Unlimited credits");
  expect(row?.amount).toBeUndefined();
});
it("keeps fractions in compact surfaces and full units in reports", async () => {
  const result = await snapshot({ has_credits: true, balance: "1250.5" });
  const settings = defaultSettings();
  const texts = [
    sidebarPanel(result, settings, { nowMs: 0, width: 50, open: true }).lines,
    toastLines(toastInput(result, settings, { nowMs: 0, width: 100 })),
    statusLayout(statusLineInput(result, settings, 0), 200, 0, "full").shown,
  ].map((lines) => lines.map(lineText).join("\n"));
  for (const text of texts) {
    expect(text).toContain("Codex credits");
    expect(text).toContain("1,250.5");
    expect(text).not.toContain("credits left");
  }
  expect(panelView(result, settings, 0).groups[0]?.rows.at(-1)?.value).toBe("1,250.5");
  expect(pickedGroups(result, settings, "statusLine", 0).at(-1)?.row?.value).toBe("1,250.5");
  expect(
    plainLines({
      groups: visibleGroups(result, settings, "sidebar", settings.words),
      words: settings.words,
      nowMs: 0,
    }).join("\n"),
  ).toContain("1,250.5 credits left");
});
it("keeps account balances separate, named, hidden and pageable with stale warnings", async () => {
  const result = await snapshot({ has_credits: true, balance: "1250.5" }, true);
  const settings = defaultSettings();
  settings.sidebar.names["openai.codex_credits"] = "My credits";
  result.providers[0]!.error = { code: "network" };
  const groups = pickedGroups(result, settings, "statusLine", 0);
  expect(groups).toHaveLength(4);
  expect(new Set(groups.map((group) => group.id)).size).toBe(4);
  for (const group of groups.filter((group) => group.row?.id === "openai.codex_credits")) {
    expect(group.title).toContain("My credits");
    expect(group.error).toBeDefined();
  }
  expect(
    groups
      .filter((group) => group.row?.id === "openai.codex_credits")
      .map((group) => group.row?.value),
  ).toEqual(["1,250.5", "2,500.25"]);
  const input = statusLineInput(result, settings, 0);
  expect(statusLayout(input, 50, 0, "numbers").hiddenAfter).toBeGreaterThan(0);
  expect(statusLayout(input, 200, 1, "numbers").shown.map(lineText).join(" ")).toContain("1,250.5");
  settings.statusLine.hidden = ["openai.codex_credits"];
  expect(pickedGroups(result, settings, "statusLine", 0)).toHaveLength(2);
});
