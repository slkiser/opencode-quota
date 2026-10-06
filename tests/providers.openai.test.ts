import { describe, expect, it, vi } from "vitest";
import { projectQuotaProviderResults } from "../src/lib/quota-accounting-projection.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { openaiProvider } from "../src/providers/openai.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/openai.js", () => ({
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS: 5_000,
  OPENAI_AUTH_SOURCE_KEYS: ["openai", "codex", "chatgpt"],
  hasOpenAIOAuthCached: vi.fn(),
  resolveOpenAIOAuth: vi.fn(() => ({ state: "none" })),
  queryOpenAIQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

describe("openai provider", () => {
  it("passes configured requestTimeoutMs to the query", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    await openaiProvider.fetch({ config: { requestTimeoutMs: 12000 } } as any);

    expect(queryOpenAIQuota).toHaveBeenCalledWith({ requestTimeoutMs: 12000 });
  });

  it("returns attempted:false when not configured", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce(null);

    const out = await openaiProvider.fetch({} as any);
    expectNotAttempted(out);
  });

  it("maps success into canonical grouped-capable windows with single-window display metadata", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: {
        hourly: { percentRemaining: 42, resetTimeIso: "2026-01-01T00:00:00.000Z" },
        weekly: { percentRemaining: 80, resetTimeIso: "2026-01-07T00:00:00.000Z" },
        monthly: { percentRemaining: 67, resetTimeIso: "2026-02-01T00:00:00.000Z" },
        codeReview: { percentRemaining: 55, resetTimeIso: "2026-01-02T00:00:00.000Z" },
      },
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        name: "OpenAI (Pro) 5h",
        group: "OpenAI (Pro)",
        label: "5h:",
        percentRemaining: 42,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Weekly",
        group: "OpenAI (Pro)",
        label: "Weekly:",
        percentRemaining: 80,
        resetTimeIso: "2026-01-07T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Monthly",
        group: "OpenAI (Pro)",
        label: "Monthly:",
        percentRemaining: 67,
        resetTimeIso: "2026-02-01T00:00:00.000Z",
      },
      {
        name: "OpenAI (Pro) Code Review",
        group: "OpenAI (Pro)",
        label: "Code Review:",
        percentRemaining: 55,
        resetTimeIso: "2026-01-02T00:00:00.000Z",
      },
    ]);
    expect(out.entries.at(-1)?.accounting.resultType).toBe("rate_limit");
    expect(out.presentation).toEqual({
      singleWindowDisplayName: "OpenAI (Pro)",
    });
  });

  it("maps errors into toast errors", async () => {
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await openaiProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenAI");
  });

  it("queries and labels every database credential independently", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "active-id",
        integrationId: "openai",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "active" },
      },
      {
        id: "other-id",
        integrationId: "openai",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "other" },
      },
    ]);
    (resolveOpenAIOAuth as any).mockImplementation((auth: any) => ({
      state: "configured",
      sourceKey: "openai",
      accessToken: auth.openai.access,
    }));
    (queryOpenAIQuota as any).mockResolvedValue({
      success: true,
      label: "OpenAI (Business)",
      windows: {
        hourly: { percentRemaining: 42 },
        weekly: { percentRemaining: 80 },
        monthly: { percentRemaining: 67 },
        codeReview: { percentRemaining: 55 },
      },
    });

    const out = await openaiProvider.fetch({} as any);

    expect(queryOpenAIQuota).toHaveBeenCalledTimes(2);
    expect(out.entries).toHaveLength(8);
    expect(out.entries.filter((entry) => entry.label === "5h:")).toHaveLength(2);
    expect(projectQuotaProviderResults([out], "allWindows", "summary")).toHaveLength(8);
    const singleWindow = projectQuotaProviderResults([out], "singleWindow", "summary");
    expect(singleWindow).toHaveLength(2);
    expect(singleWindow.map((entry) => entry.accounting.sourceId)).toEqual([
      "active-id",
      "other-id",
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work] (Business) (active)", "active-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
      ["[OpenAI Work 2] (Business)", "other-id"],
    ]);
  });

  it.each([
    ["OpenAI", "[OpenAI] (Business)"],
    ["SEPD", "[OpenAI SEPD] (Business)"],
    ["default", "[OpenAI] (Business)"],
  ])("renders DB alias %s literally on sidebar, CLI, and toast", async (label, expected) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "credential-id",
        integrationId: "openai",
        label,
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    (resolveOpenAIOAuth as any).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "token",
    });
    (queryOpenAIQuota as any).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Business)",
      windows: { hourly: { percentRemaining: 42 } },
    });

    const result = await openaiProvider.fetch({ config: {} } as any);
    const data = { entries: result.entries, errors: result.errors };
    const outputs = [
      buildSidebarQuotaPanelLines({
        data,
        config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      }).join("\n"),
      formatQuotaCommand(data),
      formatQuotaRowsGrouped(data),
    ];

    for (const output of outputs) {
      expect(output).toContain(expected);
      expect(output).not.toContain("[OpenAI (OpenAI)]");
    }
  });

  it("shows a login OpenCode could not return as its own error row next to working ones", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    const actual =
      await vi.importActual<typeof import("../src/lib/openai.js")>("../src/lib/openai.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "work-id",
        integrationId: "openai",
        label: "Work",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 400",
      },
      {
        id: "home-id",
        integrationId: "openai",
        label: "Home",
        active: false,
        value: { type: "oauth", access: "home-token" },
      },
    ]);
    (resolveOpenAIOAuth as any)
      .mockImplementationOnce(actual.resolveOpenAIOAuth)
      .mockImplementationOnce(actual.resolveOpenAIOAuth);
    (queryOpenAIQuota as any)
      .mockImplementationOnce(actual.queryOpenAIQuota)
      .mockResolvedValueOnce({
        success: true,
        label: "OpenAI (Pro)",
        windows: { hourly: { percentRemaining: 42 } },
      });

    const out = await openaiProvider.fetch({} as any);

    expect(readCredentialRows).toHaveBeenLastCalledWith(["openai", "codex", "chatgpt"], {
      methods: ["oauth", "key"],
    });
    expect(out.errors).toEqual([
      {
        label: "[OpenAI Work] (active)",
        message:
          "OpenAI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login openai`.",
      },
    ]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[OpenAI Home] (Pro)", "home-id"],
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "failed" },
      ]),
    );
  });

  it("reports a stored API key without querying ChatGPT", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    const queryCallsBefore = vi.mocked(queryOpenAIQuota).mock.calls.length;
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "Key",
        active: true,
        value: { type: "api", key: "sk-test" },
      },
    ]);

    const out = await openaiProvider.fetch({} as any);

    expect(vi.mocked(queryOpenAIQuota).mock.calls).toHaveLength(queryCallsBefore);
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([]);
    expect(visibleEntries(out.entries, "openai")).toEqual([
      {
        kind: "value",
        name: "[OpenAI Key]",
        group: "[OpenAI Key]",
        value: "ChatGPT quota unavailable for API key",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "api key" },
        { key: "token_expires_at", value: "(none)" },
      ]),
    );
  });

  it("shows an active API key next to an inactive OAuth account with one ChatGPT query", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    const queryCallsBefore = vi.mocked(queryOpenAIQuota).mock.calls.length;
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "API key",
        active: true,
        value: { type: "api", key: "sk-test" },
      },
      {
        id: "oauth-id",
        integrationId: "openai",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "token" },
      },
    ]);
    vi.mocked(resolveOpenAIOAuth).mockImplementation((auth) => ({
      state: "configured",
      sourceKey: "openai",
      accessToken: auth?.openai?.access ?? "",
    }));
    vi.mocked(queryOpenAIQuota).mockResolvedValueOnce({
      success: true,
      label: "OpenAI (Pro)",
      windows: { hourly: { percentRemaining: 42 } },
    });

    const out = await openaiProvider.fetch({} as any);

    const queryCalls = vi.mocked(queryOpenAIQuota).mock.calls.slice(queryCallsBefore);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0][0].auth).toEqual({
      state: "configured",
      sourceKey: "openai",
      accessToken: "token",
    });
    expect(out.errors).toEqual([]);
    expect(out.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual([
      ["[OpenAI] (active)", "key-id"],
      ["[OpenAI Work] (Pro)", "oauth-id"],
    ]);
    for (const formatStyle of ["allWindows", "singleWindow"] as const) {
      const lines = buildSidebarQuotaPanelLines({
        data: { entries: out.entries, errors: out.errors },
        config: { formatStyle, percentDisplayMode: "remaining" },
      });
      expect(lines.some((line) => line.includes("[OpenAI Work] (Pro)"))).toBe(true);
      expect(lines.some((line) => line.includes("42%"))).toBe(true);
      expect(lines.filter((line) => line === "[OpenAI] (active)")).toHaveLength(1);
      const statusLines = lines
        .slice(
          lines.indexOf("[OpenAI] (active)") + 1,
          lines.findIndex((line) => line.startsWith("[OpenAI Work] (Pro)")),
        )
        .filter(Boolean);
      expect(statusLines.every((line) => line === line.trim())).toBe(true);
      expect(statusLines.join(" ")).toBe("ChatGPT quota unavailable for API key");
    }
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "auth_source", value: "openai" },
        { key: "token_status", value: "api key" },
      ]),
    );
  });

  it.each([
    true,
    false,
  ])("keeps the active API-key account on a 60-column mixed-credential compact line (key first: %s)", async (keyFirst) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    const keyRow = {
      id: "key-id",
      integrationId: "openai",
      label: "API key",
      active: true,
      value: { type: "api", key: "sk-test" },
    };
    const oauthRow = {
      id: "oauth-id",
      integrationId: "openai",
      label: "OAuth",
      active: false,
      value: { type: "oauth", access: "token" },
    };
    vi.mocked(readCredentialRows).mockResolvedValueOnce(
      keyFirst ? [keyRow, oauthRow] : [oauthRow, keyRow],
    );
    vi.mocked(resolveOpenAIOAuth).mockReturnValue({
      state: "configured",
      sourceKey: "openai",
      accessToken: "token",
    });
    vi.mocked(queryOpenAIQuota).mockResolvedValueOnce({
      success: true,
      label: "OpenAI",
      windows: {
        hourly: { percentRemaining: 42 },
        weekly: { percentRemaining: 74 },
      },
    });

    const out = await openaiProvider.fetch({} as any);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "key-id",
      "oauth-id",
      "oauth-id",
    ]);
    expect(
      buildCompactQuotaStatusLine({
        data: { entries: out.entries, errors: out.errors },
        maxWidth: 60,
      }),
    ).toBe("OpenAI - ChatGPT quota unavailable for API key");
  });

  it.each([
    { config: { currentModel: "codex/gpt-5-codex" }, firstId: "oauth-id" },
    {
      config: { currentProviderID: "codex", currentModel: "gpt-5-codex" },
      firstId: "oauth-id",
    },
    { config: { currentProviderID: "codex" }, firstId: "oauth-id" },
    {
      config: { currentProviderID: "openai", currentModel: "codex/gpt-5-codex" },
      firstId: "key-id",
    },
    // Unknown session (e.g. onlyCurrentModel off): the OAuth login with quota numbers goes first.
    { config: {}, firstId: "oauth-id" },
  ])("prefers the session's active integration when OpenAI and Codex are both active ($config)", async ({
    config,
    firstId,
  }) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota, resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "API key",
        active: true,
        value: { type: "api", key: "sk-test" },
      },
      {
        id: "oauth-id",
        integrationId: "codex",
        label: "Work",
        active: true,
        value: { type: "oauth", access: "token" },
      },
    ]);
    vi.mocked(resolveOpenAIOAuth).mockReturnValue({
      state: "configured",
      sourceKey: "codex",
      accessToken: "token",
    });
    vi.mocked(queryOpenAIQuota).mockResolvedValueOnce({
      success: true,
      label: "OpenAI",
      windows: { hourly: { percentRemaining: 42 } },
    });

    const out = await openaiProvider.fetch({ config } as any);
    const expectedIds = firstId === "oauth-id" ? ["oauth-id", "key-id"] : ["key-id", "oauth-id"];
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(expectedIds);
    expect(queryOpenAIQuota).toHaveBeenCalledOnce();
    expect(out.errors).toEqual([]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_source", value: firstId === "oauth-id" ? "codex" : "openai" },
        { key: "token_status", value: firstId === "oauth-id" ? "valid" : "api key" },
      ]),
    );
    expect(
      buildCompactQuotaStatusLine({
        data: { entries: out.entries, errors: out.errors },
        maxWidth: 60,
      }),
    ).toBe(
      firstId === "oauth-id"
        ? "OpenAI Work 42% | +1"
        : "OpenAI - ChatGPT quota unavailable for API key | +1",
    );
  });

  it("keeps other active rows and inactive rows in source order after the session's active row", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    vi.mocked(readCredentialRows).mockResolvedValueOnce(
      [
        { id: "inactive-openai", integrationId: "openai", active: false },
        { id: "active-openai", integrationId: "openai", active: true },
        { id: "inactive-codex", integrationId: "codex", active: false },
        { id: "active-chatgpt", integrationId: "chatgpt", active: true },
        { id: "active-codex", integrationId: "codex", active: true },
      ].map((row) => ({ ...row, label: row.id, value: { type: "api", key: "sk-test" } })),
    );

    const out = await openaiProvider.fetch({ config: { currentProviderID: "codex" } } as any);

    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "active-codex",
      "active-openai",
      "active-chatgpt",
      "inactive-openai",
      "inactive-codex",
    ]);
  });

  it.each([
    { active: true, labels: ["API key", "default", "OpenAI"] },
    { active: false, labels: ["", "API key"] },
  ])("keeps unnamed API-key accounts distinct (active: $active)", async ({ active, labels }) => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    vi.mocked(readCredentialRows).mockResolvedValueOnce(
      labels.map((label, index) => ({
        id: `key-${index}`,
        integrationId: "openai",
        label,
        active: active && index === 0,
        value: { type: "api", key: `sk-test-${index}` },
      })),
    );

    const out = await openaiProvider.fetch({} as any);
    const names = labels.map(
      (_, index) =>
        `[OpenAI${index === 0 ? "" : ` ${index + 1}`}]${active && index === 0 ? " (active)" : ""}`,
    );
    expect(queryOpenAIQuota).not.toHaveBeenCalled();
    expect(out.entries.map((entry) => entry.name)).toEqual(names);
    expect(out.entries.map((entry) => entry.group)).toEqual(names);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(
      labels.map((_, index) => `key-${index}`),
    );
    const data = { entries: out.entries, errors: out.errors };
    const outputs = [
      formatQuotaRowsGrouped(data),
      buildSidebarQuotaPanelLines({ data, config: { formatStyle: "allWindows" } }).join("\n"),
      formatQuotaCommand(data),
    ];
    for (const output of outputs) {
      for (const name of names) {
        expect(
          output.split("\n").filter((line) => line === name || line === `→ ${name}`),
        ).toHaveLength(1);
      }
    }
  });

  it("keeps an explicit numeric API-key alias separate from numbered unnamed accounts on every grouped surface", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const labels = ["API key", "default", "2"];
    vi.mocked(readCredentialRows).mockResolvedValueOnce(
      labels.map((label, index) => ({
        id: `key-${index}`,
        integrationId: "openai",
        label,
        active: index === 0,
        value: { type: "api", key: `sk-test-${index}` },
      })),
    );

    const out = await openaiProvider.fetch({} as any);
    const names = ["[OpenAI] (active)", "[OpenAI 3]", "[OpenAI 2]"];
    expect(out.entries.map((entry) => entry.group)).toEqual(names);
    const data = { entries: out.entries, errors: out.errors };
    const outputs = [
      formatQuotaRowsGrouped(data),
      buildSidebarQuotaPanelLines({ data, config: { formatStyle: "allWindows" } }).join("\n"),
      formatQuotaCommand(data),
    ];
    for (const output of outputs) {
      for (const name of names) {
        expect(
          output.split("\n").filter((line) => line === name || line === `→ ${name}`),
        ).toHaveLength(1);
      }
      expect(
        output.replace(/\s+/gu, " ").match(/ChatGPT quota unavailable for API key/gu),
      ).toHaveLength(3);
    }
  });

  it("reports unknown active auth when no stored row is marked active", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "Key",
        active: false,
        value: { type: "api", key: "sk-test" },
      },
      {
        id: "oauth-id",
        integrationId: "openai",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "token", expires: Date.now() + 60_000 },
      },
    ]);
    vi.mocked(resolveOpenAIOAuth).mockImplementation((auth) => ({
      state: "configured",
      sourceKey: "openai",
      accessToken: auth?.openai?.access ?? "",
      expiresAt: auth?.openai?.expires,
    }));

    const out = await openaiProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.statusDetails).toEqual([
      { key: "auth_configured", value: "true" },
      { key: "auth_source", value: "unknown" },
      { key: "token_status", value: "unknown" },
      { key: "token_expires_at", value: "unknown" },
    ]);
  });

  it("shows an API key OpenCode could not read as an auth error", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { queryOpenAIQuota } = await import("../src/lib/openai.js");
    const queryCallsBefore = vi.mocked(queryOpenAIQuota).mock.calls.length;
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "Key",
        active: true,
        value: { type: "api" },
        resolveError: "refresh_failed: HTTP 400",
      },
    ]);

    const out = await openaiProvider.fetch({} as any);

    expect(vi.mocked(queryOpenAIQuota).mock.calls).toHaveLength(queryCallsBefore);
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "[OpenAI Key]",
        message: "OpenAI API key could not be read: refresh_failed: HTTP 400",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_configured", value: "true" },
        { key: "token_status", value: "failed" },
      ]),
    );
  });

  it("renders the API-key status row on sidebar, /quota, toast, compact line, and single-window projection", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const { resolveOpenAIOAuth } = await import("../src/lib/openai.js");
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "Key",
        active: true,
        value: { type: "api", key: "sk-test" },
      },
    ]);
    vi.mocked(resolveOpenAIOAuth).mockImplementation(() => ({ state: "none" }));

    const result = await openaiProvider.fetch({ config: {} } as any);
    const data = { entries: result.entries, errors: result.errors };
    const outputs = [
      buildSidebarQuotaPanelLines({
        data,
        config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
      }).join("\n"),
      formatQuotaCommand(data),
      formatQuotaRowsGrouped(data),
      buildCompactQuotaStatusLine({ data, maxWidth: 200 }),
    ];

    for (const output of outputs) {
      // Narrow surfaces wrap the sentence; collapsing whitespace keeps the phrase checkable.
      const collapsed = output.replace(/\s+/gu, " ");
      expect(collapsed).toContain("OpenAI Key");
      expect(collapsed).toContain("ChatGPT quota unavailable for API key");
    }

    const sidebarLines = outputs[0]!.split("\n");
    expect(sidebarLines.filter((line) => line === "[OpenAI Key]")).toHaveLength(1);

    const singleWindow = projectQuotaProviderResults([result], "singleWindow", "summary");
    expect(singleWindow).toHaveLength(1);
    expect(singleWindow[0]?.accounting.sourceId).toBe("key-id");
  });

  it("is available when provider ids include openai/chatgpt/codex", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["openai"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["chatgpt"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["codex"] })),
    ).resolves.toBe(true);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["opencode"] })),
    ).resolves.toBe(false);
    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(false);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledTimes(2);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("falls back to native OpenCode auth when provider ids do not include an OpenAI alias", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValueOnce(true);

    const ctx = createProviderAvailabilityContext({ providerIds: ["zai"] });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).toHaveBeenCalledWith({ maxAgeMs: 5_000 });
  });

  it("is available when only a stored OpenAI API key exists", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    vi.mocked(hasOpenAIOAuthCached).mockResolvedValue(false);
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "key-id",
        integrationId: "openai",
        label: "Key",
        active: true,
        value: { type: "api", key: "sk-test" },
      },
    ]);

    await expect(
      openaiProvider.isAvailable(createProviderAvailabilityContext({ providerIds: ["zai"] })),
    ).resolves.toBe(true);
    expect(readCredentialRows).toHaveBeenLastCalledWith(["openai", "codex", "chatgpt"], {
      methods: ["key"],
      firstOnly: true,
    });
  });

  it("falls back to available when provider lookup throws", async () => {
    const { hasOpenAIOAuthCached } = await import("../src/lib/openai.js");
    (hasOpenAIOAuthCached as any).mockResolvedValue(false);

    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(openaiProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(hasOpenAIOAuthCached).not.toHaveBeenCalled();
  });
});
