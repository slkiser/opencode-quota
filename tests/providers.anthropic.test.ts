/**
 * Claude through the provider world: logins in a temp `opencode.db`, fake HTTP, and a fake
 * `claude` script (POSIX only) that records each run. Claude's own Keychain and credentials
 * file are never reached: every fake CLI either reports quota or is signed out.
 */

import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { clearAnthropicDiagnosticsCacheForTests } from "../src/lib/anthropic.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import fableWeeklyUsage from "./fixtures/anthropic/fable-weekly.sanitized.json";
import type { CredentialDatabaseRow } from "./helpers/credential-database.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";
import {
  fakeHttp,
  fetchRows,
  requestHeader,
  rowSummary,
  useProviderWorld,
} from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FIVE_HOUR_RESET = "2026-07-21T14:10:00.268Z";
const WEEKLY_RESET = "2026-07-27T07:00:00.268Z";
const POSIX = process.platform !== "win32";

const world = useProviderWorld();

beforeEach(() => {
  clearAnthropicDiagnosticsCacheForTests();
});

/** A stored Claude OAuth login; `value` fields replace the defaults. */
function claudeLogin(id: string, value: Record<string, unknown> = {}): CredentialDatabaseRow {
  return {
    id,
    integrationId: "anthropic",
    label: id,
    active: null,
    updated: 1,
    value: { type: "oauth", access: `token-${id}`, expires: Date.now() + 3_600_000, ...value },
  };
}

/** A path where no Claude CLI is. */
function missingClaude(): string {
  return join(world.configDir, "no-claude");
}

/** A fake `claude` that prints `authStatus` as its `auth status --json` and logs each run. */
function fakeClaude(authStatus: unknown): { path: string; runs: () => string[] } {
  const log = join(world.configDir, "claude-runs.log");
  world.writeConfigFile(
    "claude",
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
      "cat <<'JSON'",
      JSON.stringify(authStatus),
      "JSON",
      "",
    ].join("\n"),
  );
  const path = join(world.configDir, "claude");
  chmodSync(path, 0o755);
  return {
    path,
    runs: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
  };
}

const CLI_QUOTA = {
  authenticated: true,
  quota: {
    five_hour: { used_percentage: 57, resets_at: FIVE_HOUR_RESET },
    seven_day: { used_percentage: 12, resets_at: WEEKLY_RESET },
  },
};

function errorDebug(fetched: { debug: Array<{ key: string; value: string }> }): string[] {
  return fetched.debug.filter((item) => item.key === "error").map((item) => item.value);
}

describe("anthropic provider", () => {
  it("asks each OpenCode login once and never starts the Claude CLI", async () => {
    world.storeLogins([claudeLogin("work")]);
    const http = fakeHttp(() => ({
      ...fableWeeklyUsage,
      extra_usage: { is_enabled: true, utilization: 37.8 },
    }));

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    expect(http).toHaveBeenCalledOnce();
    expect(http.mock.calls[0]?.[0]).toBe(USAGE_URL);
    expect(requestHeader(http.mock.calls[0]?.[1], "Authorization")).toBe("Bearer token-work");
    expect(rowSummary(fetched.rows)).toEqual([
      ["anthropic.five_hour", "work", "5h", "five_hour", 58, FIVE_HOUR_RESET],
      ["anthropic.weekly", "work", "Weekly", "week", 72, WEEKLY_RESET],
      ["anthropic.extra_usage", "work", "Extra usage", "month", 62, null],
      ["anthropic.weekly_fable", "work", "Fable", "week", 98, WEEKLY_RESET],
    ]);
    expect(fetched.rows.every((row) => row.method === "remote_api")).toBe(true);
    expect(fetched.debug).toEqual([
      { key: "quota_supported", value: "true" },
      { key: "quota_source", value: "opencode-auth-oauth-api" },
      { key: "oauth_credential_source", value: "opencode-auth" },
    ]);
  });

  it.runIf(POSIX)("leaves an installed Claude CLI alone while a login works", async () => {
    world.storeLogins([claudeLogin("work")]);
    fakeHttp(() => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }));
    const claude = fakeClaude(CLI_QUOTA);

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: claude.path });

    expect(fetched.rows).toHaveLength(2);
    expect(claude.runs()).toEqual([]);
  });

  it.runIf(POSIX)("shows the Claude CLI's own windows without an OpenCode login", async () => {
    const http = fakeHttp(() => ({}));
    const claude = fakeClaude(CLI_QUOTA);

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: claude.path });

    expect(rowSummary(fetched.rows)).toEqual([
      ["anthropic.five_hour", null, "5h", "five_hour", 43, FIVE_HOUR_RESET],
      ["anthropic.weekly", null, "Weekly", "week", 88, WEEKLY_RESET],
    ]);
    expect(fetched.rows.every((row) => row.method === "local_cli")).toBe(true);
    expect(http).not.toHaveBeenCalled();
    expect(claude.runs()).toEqual(["--version", "auth status --json"]);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "cli_installed", value: "true" },
        { key: "cli_version", value: "2.1.0" },
        { key: "binary_path", value: claude.path },
        { key: "quota_source", value: "claude-auth-status-json" },
        { key: "oauth_credential_source", value: "(none)" },
      ]),
    );
  });

  it("is not set up without an OpenCode login or a Claude CLI", async () => {
    const http = fakeHttp(() => ({}));

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    expect(fetched).toMatchObject({ rows: [], error: { code: "not_configured" } });
    expect(fetched.debug).toContainEqual({ key: "cli_installed", value: "false" });
    expect(http).not.toHaveBeenCalled();
  });

  it("reports a Claude CLI probe that throws as a local tool failure", async () => {
    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: "bad\0claude" });

    expect(fetched.error).toMatchObject({ code: "local_tool", tool: "Claude CLI" });
    expect(fetched.debug[0]).toEqual({ key: "cli_installed", value: "false" });
  });

  it("asks for sign-in again for an expired login, without asking Anthropic", async () => {
    world.storeLogins([claudeLogin("work", { expires: Date.now() - 1 })]);
    const http = fakeHttp(() => ({}));
    const ctx = createProviderAvailabilityContext({
      providerIds: ["anthropic"],
      configOverrides: { anthropicBinaryPath: missingClaude() },
    });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    expect(fetched).toMatchObject({ rows: [], error: { code: "login_expired" } });
    expect(errorDebug(fetched)).toEqual([
      "[Claude work]: Anthropic sign-in expired. Run `opencode auth login anthropic`.",
    ]);
    expect(http).not.toHaveBeenCalled();
  });

  it("shows each login's rows, and a login OpenCode could not return as its error", async () => {
    const integration = createFakeIntegration([
      {
        integrationId: "anthropic",
        id: "failed-active",
        label: "default",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "old" },
        resolveError: "HTTP 500",
      },
      {
        integrationId: "anthropic",
        id: "valid",
        label: "Work",
        registered: true,
        method: "oauth",
        value: { type: "oauth", access: "valid" },
      },
    ]);
    const unbind = bindCredentialSource(createIntegrationCredentialSource(integration as never));
    const http = fakeHttp(() => ({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
    }));

    try {
      const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

      expect(rowSummary(fetched.rows)).toEqual([
        ["anthropic.five_hour", "Work", "5h", "five_hour", 80, null],
        ["anthropic.weekly", "Work", "Weekly", "week", 70, null],
      ]);
      expect(fetched.rowLogins).toEqual(["valid", "valid"]);
      expect(fetched.error).toMatchObject({ code: "login_expired" });
      expect(errorDebug(fetched)).toEqual([
        "[Claude] (active): Anthropic sign-in could not be read: refresh_failed: HTTP 500. Run `opencode auth login anthropic`.",
      ]);
      expect(http.mock.calls.map(([, init]) => requestHeader(init, "Authorization"))).toEqual([
        "Bearer valid",
      ]);
    } finally {
      unbind();
    }
  });

  it.runIf(POSIX)(
    "starts the Claude CLI for its details when Anthropic rejects a login",
    async () => {
      world.storeLogins([claudeLogin("work")]);
      const http = fakeHttp(() => new Response("revoked token-work", { status: 401 }));
      const claude = fakeClaude({ authenticated: false });

      const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: claude.path });

      expect(fetched).toMatchObject({
        rows: [],
        error: { code: "login_expired", detail: expect.stringContaining("[redacted]") },
      });
      expect(http).toHaveBeenCalledOnce();
      expect(claude.runs()).toEqual(["--version", "auth status --json"]);
      expect(fetched.debug).toEqual(
        expect.arrayContaining([
          { key: "cli_installed", value: "true" },
          { key: "auth_status", value: "unauthenticated" },
          { key: "quota_source", value: "(none)" },
        ]),
      );
    },
  );

  it("reports an empty 503 as a provider error, with its Retry-After", async () => {
    world.storeLogins([claudeLogin("work")]);
    fakeHttp(() => new Response("", { status: 503, headers: { "Retry-After": "60" } }));
    const before = Date.now();

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    expect(fetched.error).toMatchObject({ code: "provider_error", status: 503 });
    expect(fetched.error?.retryAtMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(errorDebug(fetched)).toEqual(["[Claude work]: Anthropic API returned 503"]);
  });

  it("passes the request timeout to the usage request", async () => {
    world.storeLogins([claudeLogin("work")]);
    fakeHttp(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );

    const fetched = await fetchRows(anthropicProvider, {
      anthropicBinaryPath: missingClaude(),
      requestTimeoutMs: 20,
    });

    expect(fetched.error).toMatchObject({ code: "timeout" });
  });

  it.each([
    ["anthropic/claude-sonnet-4-6", true],
    ["ANTHROPIC/claude-haiku-4-5", true],
    ["claude-code/claude-opus-5-5", true],
    ["CLAUDE-CODE/claude-sonnet-5-5", true],
    ["openai/gpt-5", false],
    ["copilot/claude-sonnet-4-5", false],
  ])("matches model id %s: %s", (model, expected) => {
    expect(anthropicProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    [["anthropic"], true, true],
    [["copilot", "anthropic"], true, true],
    [["claude-code"], true, false],
    [["claude"], true, false],
    [["anthropic"], false, false],
  ])(
    "with provider ids %j and a stored login=%s is available=%s",
    async (providerIds, hasLogin, expected) => {
      world.storeLogins(hasLogin ? [claudeLogin("work")] : []);
      const ctx = createProviderAvailabilityContext({
        providerIds,
        configOverrides: { anthropicBinaryPath: missingClaude() },
      });

      await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(expected);
    },
  );

  it("is not available when provider lookup throws", async () => {
    world.storeLogins([claudeLogin("work")]);
    const ctx = createProviderAvailabilityContext({ providersError: new Error("boom") });

    await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(false);
  });
});
