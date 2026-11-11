import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import { createQuotaStore } from "../src/core/store.js";
import type { QuotaRow, QuotaSnapshot } from "../src/core/types.js";
import { displayOf, limitCards } from "../src/gui/limits-model.js";
import { panelView, pickedGroups, pickedText, toastView } from "../src/gui/surfaces-model.js";
import { queryOpenAIQuota } from "../src/lib/openai.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { PROVIDER_ROW_KEYS } from "../src/lib/provider-metadata.js";
import { openaiProvider } from "../src/providers/openai.js";
import { defaultSettings } from "../src/settings/schema.js";
import { amountText, rowValueText } from "../src/view/format.js";
import { rowFacts } from "../src/view/row-facts.js";
import { visibleGroups, visibleRow } from "../src/view/select.js";
import {
  bigStatusLine,
  lineText,
  plainLines,
  statusLayout,
  statusLineInput,
  toastInput,
} from "../src/view/text.js";
import { fakeHttp } from "./helpers/provider-fetch.js";

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

const AUTH = { state: "configured", sourceKey: "openai", accessToken: "test-token" } as const;
const WINDOW = { used_percent: 100, limit_window_seconds: 604800 };

function reply(credits: unknown) {
  return { plan_type: "pro", rate_limit: { primary_window: WINDOW }, credits };
}

async function providerRows(credits: unknown) {
  vi.mocked(readCredentialRows).mockResolvedValue([
    {
      id: "test-login",
      integrationId: "openai",
      label: "default",
      active: true,
      value: { type: "oauth", access: "test-token" },
    },
  ]);
  fakeHttp(() => reply(credits));
  return rowsFromProviderResult("openai", await openaiProvider.fetch({ config: {} } as never), 0);
}

function snapshotOf(rows: QuotaRow[]): QuotaSnapshot {
  return {
    version: 6,
    providers: [{ providerId: "openai", label: "OpenAI", rows, refreshing: false, checkedAtMs: 0 }],
    resetNotices: [],
    generatedAtMs: 0,
    serverId: "test",
    revision: 1,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Codex credits", () => {
  it("registers the stable credit row for diagnostics and provider contracts", () => {
    expect(PROVIDER_ROW_KEYS.openai).toContain("codex_credits");
  });
  it.each([
    [0.0000001, "0.0000001"],
    [Number("1.2345678901234567e-7"), "0.00000012345678901234566"],
    [Number.MIN_VALUE, `0.${"0".repeat(323)}5`],
    [-0, "0"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
  ])("expands the shortest numeric balance %s without rounding", async (balance, expected) => {
    fakeHttp(() => reply({ balance }));
    expect(await queryOpenAIQuota({ auth: AUTH })).toMatchObject({
      success: true,
      credits: { balance: expected },
    });
  });

  it.each([
    {},
    { balance: "garbage" },
    { balance: "" },
    { balance: true },
    { balance: "1e-7" },
    { balance: Number.MAX_SAFE_INTEGER + 1 },
    { unlimited: false },
    { has_credits: false, balance: "bad" },
  ])("rejects an unusable credits-only response (%j)", async (credits) => {
    fakeHttp(() => ({ plan_type: "pro", rate_limit: null, credits }));
    expect(await queryOpenAIQuota({ auth: AUTH })).toEqual({
      success: false,
      error: "No quota data",
    });
  });

  it.each([true, false])(
    "allows a known has_credits flag %s without inventing an amount",
    async (hasCredits) => {
      fakeHttp(() => ({
        plan_type: "pro",
        rate_limit: null,
        credits: { has_credits: hasCredits, balance: null },
      }));
      expect(await queryOpenAIQuota({ auth: AUTH })).toMatchObject({
        success: true,
        windows: {},
        credits: { hasCredits },
      });
    },
  );

  it("allows unlimited despite a malformed amount without windows", async () => {
    fakeHttp(() => ({
      plan_type: "pro",
      rate_limit: null,
      credits: { unlimited: true, balance: "bad" },
    }));
    expect(await queryOpenAIQuota({ auth: AUTH })).toMatchObject({
      success: true,
      credits: { unlimited: true },
    });
  });

  it("does not rewrite a reported balance from a contradictory has_credits flag", async () => {
    fakeHttp(() => reply({ balance: "12.34", has_credits: false }));
    expect(await queryOpenAIQuota({ auth: AUTH })).toMatchObject({
      success: true,
      credits: { balance: "12.34", hasCredits: false },
    });
  });

  it.each([
    ["54034.7659980000", "54034.765998"],
    ["00012.3400", "12.34"],
    ["0", "0"],
    [0, "0"],
    [12.5, "12.5"],
    ["9007199254740993.123456789", "9007199254740993.123456789"],
  ])("preserves and canonicalizes balance %s", async (balance, expected) => {
    fakeHttp(() => reply({ balance, has_credits: true, unlimited: false }));
    const result = await queryOpenAIQuota({ auth: AUTH });
    expect(result).toMatchObject({
      success: true,
      credits: { balance: expected, hasCredits: true, unlimited: false },
    });
  });

  it.each([
    undefined,
    null,
    {},
    { balance: null },
    { balance: "" },
    { balance: "oops" },
    { balance: false },
    { balance: -1 },
    { balance: "-1" },
    { has_credits: false },
  ])("shows missing or invalid credits as No data, never zero (%j)", async (credits) => {
    const fetched = await providerRows(credits);
    expect(fetched.rows.find((row) => row.id === "openai.codex_credits")).toMatchObject({
      type: "balance",
      text: "No data",
    });
    expect(fetched.rows.find((row) => row.id === "openai.codex_credits")?.amount).toBeUndefined();
  });

  it("shows an explicitly reported zero as zero credits", async () => {
    const fetched = await providerRows({ balance: "0", has_credits: false, unlimited: false });
    const credits = fetched.rows.find((row) => row.id === "openai.codex_credits");
    expect(credits?.amount).toEqual({ decimal: "0", unit: { kind: "count", unit: "credit" } });
    expect(amountText(credits!.amount!)).toBe("0 credits");
  });

  it("shows unlimited without presenting a misleading zero", async () => {
    const fetched = await providerRows({ balance: "0", unlimited: true });
    expect(fetched.rows.find((row) => row.id === "openai.codex_credits")).toMatchObject({
      text: "Unlimited credits",
    });
  });

  it("supports a credits-only response without rate-limit windows", async () => {
    fakeHttp(() => ({ plan_type: "pro", rate_limit: null, credits: { balance: "2.5" } }));
    expect(await queryOpenAIQuota({ auth: AUTH })).toMatchObject({
      success: true,
      windows: {},
      credits: { balance: "2.5" },
    });
  });

  it.each(["unusable", "401", "429", "network"])(
    "preserves stale credits after %s, then recovers and replaces a missing balance",
    async (failure) => {
      await providerRows({ balance: "12.34" });
      let payload: unknown = reply({ balance: "12.34" });
      let clock = 1_000;
      let failing = false;
      const http = fakeHttp(() => {
        if (failing && failure === "network") throw new Error("synthetic network failure");
        if (failing && ["401", "429"].includes(failure))
          return new Response("{}", { status: Number(failure) });
        return payload;
      });
      const store = createQuotaStore({
        source: async () => ({
          minIntervalMs: 0,
          providers: [
            {
              id: "openai",
              label: "OpenAI",
              identity: async () => ({ key: "synthetic-account", persist: false }),
              fetch: async () =>
                rowsFromProviderResult(
                  "openai",
                  await openaiProvider.fetch({ config: {} } as never),
                  clock,
                ),
            },
          ],
        }),
        file: null,
        now: () => clock,
      });
      try {
        const first = (await store.refresh({ reason: "manual" })).providers[0]!;
        expect(first.rows.find((row) => row.id === "openai.codex_credits")?.amount?.decimal).toBe(
          "12.34",
        );
        expect(first.okAtMs).toBe(clock);
        clock += 60_000;
        failing = true;
        payload = { plan_type: "pro", rate_limit: null, credits: {} };
        const stale = (await store.refresh({ reason: "manual" })).providers[0]!;
        expect(stale.error).toBeDefined();
        expect(stale.rows).toEqual(first.rows);
        expect(stale.okAtMs).toBe(first.okAtMs);
        expect(stale.checkedAtMs).toBe(clock);
        clock += 60_000;
        failing = false;
        payload = reply({ balance: "9.5" });
        const recovered = (await store.refresh({ reason: "manual" })).providers[0]!;
        expect(recovered.error).toBeUndefined();
        expect(
          recovered.rows.find((row) => row.id === "openai.codex_credits")?.amount?.decimal,
        ).toBe("9.5");
        expect(recovered.okAtMs).toBe(clock);
        clock += 60_000;
        payload = reply(null);
        const unknown = (await store.refresh({ reason: "manual" })).providers[0]!;
        const credits = unknown.rows.find((row) => row.id === "openai.codex_credits");
        expect(unknown.error).toBeUndefined();
        expect(credits?.amount).toBeUndefined();
        expect(credits?.text).toBe("No data");
        expect(http).toHaveBeenCalledTimes(4);
      } finally {
        await store.dispose();
      }
    },
  );

  it.each([
    ["50209.206695", "50,209"],
    ["54034.7659980000", "54,034"],
    ["123.99", "123"],
    ["0", "0"],
    ["0.25", "0"],
    ["0.999999", "0"],
    ["1.999", "1"],
    ["999.999", "999"],
    ["1000.001", "1,000"],
    ["9007199254740993.123456789", "9,007,199,254,740,993"],
  ])(
    "shows balance %s as %s only in compact UI, without mutating the snapshot",
    async (balance, expected) => {
      const fetched = await providerRows({ balance });
      const snapshot = snapshotOf(fetched.rows);
      const before = structuredClone(snapshot);
      const settings = defaultSettings();
      const credit = fetched.rows.find((row) => row.id === "openai.codex_credits")!;
      const full = rowValueText(credit);
      expect(full).toContain("credits left");

      const groups = pickedGroups(snapshot, settings, "statusLine", 0);
      const status = groups.find((group) => group.row?.id === credit.id)!;
      expect(status.row?.value).toBe(expected);
      expect(pickedText(status, "Unchecked")).toContain("Codex credits");
      expect(pickedText(status, "Unchecked")).not.toContain("credits left");
      expect(groups[0]?.row?.percent).toBe(0);

      for (const rows of [
        limitCards(snapshot, displayOf(snapshot), 0).flatMap((card) => card.rows),
        panelView(snapshot, settings, 0).groups.flatMap((group) => group.rows),
      ]) {
        expect(rows.find((row) => row.id === credit.id)).toMatchObject({
          name: "Codex credits",
          value: expected,
        });
      }

      for (const level of ["auto", "full", "bar", "reset", "numbers"] as const) {
        const rendered = statusLayout(statusLineInput(snapshot, settings, 0), 200, 0, level);
        const line = rendered.shown.find((line) => lineText(line).includes("Codex credits"));
        expect(line?.segments.find((segment) => segment.role === "value")?.text.trim()).toBe(
          expected,
        );
      }

      const toast = toastView(toastInput(snapshot, settings, { nowMs: 0, width: 200 }));
      expect(
        toast.groups.flatMap((group) => group.rows).find((row) => row.id === credit.id)?.value,
      ).toBe(full);
      expect(
        plainLines({
          groups: visibleGroups(snapshot, settings, "sidebar", settings.words),
          words: settings.words,
          nowMs: 0,
        }).join("\n"),
      ).toContain(full);
      expect(rowValueText(credit)).toBe(full);
      expect(snapshot).toEqual(before);
    },
  );

  it.each([
    { credits: null, text: "No data" },
    { credits: { balance: "bad" }, text: "No data" },
    { credits: { balance: "0", unlimited: true }, text: "Unlimited credits" },
  ])("keeps $text in compact surfaces", async ({ credits, text }) => {
    const fetched = await providerRows(credits);
    const snapshot = snapshotOf(fetched.rows);
    const settings = defaultSettings();
    const status = pickedGroups(snapshot, settings, "statusLine", 0).find(
      (group) => group.row?.id === "openai.codex_credits",
    );
    expect(status?.row?.value).toBe(text);
    for (const rows of [
      limitCards(snapshot, displayOf(snapshot), 0).flatMap((card) => card.rows),
      panelView(snapshot, settings, 0).groups.flatMap((group) => group.rows),
    ]) {
      expect(rows.find((row) => row.id === "openai.codex_credits")?.value).toBe(text);
    }
    expect(
      statusLayout(statusLineInput(snapshot, settings, 0), 200, 0, "full")
        .shown.map(lineText)
        .join(" "),
    ).toContain(text);
  });

  const fullValueCases: { name: string; fields: Partial<QuotaRow>; expected: string }[] = [
    {
      name: "another balance in credits",
      fields: { id: "other.credits" },
      expected: "12.34 credits left",
    },
    { name: "a usage row", fields: { type: "usage" }, expected: "12.34 credits used" },
    {
      name: "a currency balance",
      fields: { amount: { decimal: "20.5", unit: { kind: "currency", code: "USD" } } },
      expected: "$20.50 left",
    },
    {
      name: "another count unit",
      fields: { amount: { decimal: "12.34", unit: { kind: "count", unit: "request" } } },
      expected: "12.34 requests left",
    },
    {
      name: "a custom unit",
      fields: { amount: { decimal: "12.34", unit: { kind: "custom", symbol: "token" } } },
      expected: "12.34 token left",
    },
    { name: "a missing amount", fields: { amount: undefined }, expected: "" },
    {
      name: "No data takes precedence over an amount",
      fields: { text: "No data" },
      expected: "No data",
    },
    {
      name: "Unlimited takes precedence over an amount",
      fields: { text: "Unlimited credits" },
      expected: "Unlimited credits",
    },
  ];

  it.each(fullValueCases)(
    "keeps the full value for $name even with compact opt-in",
    async ({ fields, expected }) => {
      const fetched = await providerRows({ balance: "12.34" });
      const credit = fetched.rows.find((row) => row.id === "openai.codex_credits")!;
      const item = visibleRow({ ...credit, ...fields }, {});
      const place = {
        words: defaultSettings().words,
        nowMs: 0,
        names: "words",
        percent: "number",
      } as const;
      expect(rowFacts(item, { rows: [item] }, { ...place, codexCredits: "compact" }).value).toBe(
        expected,
      );
      expect(rowFacts(item, { rows: [item] }, place).value).toBe(expected);
      const original = visibleRow(credit, {});
      expect(rowFacts(original, { rows: [original] }, place).value).toBe("12.34 credits left");
    },
  );

  it("shows credits beside the weekly limit in Desktop, in credits and not dollars", async () => {
    const fetched = await providerRows({ balance: "54034.7659980000", has_credits: true });
    const snapshot = {
      version: 6,
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          rows: fetched.rows,
          refreshing: false,
          checkedAtMs: 0,
        },
      ],
      resetNotices: [],
      generatedAtMs: 0,
      serverId: "test",
      revision: 1,
    } as QuotaSnapshot;
    const settings = defaultSettings();
    const groups = pickedGroups(snapshot, settings, "statusLine", 0);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.row?.percent).toBe(0);
    expect(groups[1]?.title).toContain("Codex credits");
    expect(groups[1]?.row?.value).toBe("54,034");
    expect(groups[1]?.row?.value).not.toContain("$");

    const tui = statusLayout(statusLineInput(snapshot, settings, 0), 200, 0, "full");
    expect(tui.shown.map(lineText).join(" ")).toContain("Codex credits 54,034");
    expect(tui.shown.map(lineText).join(" ")).not.toContain("(Pro)");

    const failed = structuredClone(snapshot);
    failed.providers[0]!.error = { code: "network" };
    const staleTui = statusLayout(statusLineInput(failed, settings, 0), 200, 0, "full");
    expect(staleTui.shown.map(lineText).join(" ")).toContain("Codex credits 54,034");
    const staleCredit = pickedGroups(failed, settings, "statusLine", 0)[1]!;
    expect(staleCredit.error).toBeDefined();
    expect(pickedText(staleCredit, "Unchecked")).toContain("Codex credits 54,034");
    expect(pickedText(staleCredit, "Unchecked")).toContain(staleCredit.error!);

    settings.sidebar.names = { "openai.codex_credits": "My credits" };
    expect(pickedGroups(snapshot, settings, "statusLine", 0)[1]?.title).toBe("My credits");
    expect(pickedGroups(snapshot, settings, "statusLine", 0)[1]?.row?.value).toBe("54,034");
    expect(
      statusLayout(statusLineInput(snapshot, settings, 0), 200, 0, "full")
        .shown.map(lineText)
        .join(" "),
    ).toContain("My credits");

    settings.statusLine.hidden = ["openai.weekly"];
    const onlyCredits = pickedGroups(snapshot, settings, "statusLine", 0);
    expect(onlyCredits).toHaveLength(1);
    expect(onlyCredits[0]?.title).toBe("My credits");
    const staleOnly = statusLineInput(failed, settings, 0);
    expect(lineText(bigStatusLine(staleOnly, 16)!)).toContain("⚠");
    for (const width of [24, 28, 32, 36]) {
      const narrow = bigStatusLine(staleOnly, width)!;
      // The shorter balance may leave room for the error's words instead of its marker.
      expect(narrow.segments.find((segment) => segment.role === "error")?.text).toMatch(
        /[A-Za-z]|⚠/u,
      );
    }

    settings.statusLine.hidden = ["openai.codex_credits"];
    expect(pickedGroups(snapshot, settings, "statusLine", 0)).toHaveLength(1);
  });

  it("keeps two accounts' balances separate across active-account switching and one failed login", async () => {
    const logins = ["A", "B"].map((name, index) => ({
      id: `login-${name}`,
      integrationId: "openai",
      label: name,
      active: index === 0,
      value: { type: "oauth", access: `token-${name}` },
    }));
    vi.mocked(readCredentialRows).mockImplementation(async () => logins);
    let failedLogin = false;
    const http = fakeHttp((_url, init) => {
      const isA = new Headers(init.headers).get("Authorization") === "Bearer token-A";
      if (!isA && failedLogin) return new Response("{}", { status: 401 });
      return reply({ balance: isA ? "12.34" : "56.78" });
    });
    let clock = 1000;
    const store = createQuotaStore({
      source: async () => ({
        minIntervalMs: 0,
        providers: [
          {
            id: "openai",
            label: "OpenAI",
            identity: async () => ({ key: "two-synthetic-logins", persist: false }),
            fetch: async () =>
              rowsFromProviderResult(
                "openai",
                await openaiProvider.fetch({ config: {} } as never),
                clock,
              ),
          },
        ],
      }),
      file: null,
      now: () => clock,
    });
    try {
      const first = await store.refresh({ reason: "manual" });
      const balances = (snapshot: QuotaSnapshot) =>
        snapshot.providers[0]!.rows.filter((row) => row.id === "openai.codex_credits")
          .map((row) => [row.account, row.amount?.decimal])
          .sort();
      expect(balances(first)).toEqual([
        ["A (Pro)", "12.34"],
        ["B (Pro)", "56.78"],
      ]);
      const groups = pickedGroups(first, defaultSettings(), "statusLine", clock);
      expect(groups).toHaveLength(4);
      expect(new Set(groups.map((group) => group.id)).size).toBe(4);
      expect(
        groups
          .filter((group) => group.row?.id === "openai.codex_credits")
          .map((group) => group.title),
      ).toEqual(["Codex credits (A (Pro))", "Codex credits (B (Pro))"]);
      expect(
        groups
          .filter((group) => group.row?.id === "openai.codex_credits")
          .map((group) => group.row?.value),
      ).toEqual(["12", "56"]);
      logins[0]!.active = false;
      logins[1]!.active = true;
      clock += 60_000;
      expect(balances(await store.refresh({ reason: "manual" }))).toEqual(balances(first));
      failedLogin = true;
      clock += 60_000;
      const partial = await store.refresh({ reason: "manual" });
      expect(partial.providers[0]!.error).toBeDefined();
      expect(balances(partial)).toEqual(balances(first));
      const partialCredits = pickedGroups(partial, defaultSettings(), "statusLine", clock).filter(
        (group) => group.row?.id === "openai.codex_credits",
      );
      expect(partialCredits).toHaveLength(2);
      for (const group of partialCredits) {
        expect(group.error).toBeDefined();
        expect(pickedText(group, "Unchecked")).toContain(group.row!.value);
        expect(pickedText(group, "Unchecked")).toContain(group.error!);
      }
      expect(http).toHaveBeenCalledTimes(6);
    } finally {
      await store.dispose();
    }
  });

  it("keeps paging, one-item mode and unrelated providers' balances unchanged", async () => {
    const fetched = await providerRows({ balance: "123.45" });
    const snapshot = {
      version: 6,
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          rows: fetched.rows,
          refreshing: false,
          checkedAtMs: 0,
        },
      ],
      resetNotices: [],
      generatedAtMs: 0,
      serverId: "test",
      revision: 1,
    } as QuotaSnapshot;
    const settings = defaultSettings();
    const input = statusLineInput(snapshot, settings, 0);
    const one = lineText(bigStatusLine(input)!);
    expect(one).toContain("OpenAI");
    expect(one).not.toContain("Codex credits");
    for (const level of ["auto", "full", "bar", "reset", "numbers"] as const) {
      const page = statusLayout(input, 20, 0, level);
      expect(page.hiddenAfter).toBe(1);
      const next = statusLayout(input, 60, 1, level);
      expect(next.hiddenAfter).toBe(0);
      expect(next.shown.map(lineText).join(" ")).toContain("Codex credits 123");
    }
    snapshot.providers.push({
      providerId: "openrouter",
      label: "OpenRouter",
      refreshing: false,
      checkedAtMs: 0,
      rows: [
        {
          id: "openrouter.key",
          providerId: "openrouter",
          label: "Key",
          type: "balance",
          method: "remote_api",
          authority: "provider_reported",
          prominence: "primary",
          amount: { decimal: "20", unit: { kind: "currency", code: "USD" } },
        },
      ],
    });
    const mixed = pickedGroups(snapshot, settings, "statusLine", 0);
    expect(mixed).toHaveLength(3);
    expect(mixed.filter((group) => group.providerId === "openrouter")).toHaveLength(1);
    expect(mixed.find((group) => group.providerId === "openrouter")?.row?.value).toBe(
      "$20.00 left",
    );
  });
});
