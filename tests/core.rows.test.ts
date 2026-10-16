import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { accountFromGroup, rowsFromProviderResult } from "../src/core/rows.js";
import type { DebugDetail, QuotaRow } from "../src/core/types.js";
import { computeLocalQuotaProviderEstimate } from "../src/lib/quota-providers-local.js";
import { fetchRemoteQuotaProvider } from "../src/lib/quota-providers-remote.js";
import type {
  JsonV1Mapping,
  LocalEstimateQuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import type { ProviderFetchResult, ProviderRow } from "../src/providers/contract.js";
import { customAccount } from "../src/providers/quota-providers.js";
import { answer, NOT_SET_UP, percentRow, textRow } from "./helpers/fake-answers.js";

const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");
const RESET = "2026-10-11T00:00:00.000Z";

function contractRows(providerId: string, result: ProviderFetchResult) {
  return rowsFromProviderResult(providerId, result, NOW_MS);
}

/** A failed check: one account with these errors, plus the provider's debug details. */
function failedCheck(
  name: string,
  errors: string[],
  debug: DebugDetail[] = [],
): ProviderFetchResult {
  return { ...answer({ name, errors }), debug };
}

/** [id, account, label, window] per row: the parts users' settings and the TUI rely on. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [row.id, row.account ?? null, row.label, row.window ?? null]);
}

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency" as const, code: "USD" } };
}

/** A remote custom definition; its replies are stubbed per test. */
function gateway(
  overrides: Partial<RemoteApiQuotaProviderDefinition> = {},
): RemoteApiQuotaProviderDefinition {
  return {
    id: "my-gateway",
    providerId: "gateway",
    label: "My Gateway",
    url: "https://gateway.example/quota",
    mode: "remote-api",
    format: "quota-v1",
    ...overrides,
  };
}

/** One custom definition's rows and errors, as the custom providers return them. */
function customRows(
  definition: RemoteApiQuotaProviderDefinition | LocalEstimateQuotaProviderDefinition,
  rows: ProviderRow[],
  errors: string[] = [],
  debug: DebugDetail[] = [],
) {
  return contractRows("quota-providers", {
    attempted: true,
    accounts: [customAccount(definition, rows, errors)],
    debug,
  });
}

/** What the remote adapter makes of `body` for `definition`. */
async function remoteRows(
  definition: RemoteApiQuotaProviderDefinition,
  body: unknown,
): Promise<ProviderRow[]> {
  const reply = new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply));
  const result = await fetchRemoteQuotaProvider(definition, "test-key");
  if (!result.success) throw new Error(result.error);
  return result.rows;
}

describe("rowsFromProviderResult", () => {
  it("gives each row its id, provider and its account's account text", () => {
    const result = contractRows(
      "openai",
      answer(
        {
          name: "OpenAI (Pro)",
          rows: [
            percentRow("five_hour", "5h", 50, { window: "five_hour", resetsAt: RESET }),
            percentRow("weekly", "Weekly", 80, {
              window: "week",
              windowStartedAt: "2026-10-04T00:00:00.000Z",
            }),
          ],
        },
        { name: "[OpenAI Work] (Business)", rows: [percentRow("five_hour", "5h", 10)] },
      ),
    );
    expect(result.rows[0]).toEqual({
      id: "openai.five_hour",
      providerId: "openai",
      account: "Pro",
      label: "5h",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "five_hour",
      prominence: "primary",
      percentRemaining: 50,
      resetsAt: RESET,
    });
    expect(result.rows[1]?.windowStartedAt).toBe("2026-10-04T00:00:00.000Z");
    expect(summary(result.rows).slice(2)).toEqual([
      ["openai.five_hour", "Work (Business)", "5h", null],
    ]);
    expect(result).not.toHaveProperty("rowLogins");
    expect(result).not.toHaveProperty("error");
  });

  it("keeps each row's login for the store and drops a row repeated for one login", () => {
    const fiveHour = percentRow("five_hour", "5h", 50, { window: "five_hour" });
    const weekly = percentRow("weekly", "Weekly", 50, { window: "week" });
    const result = contractRows(
      "opencode-go",
      answer(
        { name: "[OpenCode Go] (active)", login: "a", rows: [fiveHour] },
        { name: "[OpenCode Go]", login: "b", rows: [fiveHour, weekly, weekly] },
      ),
    );
    // Both logins have no name; the store numbers them, as it also sees logins that failed.
    expect(summary(result.rows)).toEqual([
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.five_hour", null, "5h", "five_hour"],
      ["opencode-go.weekly", null, "Weekly", "week"],
    ]);
    expect(result.rowLogins).toEqual(["a", "b", "b"]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "opencode-go.weekly: repeated row" },
    ]);
  });

  it("drops rows it can't validate and keeps the rest", () => {
    const result = contractRows(
      "zai",
      answer({
        name: "Z.ai",
        rows: [
          percentRow("five_hour", "5h", 50, { window: "five_hour" }),
          percentRow("weekly", "Weekly", Number.NaN, { window: "week" }),
          percentRow("mcp", "MCP", 50, { resetsAt: "tomorrow" }),
        ],
      }),
    );
    expect(result.rows.map((row) => row.id)).toEqual(["zai.five_hour"]);
    expect(result.debug).toEqual([
      { key: "dropped_row", value: "zai.weekly: invalid percentRemaining" },
      { key: "dropped_row", value: "zai.mcp: invalid resetsAt" },
    ]);
    expect(result.error).toBeUndefined();
  });

  it("classifies the first error and keeps every message for /quota_status", () => {
    const fetched = contractRows("anthropic", {
      ...answer(
        { name: "[Claude Home]", rows: [percentRow("five_hour", "5h", 50)] },
        { name: "[Claude Work]", errors: ["Token expired"] },
        { name: "[Claude Other]", errors: ["HTTP 500"] },
      ),
      debug: [{ key: "auth_source", value: "opencode_db" }],
    });
    expect(fetched.rows.map((row) => row.account)).toEqual(["Home"]);
    expect(fetched.error).toEqual({ code: "login_expired", detail: "Token expired" });
    expect(fetched.debug).toEqual([
      { key: "auth_source", value: "opencode_db" },
      { key: "error", value: "[Claude Work]: Token expired" },
      { key: "error_kind", value: "login_expired" },
      { key: "error", value: "[Claude Other]: HTTP 500" },
      { key: "error_kind", value: "provider_error, http 500" },
    ]);
  });

  it("reads each error's kind from its message, never from the account name before it", () => {
    const fetched = contractRows("openai", {
      ...answer({ name: "[OpenAI Work: 429 Ops]", errors: ["HTTP 503"] }),
      debug: [],
    });
    expect(fetched.debug).toEqual([
      { key: "error", value: "[OpenAI Work: 429 Ops]: HTTP 503" },
      { key: "error_kind", value: "provider_error, http 503" },
    ]);
  });

  it("reports a provider that could not even try as not set up", () => {
    expect(contractRows("deepseek", NOT_SET_UP)).toEqual({
      rows: [],
      error: { code: "not_configured" },
      debug: [],
    });
    expect(contractRows("deepseek", answer())).toEqual({ rows: [], debug: [] });
  });

  it("scrubs control characters from provider text", () => {
    const [row] = contractRows(
      "openrouter",
      answer({
        name: "OpenRouter (Evil\u001b[31m)",
        rows: [textRow("balance", "Evil\u001b[31m Note", "red\u001b[0m text\nnext")],
      }),
    ).rows;
    expect(row?.account).toBe("Evil");
    expect(row?.label).toBe("Evil Note");
    expect(row?.text).toBe("red text next");
  });

  it("redacts credentials a provider echoes in errors and debug details", () => {
    const secrets = [
      "sk-proj-CANARY0secret0value0123",
      "CANARY1bearer0token",
      "Q0FOQVJZMjpiYXNpYw==",
      "CANARY3query0key",
      "CANARY4json0api0key",
      "eyJhbGciOiJIUzI1NiJ9.eyJDQU5BUlk1Ijp0cnVlfQ.c2lnbmF0dXJl",
      "ghp_CANARY6github0token0value",
    ];
    const message = [
      `401 for key ${secrets[0]}`,
      `Authorization: Bearer ${secrets[1]}`,
      `"authorization":"Basic ${secrets[2]}"`,
      `GET https://api.example/v1/quota?key=${secrets[3]}&x=1`,
      `{"api_key":"${secrets[4]}"}`,
      `token ${secrets[5]}`,
      `${secrets[6]}`,
    ].join(" | ");
    const result = contractRows(
      "deepseek",
      failedCheck("DeepSeek", [message], [{ key: "request", value: message }]),
    );
    const text = JSON.stringify(result);
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain("CANARY");
    expect(result.error?.detail).toContain("[redacted]");
  });

  it("redacts whole cookie headers, quoted secrets and values whose key names a secret", () => {
    const message = [
      "HTTP 401 Cookie: session=one; xsrf=CANARYcookie",
      `{"password":"my CANARY quoted pass","user":"bob"}`,
      "client_secret='CANARY single quoted'",
    ].join(" | ");
    const result = contractRows(
      "deepseek",
      failedCheck(
        "DeepSeek",
        [message],
        [
          { key: "session_token", value: "CANARYsplit" },
          { key: "Set-Cookie", value: "a=CANARYheader" },
          { key: "apiKey", value: "CANARYkey" },
          { key: "token_expires_at", value: "2026-11-01T00:00:00.000Z" },
          { key: "api_key_source", value: "env" },
        ],
      ),
    );
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(result.debug.slice(0, 5)).toEqual([
      { key: "session_token", value: "[redacted]" },
      { key: "Set-Cookie", value: "[redacted]" },
      { key: "apiKey", value: "[redacted]" },
      { key: "token_expires_at", value: "2026-11-01T00:00:00.000Z" },
      { key: "api_key_source", value: "env" },
    ]);
  });

  it("hides email addresses and account, team, org, user and session ids in debug details", () => {
    const result = contractRows(
      "xai",
      failedCheck(
        "bob.CANARY@example.com",
        ["HTTP 401"],
        [
          { key: "account_id", value: "acct_CANARY1" },
          { key: "teamId", value: "CANARY2" },
          { key: "session_id", value: "s9" },
          { key: "connection", value: "alice.CANARY@example.co.uk" },
          { key: "request", value: 'org_id=CANARY4 "user_id":"CANARY5" accountId: 7' },
          { key: "account_count", value: "2" },
        ],
      ),
    );
    expect(JSON.stringify(result.debug)).not.toContain("CANARY");
    expect(result.debug).toEqual([
      { key: "account_id", value: "[id]" },
      { key: "teamId", value: "[id]" },
      { key: "session_id", value: "[id]" },
      { key: "connection", value: "[email]" },
      { key: "request", value: 'org_id=[id] "user_id":[id] accountId: [id]' },
      { key: "account_count", value: "2" },
      { key: "error", value: "[email]: HTTP 401" },
      { key: "error_kind", value: "login_expired" },
    ]);
  });

  it.each([
    {
      name: "a home path",
      home: "/Users/alice",
      value: "/Users/alice/.local/bin/claude",
      cutUnhidden: "/Users/ali",
      shown: "~/.local",
      hidden: "ali",
    },
    {
      name: "a JSON-quoted Windows home path",
      home: "C:\\Users\\Alice Smith",
      value: JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude.exe"),
      cutUnhidden: '"C:\\\\Users\\\\Alic',
      shown: '"~\\\\.local',
      hidden: "Alic",
    },
    {
      name: "a Windows home path",
      home: "C:\\Users\\Alice Smith",
      value: "C:\\Users\\Alice Smith\\.local\\bin\\claude.exe",
      cutUnhidden: "C:\\Users\\Alic",
      shown: "~\\.local",
      hidden: "Alic",
    },
    {
      name: "an email address",
      home: "/Users/alice",
      value: "alice.smith@example.com",
      cutUnhidden: "alice.smith@exam",
      shown: "[email]",
      hidden: "smith",
    },
  ])("hides $name before it cuts a long detail", ({ home, value, cutUnhidden, shown, hidden }) => {
    // os.homedir() reads HOME, and USERPROFILE on Windows.
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    // Unhidden, the cut at 300 characters would keep `cutUnhidden`: part of the value.
    const filler = "1234567.".repeat(40).slice(0, 300 - " | ".length - cutUnhidden.length);
    const result = contractRows("anthropic", {
      ...answer(),
      debug: [{ key: "checked_commands", value: `${filler} | ${value}` }],
    });
    const [detail] = result.debug;
    expect(detail?.value.length).toBeLessThanOrEqual(300);
    expect(detail?.value).toContain(`${filler} | ${shown}`);
    expect(detail?.value).not.toContain(hidden);
  });
});

describe("rowsFromProviderResult: the custom providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keys rows custom.<definition id>.<key>, takes the source label as account, maps ADR 0001 values", async () => {
    const definition = gateway({ id: "source-one", label: "Source One" });
    const rows = await remoteRows(definition, {
      version: "quota-v1",
      entries: [
        {
          kind: "percent",
          name: "Monthly",
          resultType: "quota",
          label: "Remaining:",
          right: "108/100",
          percentRemaining: -8,
          resetTimeIso: RESET,
        },
        { kind: "value", name: "Balance", resultType: "balance", value: "$12.00" },
        { kind: "percent", name: "Requests", resultType: "rate_limit", percentRemaining: 40 },
        { kind: "value", name: "Spent", resultType: "spend", value: "$3.00" },
      ],
    });
    const result = customRows(definition, rows);
    expect(summary(result.rows)).toEqual([
      ["quota-providers.custom.source-one.Monthly", "Source One", "Remaining", "month"],
      ["quota-providers.custom.source-one.Balance", "Source One", "Balance", null],
      ["quota-providers.custom.source-one.Requests", "Source One", "Requests", null],
      ["quota-providers.custom.source-one.Spent", "Source One", "Spent", null],
    ]);
    expect(result.rows.map((row) => row.type)).toEqual(["quota", "balance", "quota", "usage"]);
    expect(result.rows[0]).toEqual({
      id: "quota-providers.custom.source-one.Monthly",
      providerId: "quota-providers",
      account: "Source One",
      label: "Remaining",
      type: "quota",
      method: "remote_api",
      authority: "provider_reported",
      window: "month",
      prominence: "primary",
      percentRemaining: -8,
      resetsAt: RESET,
    });
    expect(result.rows[1]?.text).toBe("$12.00");
    expect(result.rowLogins).toEqual(["source-one", "source-one", "source-one", "source-one"]);
    expect(result.debug).toEqual([]);
  });

  it("gives remote rows no amounts: a pair may be remaining/limit or used/limit", async () => {
    const mappings: JsonV1Mapping[] = [
      {
        resultType: "quota",
        name: "Requests left",
        metric: { type: "remaining-limit", remaining: { literal: 30 }, limit: { literal: 100 } },
      },
      {
        resultType: "quota",
        name: "Requests used",
        metric: { type: "used-limit", used: { literal: 70 }, limit: { literal: 100 } },
      },
      {
        resultType: "budget",
        name: "Budget left",
        unit: "$",
        unitPosition: "prefix",
        metric: { type: "remaining-budget", remaining: { literal: 3 }, budget: { literal: 10 } },
      },
    ];
    const definition = gateway({ format: "json-v1", adapter: { mappings } });
    const result = customRows(definition, await remoteRows(definition, {}));
    expect(result.rows.map((row) => [row.id, row.percentRemaining])).toEqual([
      ["quota-providers.custom.my-gateway.Requests_left", 30],
      ["quota-providers.custom.my-gateway.Requests_used", 30],
      ["quota-providers.custom.my-gateway.Budget_left", 30],
    ]);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("used");
      expect(row).not.toHaveProperty("limit");
      expect(row).not.toHaveProperty("remaining");
    }
  });

  it("keys remote mappings apart by name, also names without ASCII letters", async () => {
    const mapping = (name: string, percentage: number): JsonV1Mapping => ({
      resultType: "quota",
      name,
      metric: { type: "percentage", percentage: { literal: percentage }, meaning: "remaining" },
    });
    const fetchRows = async (mappings: JsonV1Mapping[]) => {
      const definition = gateway({ format: "json-v1", adapter: { mappings } });
      return customRows(definition, await remoteRows(definition, {}));
    };
    const result = await fetchRows([
      mapping("Daily limit", 10),
      mapping("Daily-limit", 20),
      mapping("日次上限", 30),
      mapping("月次上限", 40),
    ]);
    const ids = result.rows.map((row) => row.id);
    expect(result.rows.map((row) => row.percentRemaining)).toEqual([10, 20, 30, 40]);
    expect(ids.slice(0, 2)).toEqual([
      "quota-providers.custom.my-gateway.Daily_limit",
      "quota-providers.custom.my-gateway.Daily-limit",
    ]);
    expect(new Set(ids).size).toBe(4);
    expect(result.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    // The same name always gives the same id.
    const again = await fetchRows([mapping("日次上限", 50)]);
    expect(again.rows[0]?.id).toBe(ids[2]);
  });

  function localDefinition(
    windows: LocalEstimateQuotaProviderDefinition["windows"],
  ): LocalEstimateQuotaProviderDefinition {
    return {
      id: "private-gateway",
      providerId: "private-gateway",
      label: "Private Gateway",
      mode: "local-estimate",
      windows,
    };
  }

  function localRows(definition: LocalEstimateQuotaProviderDefinition) {
    const { rows } = computeLocalQuotaProviderEstimate({
      definition,
      state: {
        version: 1,
        definitionId: definition.id,
        providerId: definition.providerId,
        updatedAt: NOW_MS,
        messages: [],
      },
      nowMs: NOW_MS,
    });
    return customRows(definition, rows).rows;
  }

  it("keys local windows by their ids and reads their used requests and dollars", () => {
    const rows = localRows(
      localDefinition([
        { id: "daily", label: "Daily", type: "utc-day", requestLimit: 10, usdBudget: 5 },
        { id: "hourly", label: "Daily", type: "rolling", durationMinutes: 60, requestLimit: 4 },
      ]),
    );
    const requests = (decimal: string) => ({
      decimal,
      unit: { kind: "count", unit: "request" },
    });
    expect(rows.map((row) => [row.id, row.label, row.used, row.limit])).toEqual([
      ["quota-providers.custom.private-gateway.daily", "Daily", requests("0"), requests("10")],
      ["quota-providers.custom.private-gateway.daily_budget", "Daily budget", usd("0"), usd("5")],
      ["quota-providers.custom.private-gateway.hourly", "Daily", requests("0"), requests("4")],
    ]);
    // A UTC day the state was saved in keeps its start for the pace marker.
    expect(rows.map((row) => row.windowStartedAt)).toEqual([
      "2026-10-10T00:00:00.000Z",
      "2026-10-10T00:00:00.000Z",
      undefined,
    ]);

    // Renaming a window keeps its row id, so hide/rename/order settings still apply.
    const renamed = localRows(
      localDefinition([
        { id: "daily", label: "Per day", type: "utc-day", requestLimit: 10, usdBudget: 5 },
      ]),
    );
    expect(renamed.map((row) => row.id)).toEqual([
      "quota-providers.custom.private-gateway.daily",
      "quota-providers.custom.private-gateway.daily_budget",
    ]);
  });

  it("keeps each custom definition's check under its whole name and hides the home folder", () => {
    // os.homedir() reads HOME, and USERPROFILE on Windows.
    vi.stubEnv("HOME", "/Users/alice");
    vi.stubEnv("USERPROFILE", "/Users/alice");
    const result = customRows(
      gateway({ id: "production-gateway-us", label: "Team" }),
      [],
      ["HTTP 503"],
      [
        {
          key: "custom_production-gateway-us_check",
          value:
            "outcome=http_error http_status=503 credential_source=explicit_env checked_paths=/Users/alice/.config/opencode/opencode.json | /Users/alice/.local/share/opencode/opencode.db",
        },
      ],
    );
    expect(result.debug).toEqual([
      {
        key: "custom_production-gateway-us_check",
        value:
          "outcome=http_error http_status=503 credential_source=explicit_env checked_paths=~/.config/opencode/opencode.json | ~/.local/share/opencode/opencode.db",
      },
      { key: "error", value: "Team: HTTP 503" },
      { key: "error_kind", value: "provider_error, http 503" },
    ]);
  });

  it("scrubs control characters from custom text", () => {
    const [row] = customRows(gateway({ id: "src", label: "Evil\u001b[31m" }), [
      {
        key: "Note",
        label: "Note",
        type: "usage",
        method: "remote_api",
        authority: "provider_reported",
        prominence: "primary",
        text: "red\u001b[0m text\nnext",
      },
    ]).rows;
    expect(row?.account).toBe("Evil");
    expect(row?.text).toBe("red text next");
  });
});

describe("accountFromGroup", () => {
  it.each([
    ["openai", "OpenAI", undefined],
    ["openai", "OpenAI (Business)", "Business"],
    ["openai", "[OpenAI] (active)", undefined],
    ["openai", "[OpenAI Work 2] (Business)", "Work 2 (Business)"],
    ["anthropic", "[Claude Work] (active)", "Work"],
    ["copilot", "Copilot (personal)", "personal"],
    ["google-agy", "AGY (Account 2)", "Account 2"],
    ["kimi-code-plan-cn", "[Kimi Code (CN) Work]", "Work"],
    ["xiaomi", "Xiaomi MiMo: standard_monthly", "standard_monthly"],
    ["quota-providers", "Team Gateway (active)", "Team Gateway"],
    ["deepseek", undefined, undefined],
  ] as const)("%s %s → %s", (providerId, group, account) => {
    expect(accountFromGroup(providerId, group)).toBe(account);
  });
});
