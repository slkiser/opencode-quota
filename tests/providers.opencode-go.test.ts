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
  getOpenCodeGoAuthDiagnostics: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
}));

vi.mock("../src/lib/opencode-go-auth.js", () => ({
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS: 5_000,
  resolveOpenCodeGoAuthCached: mocks.resolveOpenCodeGoAuthCached,
  getOpenCodeGoAuthDiagnostics: mocks.getOpenCodeGoAuthDiagnostics,
}));

vi.mock("../src/lib/opencode-go.js", () => ({
  queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
}));

import { opencodeGoProvider } from "../src/providers/opencode-go.js";

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
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue(diagnostics());
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());
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

  it("does not copy the resolved token into provider output", async () => {
    const out = await runFetch();
    expect(JSON.stringify(out)).not.toContain("provider-test-token");
  });
});

describe("opencode-go availability and model matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
