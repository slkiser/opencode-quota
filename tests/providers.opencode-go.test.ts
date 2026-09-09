import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveOpenCodeGoAuthCached: vi.fn(),
  resolveOpenCodeGoAuth: vi.fn(),
  getOpenCodeGoAuthDiagnostics: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-go-auth.js", () => ({
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS: 5_000,
  OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS: ["opencode-go", "opencode"],
  resolveOpenCodeGoAuthCached: mocks.resolveOpenCodeGoAuthCached,
  getOpenCodeGoAuthDiagnostics: mocks.getOpenCodeGoAuthDiagnostics,
  resolveOpenCodeGoAuth: mocks.resolveOpenCodeGoAuth,
}));

vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import {
  __resetOpenCodeGoNotSubscribedForTests,
  opencodeGoProvider,
} from "../src/providers/opencode-go.js";

function successfulResult() {
  return {
    success: true as const,
    rolling: {
      status: "ok" as const,
      usagePercent: 12.5,
      percentRemaining: 87.5,
      resetTimeIso: "2026-08-12T12:30:00.000Z",
    },
    weekly: {
      status: "ok" as const,
      usagePercent: 45,
      percentRemaining: 55,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    },
    monthly: {
      status: "ok" as const,
      usagePercent: 80,
      percentRemaining: 20,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    },
  };
}

function diagnostics(
  state: "none" | "configured" | "invalid" = "configured",
): Record<string, unknown> {
  return {
    state,
    source: state === "none" ? null : "opencode.db",
    checkedPaths: ["env:OPENCODE_API_KEY", "/tmp/opencode.json"],
    credentialDatabasePaths: ["/tmp/opencode.db"],
    ...(state === "invalid" ? { error: "OpenCode Go auth entry present but key is empty" } : {}),
  };
}

async function runFetch(
  opencodeGoWindows: Array<"rolling" | "weekly" | "monthly"> = ["rolling", "weekly", "monthly"],
  requestTimeoutMs = 5_000,
) {
  return opencodeGoProvider.fetch(
    createProviderAvailabilityContext({
      configOverrides: { opencodeGoWindows, requestTimeoutMs },
    }),
  );
}

describe("opencode-go provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue(diagnostics());
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });
  });

  it("returns not attempted for absent auth without calling the API", async () => {
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expectNotAttempted(out);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "none" },
        { key: "auth_source", value: "(none)" },
        { key: "selected_windows", value: "rolling,weekly,monthly" },
      ]),
    );
  });

  it("returns an attempted error for invalid canonical auth", async () => {
    const error = "OpenCode Go auth entry present but key is empty";
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "invalid", error });

    const out = await runFetch();

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe(error);
    expect(out.statusDetails).toContainEqual({ key: "auth_error", value: error });
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("keeps a valid inactive duplicate-label database credential when the active row is invalid", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "empty key",
    });
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "bad",
        integrationId: "opencode-go",
        label: "shared",
        active: true,
        value: { key: "" },
      },
      {
        id: "good",
        integrationId: "opencode-go",
        label: "shared",
        active: false,
        value: { key: "ok" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) =>
      auth["opencode-go"].key
        ? { state: "configured", apiKey: "row-token" }
        : { state: "invalid", error: "empty key" },
    );

    const out = await runFetch();
    expect(out.errors).toContainEqual({ label: "[OpenCode Go shared]*", message: "empty key" });
    expect(out.entries).toContainEqual(
      expect.objectContaining({
        group: "[OpenCode Go shared 2]",
        accounting: expect.objectContaining({ sourceId: "good" }),
      }),
    );
    expect(out.entries).toHaveLength(3);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
  });

  it("reports one Go connection when the same key is stored under both integrations", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const workspaceCredential = { type: "key", key: "workspace-key" };
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: workspaceCredential,
      },
      {
        id: "zen-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: workspaceCredential,
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(visibleEntries(out.entries, "opencode-go").map((entry) => entry.group)).toEqual([
      "[OpenCode Go]*",
      "[OpenCode Go]*",
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "go-row" });
    }
  });

  it("does not report another integration's credential as a second Go connection", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "go-key" },
      },
      {
        id: "zen-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: { type: "key", key: "zen-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "go-row" });
    }
  });

  it("keeps separate connections for distinct native credentials", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "first-key" },
      },
      {
        id: "second-go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "second-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(2);
    const groups = visibleEntries(out.entries, "opencode-go").map((entry) => entry.group);
    expect(groups).toEqual(["[OpenCode Go]", "[OpenCode Go]", "[OpenCode Go]", "[OpenCode Go]"]);
  });

  it("suppresses non-entitled database connections independently", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const credentialRows = [
      {
        id: "not-subscribed",
        integrationId: "opencode-go",
        label: "free",
        active: true,
        value: { type: "key", key: "free-key" },
      },
      {
        id: "subscribed",
        integrationId: "opencode-go",
        label: "paid",
        active: false,
        value: { type: "key", key: "paid-key" },
      },
    ];
    (readCredentialRows as any)
      .mockResolvedValueOnce(credentialRows)
      .mockResolvedValueOnce(credentialRows);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) => ({
      state: "configured",
      apiKey: auth["opencode-go"].key,
    }));
    mocks.queryOpenCodeGoQuota.mockImplementation(async (apiKey: string) =>
      apiKey === "free-key"
        ? {
            success: false,
            error: "OpenCode Go not subscribed (403 EntitlementError)",
            notSubscribed: true,
            retryable: false,
          }
        : successfulResult(),
    );

    const first = await runFetch(["rolling"]);
    const second = await runFetch(["rolling"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(3);
    expect(mocks.queryOpenCodeGoQuota.mock.calls.map(([apiKey]) => apiKey)).toEqual([
      "free-key",
      "paid-key",
      "paid-key",
    ]);
    expect(first.entries).toEqual([
      expect.objectContaining({ accounting: expect.objectContaining({ sourceId: "subscribed" }) }),
    ]);
    expect(second.entries).toEqual([
      expect.objectContaining({ accounting: expect.objectContaining({ sourceId: "subscribed" }) }),
    ]);
  });

  it("falls back to legacy alias rows when no native opencode-go row exists", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "alias-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: { type: "key", key: "legacy-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(visibleEntries(out.entries, "opencode-go").map((entry) => entry.group)).toEqual([
      "[OpenCode Go]*",
      "[OpenCode Go]*",
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "alias-row" });
    }
  });

  it("passes the resolved token and effective timeout to the API client", async () => {
    await runFetch(["rolling", "weekly", "monthly"], 12_345);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledWith("provider-test-token", {
      requestTimeoutMs: 12_345,
    });
  });

  it("returns canonical entries with remote_api accounting", async () => {
    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "opencode-go")).toEqual([
      {
        name: "OpenCode Go 5h",
        group: "OpenCode Go",
        label: "5h:",
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      {
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        label: "Weekly:",
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      {
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        label: "Monthly:",
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toEqual({
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      });
    }
  });

  it("filters duplicates in canonical order after full-response diagnostics", async () => {
    const out = await runFetch(["monthly", "rolling", "monthly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Monthly",
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "selected_windows", value: "monthly,rolling,monthly" },
        {
          key: "rolling_usage",
          value:
            "status=ok percent_used=12.5 percent_remaining=87.5 reset_at=2026-08-12T12:30:00.000Z",
        },
        {
          key: "weekly_usage",
          value: "status=ok percent_used=45 percent_remaining=55 reset_at=2026-08-16T16:00:00.000Z",
        },
        {
          key: "monthly_usage",
          value: "status=ok percent_used=80 percent_remaining=20 reset_at=2026-09-01T04:00:00.000Z",
        },
      ]),
    );
  });

  it("uses only the standard auth diagnostic keys", async () => {
    const out = await runFetch(["weekly"]);
    const keys = out.statusDetails?.map((detail) => detail.key) ?? [];

    expect(keys).toEqual([
      "auth_state",
      "auth_source",
      "auth_checked_paths",
      "credential_database_paths",
      "selected_windows",
      "rolling_usage",
      "weekly_usage",
      "monthly_usage",
    ]);
    expect(keys.some((key) => key.startsWith("config_"))).toBe(false);
    expect(keys).not.toContain("reset_in_sec");
  });

  it("returns API failures as attempted errors with live_fetch_error", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go API error 503: unavailable",
    });

    const out = await runFetch();

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe("OpenCode Go API error 503: unavailable");
    expect(out.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value: "OpenCode Go API error 503: unavailable",
    });
  });

  it("surfaces a rate-limited monthly window as a valid result", async () => {
    const result = successfulResult();
    result.monthly = {
      status: "rate-limited" as const,
      usagePercent: 100,
      percentRemaining: 0,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    };
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(result);

    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toContainEqual({
      key: "monthly_usage",
      value:
        "status=rate-limited percent_used=100 percent_remaining=0 reset_at=2026-09-01T04:00:00.000Z",
    });
    expect(
      out.entries.find((entry) => entry.name === "OpenCode Go Monthly")?.percentRemaining,
    ).toBe(0);
  });

  it("suppresses repeat requests after a not-subscribed response", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValue({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });

    const first = await runFetch();
    const second = await runFetch();

    expectAttemptedWithNoErrors(first);
    expectAttemptedWithNoErrors(second);
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([]);
    expect(first.statusDetails).toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
    expect(second.statusDetails).toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(1);
  });

  it("queries again after the credential changes, including when the original returns", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      true,
    );
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "new-provider-test-token",
    });
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(3);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenNthCalledWith(2, "new-provider-test-token", {
      requestTimeoutMs: 5_000,
    });
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenLastCalledWith("provider-test-token", {
      requestTimeoutMs: 5_000,
    });
  });

  it.each([
    ["missing", { state: "none" }],
    ["invalid", { state: "invalid", error: "OpenCode Go auth entry present but key is empty" }],
  ])("queries again after production availability sees %s auth", async (_name, auth) => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      false,
    );
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenLastCalledWith("provider-test-token", {
      requestTimeoutMs: 5_000,
    });
  });

  it("does not copy the resolved token into provider output", async () => {
    const out = await runFetch();
    expect(JSON.stringify(out)).not.toContain("provider-test-token");
  });
});

describe("opencode-go availability and model matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
  });

  it.each([
    [{ state: "configured", apiKey: "key" }, true],
    [{ state: "invalid", error: "bad auth" }, false],
    [{ state: "none" }, false],
  ])("maps auth state %j to availability %s without a request", async (auth, expected) => {
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);

    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      expected,
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["opencode-go/some-model", true],
    ["opencode-go-subscription/any", true],
    ["openai/gpt-4", false],
    ["copilot/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeGoProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
