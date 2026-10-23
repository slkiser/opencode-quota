import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// --------------- mock modules ---------------

vi.mock("../src/lib/atomic-json.js", () => ({
  writeJsonAtomic: vi.fn(),
}));

// --------------- imports ---------------

import { rowsFromProviderResult } from "../src/core/rows.js";
import type { ProviderFetch } from "../src/core/store.js";
import type { ProviderSnapshot, QuotaRow } from "../src/core/types.js";
import { writeJsonAtomic } from "../src/lib/atomic-json.js";
import type { QuotaExport } from "../src/lib/quota-export-types.js";
import {
  buildQuotaExportFromSnapshot,
  exportProviderFromCheck,
  resolveExportPath,
  writeQuotaExport,
} from "../src/lib/quota-export.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../src/lib/quota-providers.js";
import type { AccountResult, ProviderFetchResult } from "../src/providers/contract.js";
import { customAccount } from "../src/providers/quota-providers.js";
import { percentRow, providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

const folders = useOpencodeFolders();
const testPaths = {
  defaultExport: join(folders.cacheDir, "quota-export.json"),
  explicitExport: join(folders.root, "export.json"),
};

// --------------- helpers ---------------

type Check = {
  fetched: ProviderFetch;
  checkedAtMs: number;
  label?: string;
  accounts?: AccountResult[];
};

/** The export document after each provider's last check; `undefined`: never checked. */
function exportAfter(
  checks: Record<string, Check | undefined>,
  customDefinitions: QuotaProviderDefinition[] = [],
): QuotaExport {
  const providers = Object.entries(checks).map(([providerId, check]) => {
    const label = check?.label ?? providerId;
    if (!check) return providerSnapshot(providerId, label, []);
    const exportPart = exportProviderFromCheck({
      providerId,
      label,
      rows: check.fetched.rows,
      ...(check.fetched.error ? { error: check.fetched.error } : {}),
      checkedAtMs: check.checkedAtMs,
      customDefinitions,
      accounts: check.accounts ?? [],
    });
    return providerSnapshot(providerId, label, [], { exportPart });
  });
  const generatedAtMs = Date.now();
  return buildQuotaExportFromSnapshot(
    { version: 6, providers, resetNotices: [], generatedAtMs, serverId: "test", revision: 1 },
    generatedAtMs,
  );
}

/** The custom providers' check: their rows and each definition's account. */
function customCheck(result: ProviderFetchResult, checkedAtMs: number): Check {
  return {
    fetched: rowsFromProviderResult("quota-providers", result, checkedAtMs),
    checkedAtMs,
    label: "Custom providers",
    accounts: result.accounts,
  };
}

/** A remote custom quota row, keyed by its name like the adapters key it. */
const customQuota = (key: string, percentRemaining: number) =>
  percentRow(key, key, percentRemaining);

/** A remote, provider-reported quota row of `providerId`. */
const row = (providerId: string, key: string, label: string, fields: Partial<QuotaRow> = {}) =>
  quotaRow(`${providerId}.${key}`, { label, ...fields });

/** A remote custom definition in the quota-v1 format. */
function definition(
  id: string,
  providerId: string,
  label: string,
  extra: Partial<RemoteApiQuotaProviderDefinition> = {},
): QuotaProviderDefinition {
  return {
    id,
    providerId,
    label,
    mode: "remote-api",
    url: `https://${id}.example/accounting`,
    format: "quota-v1",
    ...extra,
  } as QuotaProviderDefinition;
}

function usd(decimal: string) {
  return { decimal, unit: { kind: "currency" as const, code: "USD" } };
}

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const REMOTE = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

// --------------- describe blocks ---------------

describe("resolveExportPath", () => {
  it.each([
    ["", testPaths.defaultExport],
    ["~/my-exports/quota.json", join(homedir(), "my-exports/quota.json")],
    ["/etc/opencode/export.json", "/etc/opencode/export.json"],
    ["relative/path/quota.json", "relative/path/quota.json"],
    // Windows-style home-relative paths expand on every platform.
    ["~\\exports\\quota.json", join(homedir(), "exports", "quota.json")],
    ["~\\exports\\\\nested\\quota.json", join(homedir(), "exports", "nested", "quota.json")],
    ["~\\", homedir()],
    // Other tildes and ordinary backslash paths stay as they are.
    ["~", "~"],
    ["~user/exports", "~user/exports"],
    ["relative\\path.json", "relative\\path.json"],
    ["C:\\exports\\quota.json", "C:\\exports\\quota.json"],
    ["\\\\server\\share\\quota.json", "\\\\server\\share\\quota.json"],
    ["~/literal\\name.json", join(homedir(), "literal\\name.json")],
  ])("resolves %j to %j", (input, expected) => {
    expect(resolveExportPath(input)).toBe(expected);
  });
});

describe("the export of each provider's last check", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns status ok and writes each row as an entry", () => {
    const checkedAtMs = Date.parse("2026-06-01T11:00:00.000Z");
    const exportData = exportAfter({
      copilot: {
        label: "Copilot",
        checkedAtMs,
        fetched: {
          rows: [
            row("copilot", "allowance", "Premium requests", {
              account: "pro",
              window: "month",
              percentRemaining: 75,
              resetsAt: "2026-07-01T00:00:00.000Z",
              windowStartedAt: "2026-06-01T00:00:00.000Z",
              used: { decimal: "75", unit: { kind: "count", unit: "request" } },
            }),
            row("copilot", "additional_budget", "Budget", {
              type: "budget",
              authority: "locally_derived",
              prominence: "supplementary",
              used: usd("2.5"),
              limit: usd("10"),
            }),
          ],
          debug: [],
        },
      },
    });

    expect(exportData.version).toBe(3);
    expect(exportData.fromCache).toBe(true);
    expect(exportData.exportedAt).toBe(Math.floor(Date.now() / 1000));
    expect(exportData.cacheAgeSeconds).toBe(3600);
    expect(exportData.providers.copilot).toEqual({
      status: "ok",
      fetchedAt: unix("2026-06-01T11:00:00.000Z"),
      entries: [
        {
          id: "copilot.allowance",
          name: "Copilot (pro) Premium requests",
          account: "pro",
          ...REMOTE,
          window: "Monthly",
          resetAt: unix("2026-07-01T00:00:00.000Z"),
          renderType: "percent",
          percentRemaining: 75,
        },
        {
          id: "copilot.additional_budget",
          name: "Copilot Budget",
          ...REMOTE,
          resultType: "budget",
          authority: "locally_derived",
          renderType: "value",
          value: "$2.50/$10.00",
        },
      ],
    });
  });

  it("writes amounts, flags and texts with the words the TUI shows", () => {
    const exportData = exportAfter({
      opencode: {
        label: "OpenCode Zen",
        checkedAtMs: Date.now(),
        fetched: {
          rows: [
            row("opencode", "balance", "Balance", { type: "balance", amount: usd("42.5") }),
            row("opencode", "auto_reload", "Auto reload", { type: "status", flag: true }),
            row("opencode", "spent", "Spent", {
              type: "usage",
              method: "local_estimation",
              authority: "locally_derived",
              amount: usd("1.25"),
            }),
            row("opencode", "status", "Status", { type: "status", text: "Unavailable for key" }),
            row("opencode", "tokens", "Tokens", {
              type: "usage",
              amount: { decimal: "12345", unit: { kind: "count", unit: "token" } },
            }),
            row("opencode", "requests", "Requests", {
              type: "usage",
              amount: { decimal: "1", unit: { kind: "count", unit: "request" } },
            }),
          ],
          debug: [],
        },
      },
    });

    const provider = exportData.providers.opencode;
    expect(provider?.status === "ok" ? provider.entries : []).toEqual([
      expect.objectContaining({ resultType: "balance", renderType: "value", value: "$42.50 left" }),
      expect.objectContaining({ resultType: "status", value: "Enabled" }),
      expect.objectContaining({
        name: "OpenCode Zen Spent",
        resultType: "usage",
        acquisitionMethod: "local_estimation",
        authority: "locally_derived",
        value: "$1.25 used",
      }),
      expect.objectContaining({ name: "OpenCode Zen Status", value: "Unavailable for key" }),
      expect.objectContaining({ name: "OpenCode Zen Tokens", value: "12,345 tokens used" }),
      expect.objectContaining({ name: "OpenCode Zen Requests", value: "1 request used" }),
    ]);
  });

  it("keeps debug details out of the export: they stay in /quota_status", () => {
    const secretCanary = "sk-or-export-secret-canary";
    const exportData = exportAfter({
      openrouter: {
        label: "OpenRouter",
        checkedAtMs: Date.now(),
        fetched: {
          rows: [row("openrouter", "key", "Budget", { type: "budget", percentRemaining: 80 })],
          error: { code: "provider_error", status: 503, detail: secretCanary },
          debug: [
            { key: "api_key_source", value: "env" },
            { key: "api_key_checked_paths", value: "env:OPENROUTER_API_KEY" },
            { key: "error", value: `OpenRouter: ${secretCanary}` },
          ],
        },
      },
    });

    expect(exportData.providers.openrouter).toEqual({
      status: "partial",
      fetchedAt: Math.floor(Date.now() / 1000),
      entries: [expect.objectContaining({ name: "OpenRouter Budget", percentRemaining: 80 })],
      errors: [{ label: "OpenRouter", message: "Provider error 503" }],
    });
    const serialized = JSON.stringify(exportData);
    expect(serialized).not.toContain("api_key_");
    expect(serialized).not.toContain(secretCanary);
  });

  it("returns status error with the error's words when the check gave no rows", () => {
    const checkedAtMs = Date.parse("2026-06-01T11:00:00.000Z");
    const exportData = exportAfter({
      broken: {
        label: "Broken\u001b[31m",
        checkedAtMs,
        fetched: { rows: [], error: { code: "network", detail: "ECONNRESET" }, debug: [] },
      },
      limited: {
        checkedAtMs,
        fetched: {
          rows: [],
          error: { code: "rate_limited", retryAtMs: checkedAtMs + 120_000 },
          debug: [],
        },
      },
    });

    expect(exportData.providers.broken).toEqual({
      status: "error",
      fetchedAt: unix("2026-06-01T11:00:00.000Z"),
      error: "Can't reach Broken",
    });
    // The wait counts from the check, as the file shows that check.
    expect(exportData.providers.limited).toMatchObject({
      status: "error",
      error: "Rate limited, retry in 2m",
    });
  });

  it("returns status unavailable for a provider that is not set up or never checked", () => {
    const exportData = exportAfter({
      deepseek: {
        checkedAtMs: Date.now(),
        fetched: { rows: [], error: { code: "not_configured" }, debug: [] },
      },
      ghost: undefined,
    });

    expect(exportData.providers.deepseek).toEqual({ status: "unavailable" });
    expect(exportData.providers.ghost).toEqual({ status: "unavailable" });
    expect(exportData.cacheAgeSeconds).toBe(0);
  });

  it("omits an invalid reset time instead of exporting NaN", () => {
    const exportData = exportAfter({
      fixture: {
        checkedAtMs: Date.now(),
        fetched: {
          rows: [
            row("fixture", "weekly", "Weekly", { percentRemaining: 50, resetsAt: "not-a-date" }),
          ],
          debug: [],
        },
      },
    });

    expect(exportData.providers.fixture).toMatchObject({
      status: "ok",
      entries: [{ name: "fixture Weekly", renderType: "percent", percentRemaining: 50 }],
    });
    expect(JSON.stringify(exportData)).not.toContain("resetAt");
  });

  it("matches the all-result-types JSON golden", () => {
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    const provider = (key: string, label: string, fields: Partial<QuotaRow>) =>
      row("fixture", key, label, fields);
    const actual = exportAfter({
      fixture: {
        label: "Fixture",
        checkedAtMs: Date.parse("2026-07-10T23:59:00.000Z"),
        fetched: {
          rows: [
            provider("quota", "Quota", {
              window: "month",
              percentRemaining: 75,
              resetsAt: "2026-08-01T00:00:00.000Z",
              remaining: { decimal: "7500", unit: { kind: "count", unit: "token" } },
            }),
            provider("rpm", "Requests", {
              window: "rpm",
              percentRemaining: 50,
              resetsAt: "2026-07-11T00:01:00.000Z",
            }),
            provider("budget", "Budget", {
              type: "budget",
              window: "week",
              percentRemaining: 60,
              limit: usd("100"),
            }),
            provider("usage", "Usage", {
              type: "usage",
              method: "local_estimation",
              authority: "locally_derived",
              amount: { decimal: "12345", unit: { kind: "count", unit: "token" } },
            }),
            provider("spend", "Spend", {
              type: "usage",
              method: "dashboard_scrape",
              amount: usd("42.5"),
            }),
            provider("balance", "Balance", {
              type: "balance",
              method: "local_cli",
              prominence: "supplementary",
              amount: usd("10"),
            }),
            provider("auto_reload", "Auto-reload", { type: "status", flag: true }),
          ],
          debug: [{ key: "plan", value: "max" }],
        },
      },
    });
    const golden = JSON.parse(
      readFileSync(
        new URL("./fixtures/quota-export-all-result-types.json", import.meta.url),
        "utf8",
      ),
    );

    expect(actual).toEqual(golden);
    const entries =
      actual.providers.fixture?.status === "ok" ? actual.providers.fixture.entries : [];
    expect(new Set(entries.map((entry) => entry.resultType))).toEqual(
      new Set(["quota", "budget", "usage", "balance", "status"]),
    );
    expect(new Set(entries.map((entry) => entry.acquisitionMethod))).toEqual(
      new Set(["remote_api", "dashboard_scrape", "local_cli", "local_estimation"]),
    );
    const allowedKeys = new Set([
      "id",
      "name",
      "account",
      "resultType",
      "acquisitionMethod",
      "ownership",
      "authority",
      "window",
      "resetAt",
      "renderType",
      "percentRemaining",
      "value",
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).filter((key) => !allowedKeys.has(key))).toEqual([]);
    }
  });

  it("lists each custom definition with a coarse status, never its URL, key, format or files", () => {
    const definitions = [
      definition("same-label-one", "gateway-one", "Same label", {
        url: "https://secret-one.example/accounting",
        format: "json-v1",
        adapter: {
          mappings: [
            {
              resultType: "status",
              name: "Private status",
              metric: { type: "status", value: { literal: "private-adapter-literal" } },
            },
          ],
        },
        apiKeyEnv: "GATEWAY_ONE_KEY",
      }),
      definition("same-label-two", "gateway-two", "Same label"),
      definition("not-selected", "gateway-three", "Not selected"),
    ];
    const [one, two] = definitions as [QuotaProviderDefinition, QuotaProviderDefinition];
    const check = customCheck(
      {
        attempted: true,
        accounts: [
          customAccount(one, [customQuota("Remaining", 25)], []),
          customAccount(two, [], [{ message: "secondary source unavailable" }]),
        ],
        debug: [
          {
            key: "custom_same-label-one_check",
            value:
              "outcome=success credential_source=explicit_env checked_paths=env:GATEWAY_ONE_KEY | /trusted/opencode.db",
          },
          {
            key: "custom_same-label-two_check",
            value:
              "outcome=invalid_json credential_source=opencode_db checked_paths=/trusted/opencode.json | /trusted/opencode.db",
          },
        ],
      },
      Date.now(),
    );

    const actual = exportAfter({ "quota-providers": check }, definitions);

    expect(actual.version).toBe(3);
    expect(actual.providers["quota-providers"]).toMatchObject({
      status: "partial",
      entries: [
        {
          // The id names the definition the row came from.
          id: "quota-providers.custom.same-label-one.Remaining",
          name: "Custom providers (Same label) Remaining",
          ownership: "user_configured",
          percentRemaining: 25,
        },
      ],
      errors: [{ label: "Custom providers", message: "Nothing reported" }],
      sources: [
        { id: "same-label-one", providerId: "gateway-one", status: "ok", entryCount: 1 },
        { id: "same-label-two", providerId: "gateway-two", status: "error", entryCount: 0 },
        {
          id: "not-selected",
          providerId: "gateway-three",
          status: "unavailable",
          entryCount: 0,
        },
      ],
    });
    const customProvider = actual.providers["quota-providers"];
    expect(customProvider.sources?.map((source) => Object.keys(source))).toEqual([
      ["id", "providerId", "status", "entryCount"],
      ["id", "providerId", "status", "entryCount"],
      ["id", "providerId", "status", "entryCount"],
    ]);
    const json = JSON.stringify(actual);
    expect(json).not.toContain("invalid_json");
    expect(json).not.toContain("private raw failure");
    expect(json).not.toContain("secret-one.example");
    expect(json).not.toContain("GATEWAY_ONE_KEY");
    expect(json).not.toContain("private-adapter-literal");
    expect(json).not.toContain("json-v1");
    expect(json).not.toContain("/trusted/opencode.db");
  });

  it("lists every custom definition as unavailable when the custom providers could not be asked", () => {
    const definitions = [
      definition("first", "gateway-one", "First"),
      definition("second", "gateway-two", "Second"),
    ];
    const check = customCheck({ attempted: false, accounts: [], debug: [] }, Date.now());

    const actual = exportAfter({ "quota-providers": check }, definitions);

    expect(actual.providers["quota-providers"]).toEqual({
      status: "unavailable",
      sources: [
        { id: "first", providerId: "gateway-one", status: "unavailable", entryCount: 0 },
        { id: "second", providerId: "gateway-two", status: "unavailable", entryCount: 0 },
      ],
    });
  });

  it("says a switched-off definition is off instead of giving it a status", () => {
    const first = definition("first", "gateway-one", "First");
    const second = definition("second", "gateway-one", "Second");
    // A result from before the user switched "second" off.
    const check = customCheck(
      {
        attempted: true,
        accounts: [
          customAccount(first, [], [{ message: "Failed to read accounting data" }]),
          customAccount(second, [customQuota("Monthly", 50)], []),
        ],
        debug: [],
      },
      Date.now(),
    );

    const actual = exportAfter({ "quota-providers": check }, [
      first,
      { ...second, enabled: false },
    ]);

    expect(actual.providers["quota-providers"].sources).toStrictEqual([
      { id: "first", providerId: "gateway-one", status: "error", entryCount: 0 },
      { id: "second", providerId: "gateway-one", entryCount: 0, enabled: false },
    ]);
  });

  it("computes cacheAgeSeconds from the oldest fetchedAt across ok and error providers", () => {
    const exportData = exportAfter({
      a: {
        checkedAtMs: Date.parse("2026-06-01T10:00:00.000Z"), // 2h old
        fetched: { rows: [row("a", "daily", "Daily", { percentRemaining: 90 })], debug: [] },
      },
      b: {
        checkedAtMs: Date.parse("2026-06-01T11:30:00.000Z"), // 30m old
        fetched: { rows: [], error: { code: "internal" }, debug: [] },
      },
    });

    // Oldest is "a" at 10:00, now is 12:00 → 2h = 7200s
    expect(exportData.cacheAgeSeconds).toBe(7200);
  });
});

describe("the export of a provider without a check in this server", () => {
  const NOW_MS = Date.parse("2026-06-01T12:00:00.000Z");

  function snapshotExport(provider: Partial<ProviderSnapshot>) {
    const snapshotProvider = providerSnapshot("copilot", "Copilot", [], {
      debug: [{ key: "api_key_source", value: "env" }],
      ...provider,
    });
    return buildQuotaExportFromSnapshot(
      {
        version: 6,
        providers: [snapshotProvider],
        resetNotices: [],
        generatedAtMs: NOW_MS,
        serverId: "test",
        revision: 1,
      },
      NOW_MS,
    ).providers.copilot;
  }

  it("writes the snapshot's rows, dated when they came", () => {
    expect(
      snapshotExport({
        rows: [row("copilot", "allowance", "Premium requests", { percentRemaining: 40 })],
        okAtMs: NOW_MS - 60_000,
        checkedAtMs: NOW_MS - 1_000,
      }),
    ).toEqual({
      status: "ok",
      fetchedAt: Math.floor((NOW_MS - 60_000) / 1000),
      entries: [
        expect.objectContaining({ name: "Copilot Premium requests", percentRemaining: 40 }),
      ],
    });
  });

  it("writes kept rows with the last error as partial, and only an error without rows", () => {
    const allowance = row("copilot", "allowance", "Premium requests", { percentRemaining: 40 });
    expect(
      snapshotExport({
        rows: [allowance],
        okAtMs: NOW_MS - 60_000,
        checkedAtMs: NOW_MS - 1_000,
        error: { code: "login_expired" },
      }),
    ).toMatchObject({
      status: "partial",
      errors: [{ label: "Copilot", message: "Sign in again" }],
    });
    expect(snapshotExport({ checkedAtMs: NOW_MS - 1_000, error: { code: "timeout" } })).toEqual({
      status: "error",
      fetchedAt: Math.floor((NOW_MS - 1_000) / 1000),
      error: "Timed out",
    });
  });

  it("writes unavailable before the provider first answered", () => {
    expect(snapshotExport({ refreshing: true })).toEqual({ status: "unavailable" });
  });
});

describe("writeQuotaExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls writeJsonAtomic with the resolved path and trailing newline", async () => {
    const exportData: any = { version: 3, providers: {} };
    await writeQuotaExport(exportData, testPaths.explicitExport);

    expect(writeJsonAtomic).toHaveBeenCalledWith(testPaths.explicitExport, exportData, {
      trailingNewline: true,
    });
  });
});
