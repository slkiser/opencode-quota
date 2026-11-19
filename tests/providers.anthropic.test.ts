/**
 * Claude through the provider world: logins in a temp `opencode.db`, fake HTTP, and a fake
 * `claude` script (POSIX only) that records each run. Claude's own Keychain and credentials
 * file are never reached: every fake CLI either reports quota or is signed out.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clearAnthropicDiagnosticsCacheForTests } from "../src/lib/anthropic.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
} from "../src/lib/opencode-auth.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import fableWeeklyUsage from "./fixtures/anthropic/fable-weekly.sanitized.json";
import noFiveHourUsage from "./fixtures/anthropic/no-five-hour-limit.sanitized.json";
import noWeeklyLimitUsage from "./fixtures/anthropic/no-weekly-limit.sanitized.json";
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

  it("shows no 5h row for a plan without a 5-hour limit", async () => {
    world.storeLogins([claudeLogin("work")]);
    fakeHttp(() => noFiveHourUsage);

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    const reset = "2026-11-06T19:59:59.979Z";
    expect(rowSummary(fetched.rows)).toEqual([
      ["anthropic.weekly", "work", "Weekly", "week", 67, reset],
      ["anthropic.weekly_fable", "work", "Fable", "week", 100, reset],
    ]);
    expect(fetched.debug).toContainEqual({ key: "quota_supported", value: "true" });
  });

  it("shows no Weekly row for a plan without a weekly limit", async () => {
    world.storeLogins([claudeLogin("work")]);
    fakeHttp(() => noWeeklyLimitUsage);

    const fetched = await fetchRows(anthropicProvider, { anthropicBinaryPath: missingClaude() });

    expect(rowSummary(fetched.rows)).toEqual([
      ["anthropic.five_hour", "work", "5h", "five_hour", 88, FIVE_HOUR_RESET],
      ["anthropic.extra_usage", "work", "Extra usage", "month", 75, null],
      ["anthropic.weekly_fable", "work", "Fable", "week", 98, WEEKLY_RESET],
    ]);
    expect(fetched.debug).toContainEqual({ key: "quota_supported", value: "true" });
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
    ["claude-agent/opus", true],
    ["claude-code-default/claude-sonnet-5-5", true],
    ["claude-code-work/claude-sonnet-5-5@work", true],
    ["claude-code-/claude-sonnet-5-5", false],
    ["openai/gpt-5", false],
    ["copilot/claude-sonnet-4-5", false],
  ])("matches model id %s: %s", (model, expected) => {
    expect(anthropicProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    [["anthropic"], true, true],
    [["copilot", "anthropic"], true, true],
    [["claude-code"], true, false],
    [["claude-agent"], true, false],
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

describe("Claude Code plugin account readings", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const hour = 3_600_000;
  const reading = (utilization: number | null, resetsAt = now + hour, observedAt = now - 1000) => ({
    utilization,
    resetsAt,
    observedAt,
    status: "allowed",
    noted: [],
  });
  const usage = () => ({
    version: 1,
    accounts: {
      default: { five_hour: reading(0.2), seven_day: reading(0.4, now + 7 * 24 * hour) },
      work: { five_hour: reading(0.7), seven_day: { ...reading(null), status: "rejected" } },
      historical: { five_hour: reading(0.1) },
    },
    known: { historical: { at: now } },
    logins: { historical: { expiresAt: now + hour } },
  });
  const usagePath = () =>
    join(process.env.XDG_STATE_HOME!, "opencode-claude-code-plugin", "account-usage.json");
  const writeUsage = (content: unknown, path = usagePath()) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  };
  const context = (
    currentProviderID = "claude-code-work",
    providerIds = ["claude-code-default", "claude-code-work", "openai"],
  ) =>
    createProviderAvailabilityContext({
      providerIds,
      configOverrides: {
        currentProviderID,
        anthropicBinaryPath: missingClaude(),
      },
    });
  const fetchPluginRows = (ctx = context()) =>
    fetchRows({ id: "anthropic", fetch: () => anthropicProvider.fetch(ctx) });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it.each(["claude-code-work", "openai"])(
    "shows only configured named accounts when %s is selected",
    async (selected) => {
      writeUsage(usage());
      const http = fakeHttp(() => ({}));
      const readRows = vi.fn(async () => {
        throw new Error("must not read credentials");
      });
      const unbind = bindCredentialSource({ kind: "opencode-integration-api", readRows });
      try {
        const ctx = context(selected);
        await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
        const policy = anthropicProvider.cachePolicy;
        if (policy.kind !== "resolved-auth") throw new Error("wrong cache policy");
        await policy.resolveIdentity(ctx, {});
        const scope = await policy.resolveScope?.(ctx);
        expect(scope).not.toBe("claude-code");
        expect(scope).not.toBe("opencode-auth");
        const fetched = await fetchPluginRows(ctx);
        expect(
          fetched.rows.map((row) => [row.id, row.account, row.percentRemaining, row.text]),
        ).toEqual([
          ["anthropic.five_hour", "Default", 80, undefined],
          ["anthropic.weekly", "Default", 60, undefined],
          ["anthropic.five_hour", "Work", 30, undefined],
          ["anthropic.weekly", "Work", 0, undefined],
        ]);
        expect(fetched.rows[0]).toMatchObject({
          method: "local_cli",
          authority: "provider_reported",
        });
        expect(readRows).not.toHaveBeenCalled();
        expect(http).not.toHaveBeenCalled();
      } finally {
        unbind();
      }
    },
  );

  it.runIf(POSIX)(
    "does not start Claude for availability, identity or reading plugin data",
    async () => {
      writeUsage(usage());
      const claude = fakeClaude(CLI_QUOTA);
      const ctx = context();
      ctx.config.anthropicBinaryPath = claude.path;
      await anthropicProvider.isAvailable(ctx);
      if (anthropicProvider.cachePolicy.kind === "resolved-auth") {
        await anthropicProvider.cachePolicy.resolveIdentity(ctx, {});
      }
      await fetchPluginRows(ctx);
      expect(claude.runs()).toEqual([]);
    },
  );

  it.each(["openai", undefined])(
    "keeps a listed anthropic login's quota when %s is selected",
    async (selected) => {
      writeUsage(usage());
      world.storeLogins([claudeLogin("legacy")]);
      fakeHttp(() => noWeeklyLimitUsage);
      const ctx = createProviderAvailabilityContext({
        providerIds: ["anthropic", "claude-code-default", "claude-code-work", "openai"],
        configOverrides: {
          ...(selected ? { currentProviderID: selected } : {}),
          anthropicBinaryPath: missingClaude(),
        },
      });
      await expect(anthropicProvider.isAvailable(ctx)).resolves.toBe(true);
      const fetched = await fetchPluginRows(ctx);
      expect(fetched.rows.length).toBeGreaterThan(0);
      expect(fetched.rows.every((row) => row.account === "legacy")).toBe(true);
      expect(fetched.debug).toContainEqual({
        key: "quota_source",
        value: "opencode-auth-oauth-api",
      });
      await expect(anthropicProvider.usageAccounts?.(ctx)).resolves.toBeUndefined();
    },
  );

  it("shows named accounts over a listed anthropic login when a named account is selected", async () => {
    writeUsage(usage());
    world.storeLogins([claudeLogin("legacy")]);
    const http = fakeHttp(() => ({}));
    const ctx = context("claude-code-work", [
      "anthropic",
      "claude-code-default",
      "claude-code-work",
      "openai",
    ]);
    const fetched = await fetchPluginRows(ctx);
    expect(fetched.rows.map((row) => row.account)).toEqual(["Default", "Default", "Work", "Work"]);
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ["is not listed", () => context("claude-code-gone", ["anthropic"])],
    [
      "cannot be listed",
      () =>
        createProviderAvailabilityContext({
          providersError: new Error("boom"),
          configOverrides: {
            currentProviderID: "claude-code-work",
            anthropicBinaryPath: missingClaude(),
          },
        }),
    ],
  ])("never falls back to stored logins when the selected named account %s", async (_, ctx) => {
    world.storeLogins([claudeLogin("legacy")]);
    const http = fakeHttp(() => ({}));
    const selected = ctx();
    await expect(anthropicProvider.isAvailable(selected)).resolves.toBe(false);
    expect((await fetchPluginRows(selected)).rows).toEqual([]);
    expect(http).not.toHaveBeenCalled();
  });

  it.each([
    ["a future reading time", { observedAt: now + 1000 }],
    ["a malformed status", { status: "Allowed!" }],
    ["an invalid reset time", { resetsAt: "soon" }],
    ["a missing utilization", { utilization: undefined, status: "rejected" }],
    ["no utilization while allowed", { utilization: null }],
  ])("ignores a reading with %s", async (_, change) => {
    const data = usage();
    Object.assign(data.accounts.default.five_hour, change);
    writeUsage(data);
    const rows = (await fetchPluginRows()).rows;
    expect(rows.map((row) => [row.id, row.account])).toEqual([
      ["anthropic.weekly", "Default"],
      ["anthropic.five_hour", "Work"],
      ["anthropic.weekly", "Work"],
    ]);
  });

  it("names the account each OpenCode provider uses while plugin accounts show", async () => {
    await expect(anthropicProvider.usageAccounts?.(context())).resolves.toEqual({
      "claude-code-default": "Default",
      "claude-code-work": "Work",
      "claude-code": "Default",
      "claude-agent": "Default",
    });
    await expect(
      anthropicProvider.usageAccounts?.(
        context("claude-agent", ["claude-agent", "claude-code-work"]),
      ),
    ).resolves.toBeUndefined();
  });

  it("leaves the plugin's usage, login and warning state untouched", async () => {
    writeUsage(usage());
    const before = readFileSync(usagePath(), "utf8");
    const ctx = context();
    await anthropicProvider.isAvailable(ctx);
    await fetchPluginRows(ctx);
    expect(readFileSync(usagePath(), "utf8")).toBe(before);
  });

  it("changes scope with the path of the plugin's file", async () => {
    const ctx = context();
    const policy = anthropicProvider.cachePolicy;
    if (policy.kind !== "resolved-auth") throw new Error("wrong cache policy");
    const scope = await policy.resolveScope?.(ctx);
    process.env.XDG_STATE_HOME = join(world.root, "other-state");
    expect(await policy.resolveScope?.(ctx)).not.toBe(scope);
  });

  it("has no rows for missing, malformed or unsupported files, never a login fallback", async () => {
    const ctx = context();
    const http = fakeHttp(() => ({}));
    world.storeLogins([claudeLogin("legacy")]);
    for (const content of [undefined, "{", { ...usage(), version: 2 }]) {
      if (content === undefined) rmSync(usagePath(), { force: true });
      else writeUsage(content);
      const fetched = await fetchPluginRows(ctx);
      expect(fetched.rows).toEqual([]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toContainEqual({
        key: "quota_source",
        value: "claude-code-plugin-account-usage",
      });
    }
    expect(http).not.toHaveBeenCalled();
  });

  it("expires reset windows independently and bounds untimed and old readings", async () => {
    const data = usage();
    data.accounts.default.five_hour = reading(0.2, now);
    data.accounts.work.five_hour = reading(0.3, now + hour, now - 9 * 24 * hour);
    writeUsage(data);
    expect(
      (await fetchPluginRows()).rows.map((row) => [row.id, row.account, row.percentRemaining]),
    ).toEqual([
      ["anthropic.weekly", "Default", 60],
      ["anthropic.weekly", "Work", 0],
    ]);
    writeUsage({
      version: 1,
      accounts: {
        default: {
          five_hour: { utilization: 0.1, observedAt: now - 5 * hour, status: "allowed" },
          seven_day: { utilization: 0.2, observedAt: now - hour, status: "allowed" },
        },
      },
    });
    const rows = (await fetchPluginRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "anthropic.weekly", percentRemaining: 80 });
  });

  it("uses the producer's home-state fallback without reading real user state", async () => {
    const home = join(world.root, "home");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_STATE_HOME;
    writeUsage(usage(), join(home, ".local/state/opencode-claude-code-plugin/account-usage.json"));
    expect((await fetchPluginRows()).rows[0]?.percentRemaining).toBe(80);
  });

  it.runIf(POSIX)(
    "keeps anthropic, claude-code and claude-agent selections on their own sources",
    async () => {
      writeUsage(usage());
      world.storeLogins([claudeLogin("legacy")]);
      fakeHttp(() => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }));
      const claude = fakeClaude(CLI_QUOTA);
      for (const id of ["anthropic", "claude-code", "claude-agent"]) {
        const ctx = context(id, [id, "claude-code-work"]);
        ctx.config.anthropicBinaryPath = claude.path;
        const fetched = await fetchPluginRows(ctx);
        expect(fetched.rows[0]?.id, JSON.stringify(fetched)).toBe("anthropic.five_hour");
        expect(fetched.rows[0]?.percentRemaining).toBe(id === "anthropic" ? 90 : 43);
      }
    },
  );
});
