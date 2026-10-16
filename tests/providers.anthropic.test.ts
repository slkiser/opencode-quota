import { describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import type { QuotaRow } from "../src/core/types.js";
import {
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  queryAnthropicQuota,
  queryAnthropicQuotaWithOAuth,
} from "../src/lib/anthropic.js";
import type { QuotaProviderContext } from "../src/lib/entries.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("../src/lib/anthropic.js", () => ({
  getAnthropicDiagnostics: vi.fn(),
  hasAnthropicCredentialsConfigured: vi.fn(),
  queryAnthropicQuota: vi.fn(),
  queryAnthropicQuotaWithOAuth: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

const diagnosticsMock = vi.mocked(getAnthropicDiagnostics);
const quotaMock = vi.mocked(queryAnthropicQuota);
const oauthQuotaMock = vi.mocked(queryAnthropicQuotaWithOAuth);
const credentialsConfiguredMock = vi.mocked(hasAnthropicCredentialsConfigured);
const NO_CONFIG_CTX = {} as QuotaProviderContext;
const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const FIVE_HOUR_RESET = "2026-07-21T14:10:00.268Z";
const WEEKLY_RESET = "2026-07-27T07:00:00.268Z";

function mockDiagnostics(diagnostics: Record<string, unknown>): void {
  diagnosticsMock.mockResolvedValueOnce({
    installed: true,
    version: "1.2.3",
    authStatus: "authenticated",
    checkedCommands: ["claude --version"],
    ...diagnostics,
  } as never);
}

async function fetchRows(ctx: QuotaProviderContext = NO_CONFIG_CTX) {
  return rowsFromProviderResult("anthropic", await anthropicProvider.fetch(ctx), NOW_MS);
}

/** id, account, label, window, method, percent left, reset. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [
    row.id,
    row.account ?? null,
    row.label,
    row.window ?? null,
    row.method,
    row.percentRemaining,
    row.resetsAt ?? null,
  ]);
}

describe("anthropic provider", () => {
  it.each([
    [
      "local CLI windows as local CLI rows",
      "claude-auth-status-json",
      {},
      [
        ["anthropic.five_hour", null, "5h", "five_hour", "local_cli", 43, FIVE_HOUR_RESET],
        ["anthropic.weekly", null, "Weekly", "week", "local_cli", 88, WEEKLY_RESET],
      ],
    ],
    [
      "Usage Credits and Fable weekly from the OAuth API as remote rows",
      "opencode-auth-oauth-api",
      {
        extra_usage: { percentRemaining: 62 },
        fable_weekly: { percentRemaining: 98, resetTimeIso: WEEKLY_RESET },
      },
      [
        ["anthropic.five_hour", null, "5h", "five_hour", "remote_api", 43, FIVE_HOUR_RESET],
        ["anthropic.weekly", null, "Weekly", "week", "remote_api", 88, WEEKLY_RESET],
        ["anthropic.extra_usage", null, "Extra usage", "month", "remote_api", 62, null],
        ["anthropic.weekly_fable", null, "Fable", "week", "remote_api", 98, WEEKLY_RESET],
      ],
    ],
  ])("maps %s", async (_name, quotaSource, extra, expected) => {
    const quota = {
      success: true as const,
      five_hour: { percentRemaining: 43, resetTimeIso: FIVE_HOUR_RESET },
      seven_day: { percentRemaining: 88, resetTimeIso: WEEKLY_RESET },
      ...extra,
    };
    mockDiagnostics({ quotaSupported: true, quotaSource, quota });
    quotaMock.mockResolvedValueOnce(quota);

    const fetched = await fetchRows();

    expect(summary(fetched.rows)).toEqual(expected);
    expect(fetched.rows.every((row) => row.type === "quota" && row.prominence === "primary")).toBe(
      true,
    );
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toContainEqual({
      key: "five_hour_remaining",
      value: `43% reset_at=${FIVE_HOUR_RESET}`,
    });
  });

  it("queries each stored Claude login and shows one OpenCode could not read as an error", async () => {
    vi.mocked(readCredentialRows).mockResolvedValueOnce([
      {
        id: "failed-active",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 500",
      },
      {
        id: "valid-inactive",
        integrationId: "anthropic",
        label: "Work",
        active: false,
        value: { type: "oauth", access: "valid" },
      },
    ] as never);
    mockDiagnostics({ quotaSupported: false, quotaSource: "none", checkedCommands: [] });
    oauthQuotaMock.mockResolvedValueOnce({
      success: true,
      five_hour: { percentRemaining: 80 },
      seven_day: { percentRemaining: 70 },
      extra_usage: { percentRemaining: 60 },
      fable_weekly: { percentRemaining: 50 },
    });

    const fetched = await fetchRows({ config: { requestTimeoutMs: 2500 } } as QuotaProviderContext);

    expect(oauthQuotaMock).toHaveBeenCalledExactlyOnceWith("valid", 2500);
    expect(quotaMock).not.toHaveBeenCalled();
    expect(summary(fetched.rows)).toEqual([
      ["anthropic.five_hour", "Work", "5h", "five_hour", "remote_api", 80, null],
      ["anthropic.weekly", "Work", "Weekly", "week", "remote_api", 70, null],
      ["anthropic.extra_usage", "Work", "Extra usage", "month", "remote_api", 60, null],
      ["anthropic.weekly_fable", "Work", "Fable", "week", "remote_api", 50, null],
    ]);
    expect(fetched.rowLogins).toEqual(Array(4).fill("valid-inactive"));
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value:
        "[Claude] (active): Anthropic sign-in could not be read: refresh_failed: HTTP 500. Run `opencode auth login anthropic`.",
    });
  });

  it.each([
    [
      "a failed query as the error",
      {
        success: false,
        error: "Invalid or expired Anthropic token; re-authenticate Claude Code",
      },
      { rows: [], error: { code: "bad_response" } },
      "Claude: Invalid or expired Anthropic token; re-authenticate Claude Code",
    ],
    ["no Claude login as not set up", null, { rows: [], error: { code: "not_configured" } }, null],
  ])("reports %s", async (_name, result, expected, errorLine) => {
    diagnosticsMock.mockRejectedValueOnce(new Error("probe \u001b[31mboom"));
    quotaMock.mockResolvedValueOnce(result as never);

    const fetched = await fetchRows();

    expect(fetched).toMatchObject(expected);
    expect(fetched.debug.slice(0, 2)).toEqual([
      { key: "cli_installed", value: "false" },
      { key: "message", value: "failed to probe Claude CLI: probe boom" },
    ]);
    if (errorLine) expect(fetched.debug).toContainEqual({ key: "error", value: errorLine });
  });

  it.each([
    [
      "the credential store that answered the usage probe",
      {
        oauthCredentialSource: "opencode-auth",
        binaryPath: "/opt/homebrew/bin/claude",
        quotaSupported: true,
        quotaSource: "opencode-auth-oauth-api",
      },
      [
        { key: "oauth_credential_source", value: "opencode-auth" },
        { key: "binary_path", value: "/opt/homebrew/bin/claude" },
        { key: "quota_source", value: "opencode-auth-oauth-api" },
      ],
    ],
    [
      "no credential store when the OAuth probe was never reached",
      { binaryPath: null, quotaSupported: false, quotaSource: "none" },
      [
        { key: "oauth_credential_source", value: "(none)" },
        { key: "binary_path", value: "(none)" },
      ],
    ],
  ])("reports %s", async (_label, diagnostics, expectedDetails) => {
    mockDiagnostics(diagnostics);
    quotaMock.mockResolvedValueOnce(null);

    const { debug } = await fetchRows();

    for (const detail of expectedDetails) expect(debug).toContainEqual(detail);
  });

  it.each([
    ["anthropic/claude-sonnet-4-6", true],
    ["ANTHROPIC/claude-haiku-4-5", true],
    ["openai/gpt-5", false],
    ["copilot/claude-sonnet-4-5", false],
  ])("matches model id %s: %s", (model, expected) => {
    expect(anthropicProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    [["anthropic"], true, true],
    [["copilot", "anthropic"], true, true],
    [["claude"], true, false],
    [["anthropic"], false, false],
  ])(
    "with provider ids %j and Claude auth ready=%s is available=%s",
    async (providerIds, credentialsConfigured, expected) => {
      credentialsConfiguredMock.mockResolvedValue(credentialsConfigured);

      await expect(
        anthropicProvider.isAvailable(createProviderAvailabilityContext({ providerIds })),
      ).resolves.toBe(expected);
    },
  );

  it("is not available when provider lookup throws", async () => {
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });

  it("passes the configured Claude binary path and timeout through Anthropic probes", async () => {
    credentialsConfiguredMock.mockResolvedValue(true);
    quotaMock.mockResolvedValueOnce(null);
    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic"],
      configOverrides: { anthropicBinaryPath: "/opt/claude/bin/claude", requestTimeoutMs: 2500 },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    expect(credentialsConfiguredMock).toHaveBeenCalledWith({
      binaryPath: "/opt/claude/bin/claude",
    });

    await anthropicProvider.fetch(ctx);
    const options = { binaryPath: "/opt/claude/bin/claude", requestTimeoutMs: 2500 };
    expect(diagnosticsMock).toHaveBeenLastCalledWith(options);
    expect(quotaMock).toHaveBeenCalledWith(options);
  });
});
