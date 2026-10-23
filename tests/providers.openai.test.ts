import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import type { QuotaRow } from "../src/core/types.js";
import { type CredentialRow, readCredentialRows } from "../src/lib/opencode-auth.js";
import { quotaReportLines } from "../src/lib/quota-dialog-commands.js";
import type { ProviderFetchResult } from "../src/providers/contract.js";
import { openaiProvider } from "../src/providers/openai.js";
import { fakeHttp, requestHeader } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

const readRows = vi.mocked(readCredentialRows);
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const DAY_SECONDS = 86_400;

function oauthRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id,
    integrationId: "openai",
    label: "default",
    active: false,
    value: { type: "oauth", access: "token" },
    ...overrides,
  };
}

function keyRow(id: string, overrides: Partial<CredentialRow> = {}): CredentialRow {
  return oauthRow(id, { value: { type: "api", key: "sk-test" }, ...overrides });
}

/** ChatGPT's usage reply: a 5h window with 42% left that resets at 03:00, on `plan`. */
function hourlyReply(plan = "pro") {
  return {
    plan_type: plan,
    rate_limit: {
      primary_window: { used_percent: 58, limit_window_seconds: 18_000, reset_at: 1_767_236_400 },
    },
  };
}

/** Each ChatGPT usage request's bearer token, answered with `reply`. */
function chatgptHttp(reply: unknown = hourlyReply()) {
  const http = fakeHttp(() => reply);
  return {
    http,
    tokens: () => http.mock.calls.map(([, init]) => requestHeader(init, "Authorization")),
  };
}

async function fetchRows(rows: CredentialRow[], config: Record<string, unknown> = {}) {
  readRows.mockResolvedValueOnce(rows);
  return rowsFromProviderResult("openai", await openaiProvider.fetch({ config } as never), NOW_MS);
}

/** id, account, label and the row's value. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [
    row.id,
    row.account ?? null,
    row.label,
    row.percentRemaining ?? row.text,
  ]);
}

const STATUS_ROW = {
  id: "openai.status",
  providerId: "openai",
  label: "Status",
  type: "status",
  method: "local_estimation",
  authority: "locally_derived",
  prominence: "primary",
};

/** The quota lines `opencode-quota show` prints for these rows. */
function quotaCommandText(rows: QuotaRow[]): string {
  const provider = { providerId: "openai", label: "OpenAI", rows, refreshing: false, debug: [] };
  const snapshot = {
    version: 6 as const,
    providers: [provider],
    resetNotices: [],
    generatedAtMs: 0,
  };
  return quotaReportLines(snapshot as never, 0).join("\n");
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
  readRows.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("openai provider", () => {
  it("keeps the 5h window's start for the pace marker", async () => {
    chatgptHttp();
    readRows.mockResolvedValueOnce([oauthRow("work-id", { label: "Work" })]);

    const result = (await openaiProvider.fetch({ config: {} } as never)) as ProviderFetchResult;

    expect(rowsFromProviderResult("openai", result, NOW_MS).rows[0]?.windowStartedAt).toBe(
      "2025-12-31T22:00:00.000Z",
    );
  });

  it("is not set up without a stored login", async () => {
    const { http } = chatgptHttp();
    const fetched = await fetchRows([]);

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toEqual({ code: "not_configured" });
    expect(http).not.toHaveBeenCalled();
    expect(fetched.debug).toEqual([
      { key: "auth_configured", value: "false" },
      { key: "auth_source", value: "(none)" },
      { key: "auth_method", value: "(none)" },
      { key: "token_status", value: "(none)" },
      { key: "token_expires_at", value: "(none)" },
    ]);
  });

  it("passes the request timeout to the usage request", async () => {
    fakeHttp(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );

    const fetched = await fetchRows([oauthRow("work-id", { active: true })], {
      requestTimeoutMs: 20,
    });

    expect(fetched.error).toMatchObject({ code: "timeout" });
  });

  it("queries and names every stored login independently", async () => {
    const { tokens } = chatgptHttp({
      plan_type: "business",
      rate_limit: {
        primary_window: { used_percent: 58, limit_window_seconds: 18_000, reset_at: 1_767_236_400 },
        secondary_window: {
          used_percent: 20,
          limit_window_seconds: 7 * DAY_SECONDS,
          reset_after_seconds: 6 * DAY_SECONDS,
        },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: 45, reset_after_seconds: DAY_SECONDS },
      },
      spend_control: {
        individual_limit: { remaining_percent: 67, reset_after_seconds: 31 * DAY_SECONDS },
      },
    });

    const fetched = await fetchRows([
      oauthRow("active-id", {
        label: "Work",
        active: true,
        value: { type: "oauth", access: "a" },
      }),
      oauthRow("other-id", { label: "Work", value: { type: "oauth", access: "o" } }),
    ]);

    expect(tokens()).toEqual(["Bearer a", "Bearer o"]);
    expect(fetched.error).toBeUndefined();
    expect(
      fetched.rows.map((row) => [row.id, row.account, row.label, row.window, row.resetsAt]),
    ).toEqual(
      ["Work (Business)", "Work 2 (Business)"].flatMap((account) => [
        ["openai.five_hour", account, "5h", "five_hour", "2026-01-01T03:00:00.000Z"],
        ["openai.weekly", account, "Weekly", "week", "2026-01-07T00:00:00.000Z"],
        ["openai.monthly", account, "Monthly", "month", "2026-02-01T00:00:00.000Z"],
        ["openai.code_review", account, "Code review", "code_review", "2026-01-02T00:00:00.000Z"],
      ]),
    );
    expect(fetched.rows.every((row) => row.type === "quota" && row.method === "remote_api")).toBe(
      true,
    );
    expect(fetched.rowLogins).toEqual([
      ...Array(4).fill("active-id"),
      ...Array(4).fill("other-id"),
    ]);
  });

  it("shows a login OpenCode could not return as its own error next to working ones", async () => {
    const { tokens } = chatgptHttp();

    const fetched = await fetchRows([
      oauthRow("work-id", {
        label: "Work",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      }),
      oauthRow("home-id", { label: "Home", value: { type: "oauth", access: "home-token" } }),
    ]);

    expect(readRows).toHaveBeenLastCalledWith(["openai", "codex", "chatgpt"], {
      methods: ["oauth", "key"],
    });
    expect(tokens()).toEqual(["Bearer home-token"]);
    expect(summary(fetched.rows)).toEqual([["openai.five_hour", "Home (Pro)", "5h", 42]]);
    expect(fetched.rowLogins).toEqual(["home-id"]);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "failed" },
        {
          key: "error",
          value:
            "[OpenAI Work] (active): OpenAI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth logout openai Work`, then `opencode auth login openai`.",
        },
      ]),
    );
  });

  it.each([
    {
      name: "a stored API key",
      row: keyRow("key-id", { label: "Key", active: true }),
      rows: [{ ...STATUS_ROW, account: "Key", text: "ChatGPT quota unavailable for API key" }],
      debug: [
        { key: "token_status", value: "api key" },
        { key: "token_expires_at", value: "(none)" },
      ],
    },
    {
      name: "a Sign in with ChatGPT login (#316)",
      row: oauthRow("sharing-id", {
        label: "OpenAI",
        active: true,
        value: { type: "oauth", methodID: "chatgpt-token-sharing", access: "a.b.c" },
      }),
      rows: [{ ...STATUS_ROW, text: "ChatGPT quota unavailable for Sign in with ChatGPT" }],
      debug: [
        { key: "auth_method", value: "chatgpt-token-sharing" },
        { key: "token_status", value: "valid" },
      ],
    },
    {
      name: "an API key OpenCode could not read",
      row: keyRow("key-id", {
        label: "Key",
        active: true,
        value: { type: "api" },
        resolveError: "refresh_failed: HTTP 400",
      }),
      rows: [],
      debug: [
        { key: "token_status", value: "failed" },
        {
          key: "error",
          value: "[OpenAI Key]: OpenAI API key could not be read: refresh_failed: HTTP 400",
        },
      ],
    },
  ])("reports $name without querying ChatGPT", async ({ row, rows, debug }) => {
    const { http } = chatgptHttp();
    const fetched = await fetchRows([row]);

    expect(http).not.toHaveBeenCalled();
    expect(fetched.rows).toEqual(rows);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        ...debug,
      ]),
    );
  });

  it("shows a stored API key's status on /quota", async () => {
    const fetched = await fetchRows([keyRow("key-id", { label: "Key", active: true })]);

    // Narrow dialogs wrap the sentence; collapsing whitespace keeps the phrase checkable.
    const collapsed = quotaCommandText(fetched.rows).replace(/\s+/gu, " ");
    expect(collapsed).toContain("OpenAI (Key)");
    expect(collapsed).toContain("ChatGPT quota unavailable for API key");
  });

  it.each([
    // Unknown session: the OAuth login with quota numbers goes first.
    { rows: "key, oauth", config: {}, logins: ["oauth-id", "key-id"], source: "codex" },
    { rows: "oauth, key", config: {}, logins: ["oauth-id", "key-id"], source: "codex" },
    {
      rows: "key, oauth",
      config: { currentModel: "codex/gpt-5-codex" },
      logins: ["oauth-id", "key-id"],
      source: "codex",
    },
    {
      rows: "key, oauth",
      config: { currentProviderID: "openai", currentModel: "codex/gpt-5-codex" },
      logins: ["key-id", "oauth-id"],
      source: "openai",
    },
  ])(
    "lists the session's active login first ($rows, $config)",
    async ({ rows, config, logins, source }) => {
      const { http } = chatgptHttp();
      const key = keyRow("key-id", { label: "API key", active: true });
      const oauth = oauthRow("oauth-id", { integrationId: "codex", label: "Work", active: true });

      const fetched = await fetchRows(rows === "key, oauth" ? [key, oauth] : [oauth, key], config);

      expect(fetched.rowLogins).toEqual(logins);
      expect(http).toHaveBeenCalledOnce();
      expect(fetched.debug).toContainEqual({ key: "auth_source", value: source });
    },
  );

  it("keeps other active logins and inactive ones in source order after the session's", async () => {
    const fetched = await fetchRows(
      [
        { id: "inactive-openai", integrationId: "openai", active: false },
        { id: "active-openai", integrationId: "openai", active: true },
        { id: "inactive-codex", integrationId: "codex", active: false },
        { id: "active-chatgpt", integrationId: "chatgpt", active: true },
        { id: "active-codex", integrationId: "codex", active: true },
      ].map((row) => keyRow(row.id, { ...row, label: row.id })),
      { currentProviderID: "codex" },
    );

    expect(fetched.rowLogins).toEqual([
      "active-codex",
      "active-openai",
      "active-chatgpt",
      "inactive-openai",
      "inactive-codex",
    ]);
  });

  it.each([
    { labels: ["API key", "default", "OpenAI"], accounts: [null, "2", "3"] },
    { labels: ["", "API key"], accounts: [null, "2"], noneActive: true },
    // An explicit numeric alias stays apart from the numbered unnamed accounts.
    { labels: ["API key", "default", "2"], accounts: [null, "3", "2"] },
  ])("numbers unnamed API keys apart ($labels)", async ({ labels, accounts, noneActive }) => {
    const fetched = await fetchRows(
      labels.map((label, index) =>
        keyRow(`key-${index}`, { label, active: !noneActive && index === 0 }),
      ),
    );

    expect(fetched.rows.map((row) => row.account ?? null)).toEqual(accounts);
    expect(fetched.rowLogins).toEqual(labels.map((_, index) => `key-${index}`));
    // One line per account, each named differently ("OpenAI", "OpenAI (2)", …).
    const lines = quotaCommandText(fetched.rows).split("\n");
    expect(lines).toHaveLength(labels.length);
    expect(new Set(lines.map((line) => line.split(" Status")[0]!.trim())).size).toBe(labels.length);
    for (const line of lines) expect(line).toContain("ChatGPT quota unavailable for API key");
  });

  it("reports unknown active auth when no stored login is marked active", async () => {
    chatgptHttp();
    const fetched = await fetchRows([
      keyRow("key-id", { label: "Key" }),
      oauthRow("oauth-id", { label: "Work" }),
    ]);

    expect(fetched.debug.slice(0, 5)).toEqual([
      { key: "auth_configured", value: "true" },
      { key: "auth_source", value: "unknown" },
      { key: "auth_method", value: "unknown" },
      { key: "token_status", value: "unknown" },
      { key: "token_expires_at", value: "unknown" },
    ]);
  });

  it.each([
    { providerIds: ["openai"], expected: true },
    { providerIds: ["chatgpt"], expected: true },
    { providerIds: ["codex"], expected: true },
    { providerIds: ["opencode"], expected: false },
    // Without an OpenAI provider id, a stored OAuth login or API key still counts.
    { providerIds: ["zai"], logins: [oauthRow("oauth-id")], expected: true },
    { providerIds: ["zai"], logins: [keyRow("key-id")], expected: true },
    {
      providerIds: ["zai"],
      logins: [oauthRow("no-token", { value: { type: "oauth" } })],
      expected: false,
    },
    // Provider lookup failure falls back to available.
    { providersError: new Error("boom"), expected: true },
  ])(
    "isAvailable is $expected for $providerIds ($logins.length logins)",
    async ({ providerIds, providersError, logins, expected }) => {
      readRows.mockResolvedValue(logins ?? []);

      await expect(
        openaiProvider.isAvailable(
          createProviderAvailabilityContext({ providerIds, providersError }),
        ),
      ).resolves.toBe(expected);
    },
  );
});
