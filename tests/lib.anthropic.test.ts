import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const httpMocks = vi.hoisted(() => ({ fetchResponse: vi.fn() }));

/** The stored OpenCode logins as an auth map: at most one `anthropic` entry. */
const authMocks = vi.hoisted(() => ({ storedAuth: vi.fn() }));

const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn((_path: string) => false) }));

const identityMocks = vi.hoisted(() => ({
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string }) => `identity:${params.providerId}`,
  ),
}));

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAnthropicLogins } from "../src/lib/anthropic-auth.js";
import {
  anthropicLoginsIdentity,
  buildClaudeCommandInvocation,
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  parseOAuthUsageResponse,
  parseUsageResponse,
  queryAnthropicQuota,
} from "../src/lib/anthropic.js";
import { fetchWithTimeout } from "../src/lib/http.js";
import fableWeeklyUsage from "./fixtures/anthropic/fable-weekly.sanitized.json";

vi.mock("child_process", () => ({ execFile: vi.fn() }));

vi.mock("fs/promises", () => ({ readFile: vi.fn() }));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: fsMocks.existsSync,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: async (_ids: string[], options: { methods?: string[] } = {}) => {
    const entry = (await authMocks.storedAuth())?.anthropic;
    const method = entry?.type === "api" ? "key" : entry?.type;
    if (!entry || (options.methods && !options.methods.includes(method))) return [];
    const { resolveError, ...value } = entry;
    return [
      { id: "login-1", integrationId: "anthropic", label: "", active: true, value, resolveError },
    ];
  },
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(
    async (
      _url: string,
      options: { consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown },
    ) => {
      const response = await httpMocks.fetchResponse();
      return await options.consume(response, new AbortController().signal);
    },
  ),
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  ...identityMocks,
}));

type ExecSequenceStep = {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  errorMessage?: string;
  killed?: boolean;
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const NO_QUOTA_MESSAGE =
  "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.";
const CREDENTIALS_FILE = join(".claude", ".credentials.json");
const CLAUDE_INSTALL_FOLDER_CANDIDATES = [
  join(homedir(), ".claude", "local", "claude"),
  join(homedir(), ".local", "bin", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];
const CLI_VERSION: ExecSequenceStep = { stdout: "claude 1.2.3\n" };
const CLI_AUTHENTICATED: ExecSequenceStep = { stdout: JSON.stringify({ authenticated: true }) };
const CLI_MISSING: ExecSequenceStep = { code: "ENOENT", errorMessage: "spawn claude ENOENT" };
const USAGE_10_20 = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
const ENOENT_ERROR = Object.assign(new Error("missing credentials"), { code: "ENOENT" });

const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);
const storedAuthMock = authMocks.storedAuth;
const fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);
const fetchResponseMock = httpMocks.fetchResponse;
const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function mockExecSequence(steps: ExecSequenceStep[]): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const step = steps.shift();
    if (!step) {
      throw new Error("Unexpected execFile call");
    }

    const error =
      step.code === undefined
        ? null
        : Object.assign(new Error(step.errorMessage ?? `Command failed: ${String(step.code)}`), {
            code: step.code,
            killed: step.killed ?? false,
          });

    callback(error, step.stdout ?? "", step.stderr ?? "");
    return {} as never;
  });
}

function mockResponse(status: number, body: unknown, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function cliQuotaStatus(fiveHourUsed: number, sevenDayUsed: number): ExecSequenceStep {
  return {
    stdout: JSON.stringify({
      authenticated: true,
      quota: {
        five_hour: { used_percentage: fiveHourUsed },
        seven_day: { used_percentage: sevenDayUsed },
      },
    }),
  };
}

function keychainToken(accessToken: string): ExecSequenceStep {
  return { stdout: JSON.stringify({ claudeAiOauth: { accessToken } }) };
}

function authenticatedWithoutQuotaSteps(count: number): ExecSequenceStep[] {
  return Array.from({ length: count }, () => [CLI_VERSION, CLI_AUTHENTICATED]).flat();
}

function mockOpenCodeLogin(access: string, expires?: number): void {
  storedAuthMock.mockResolvedValue({
    anthropic: { type: "oauth", access, ...(expires === undefined ? {} : { expires }) },
  });
}

/** Linux, a signed-in Claude CLI without quota windows, and a credentials-file token. */
function setUpCredentialsFileFallback(probes: number, accessToken = "oauth-access-token"): void {
  setProcessPlatform("linux");
  mockExecSequence(authenticatedWithoutQuotaSteps(probes));
  readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken } }));
}

function useFakeNow(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
}

function bearerTokensSent(): string[] {
  return fetchWithTimeoutMock.mock.calls.map(
    ([, options]) => (options.request.headers as Record<string, string>)["Authorization"] ?? "",
  );
}

beforeEach(() => {
  storedAuthMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  execFileMock.mockReset();
  fsMocks.existsSync.mockReset();
  fsMocks.existsSync.mockReturnValue(false);
  readFileMock.mockReset();
  storedAuthMock.mockReset();
  fetchWithTimeoutMock.mockClear();
  fetchResponseMock.mockReset();
  clearAnthropicDiagnosticsCacheForTests();
  if (originalProcessPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }
});

describe("usage response parsing", () => {
  it.each([
    [
      "the current five_hour / seven_day response shape",
      {
        five_hour: { utilization: 57, resets_at: "2026-03-25T18:00:00.000Z" },
        seven_day: { utilization: 12, resets_at: "2026-04-01T00:00:00.000Z" },
      },
      43,
      88,
    ],
    [
      "nested quota roots and extra alias fields",
      {
        quota: {
          fiveHour: { usedPercent: "35", resetAt: "2026-03-25T18:00:00.000Z" },
          sevenDay: { percent_used: 15, resetsAt: "2026-04-01T00:00:00.000Z" },
        },
      },
      65,
      85,
    ],
  ])("parses %s", (_label, data, fiveHourRemaining, sevenDayRemaining) => {
    expect(parseUsageResponse(data)).toEqual({
      success: true,
      five_hour: { percentRemaining: fiveHourRemaining, resetTimeIso: "2026-03-25T18:00:00.000Z" },
      seven_day: { percentRemaining: sevenDayRemaining, resetTimeIso: "2026-04-01T00:00:00.000Z" },
    });
  });

  it("drops invalid reset timestamps and only caps percent remaining above 100", () => {
    const result = parseUsageResponse({
      usage: {
        five_hour: { used_percentage: 120, resets_at: "\u001b[31mbad-reset" },
        seven_day: { used_percent: -10, reset_at: "not-a-date" },
      },
    });

    expect(result?.five_hour).toEqual({ percentRemaining: -20, resetTimeIso: undefined });
    expect(result?.seven_day).toEqual({ percentRemaining: 100, resetTimeIso: undefined });
  });

  it.each([
    ["null", null],
    ["a string", "bad-shape"],
    [
      "an invalid window",
      { rate_limits: { five_hour: { used_percentage: "nope" }, seven_day: { utilization: 12 } } },
    ],
    ["a missing window", { rateLimits: { fiveHour: { used_percentage: 30 } } }],
  ])("returns null for %s", (_label, data) => {
    expect(parseUsageResponse(data)).toBeNull();
    expect(parseOAuthUsageResponse(data)).toBeNull();
  });

  it.each([
    { utilization: 37.8, percentRemaining: 62 },
    { utilization: 0, percentRemaining: 100 },
    { utilization: 100, percentRemaining: 0 },
  ])(
    "parses enabled extra usage at $utilization% as remaining quota",
    ({ utilization, percentRemaining }) => {
      const result = parseOAuthUsageResponse({
        five_hour: { utilization: 57 },
        seven_day: { utilization: 12 },
        extra_usage: { is_enabled: true, utilization },
      });

      expect(result?.extra_usage).toEqual({ percentRemaining });
    },
  );

  it.each([
    { extra_usage: undefined },
    { extra_usage: { is_enabled: false, utilization: 37 } },
    { extra_usage: { is_enabled: true, utilization: "not-a-number" } },
    { extra_usage: { is_enabled: true, utilization: 101 } },
    { extra_usage: { is_enabled: true, utilization: -1 } },
    { extra_usage: { is_enabled: true, used_percentage: 37 } },
    { extra_usage: { is_enabled: true, usedPercent: 37 } },
    { extra_usage: { is_enabled: true, utilization: "37" } },
    { extraUsage: { is_enabled: true, utilization: 37 } },
  ])("ignores disabled, invalid or aliased extra usage %j", (extra) => {
    const result = parseOAuthUsageResponse({
      five_hour: { utilization: 57 },
      seven_day: { utilization: 12 },
      ...extra,
    });

    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.extra_usage).toBeUndefined();
  });

  it("parses the exact Fable weekly_scoped window from a sanitized response", () => {
    expect(parseUsageResponse(fableWeeklyUsage)).not.toHaveProperty("fable_weekly");
    expect(parseOAuthUsageResponse(fableWeeklyUsage)).toEqual({
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      fable_weekly: { percentRemaining: 98, resetTimeIso: "2026-07-27T07:00:00.268Z" },
    });
  });

  it("keeps the existing windows when Fable scoped data is absent or malformed", () => {
    const withoutFable = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        { kind: "weekly_scoped", percent: 40, scope: { model: { display_name: "Opus" } } },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Claude Fable 5" } },
        },
        {
          kind: "weekly_scoped",
          percent: "not-a-number",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });

    expect(withoutFable).toEqual({
      success: true,
      five_hour: { percentRemaining: 80, resetTimeIso: undefined },
      seven_day: { percentRemaining: 70, resetTimeIso: undefined },
    });
  });

  it("accepts a zero-percent Fable window without a reset timestamp", () => {
    const result = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 0,
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
          is_active: false,
        },
      ],
    });

    expect(result?.fable_weekly).toEqual({ percentRemaining: 100, resetTimeIso: undefined });
  });
});

describe("buildClaudeCommandInvocation", () => {
  const windows = { platform: "win32" as const, comspec: "C:\\Windows\\System32\\cmd.exe" };

  it.each([
    [
      "wraps shim-based installs in cmd.exe",
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      ["auth", "status", "--json"],
      {
        file: "C:\\Windows\\System32\\cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          '"C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json"',
        ],
        display: "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd auth status --json",
      },
    ],
    [
      "keeps PATH-based commands behind cmd.exe",
      "claude.exe",
      ["--version"],
      {
        file: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", '"claude.exe" "--version"'],
        display: "claude.exe --version",
      },
    ],
    [
      "executes configured .exe paths directly",
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      {
        file: "C:/Users/alice/.local/bin/claude.exe",
        args: ["auth", "status", "--json"],
        display: "C:/Users/alice/.local/bin/claude.exe auth status --json",
      },
    ],
  ])("on Windows %s", (_label, binaryPath, args, expected) => {
    expect(buildClaudeCommandInvocation(binaryPath, args, windows)).toEqual(expected);
  });
});

describe("Claude CLI probe", () => {
  it("returns quota from Claude auth status JSON run from PATH, with no account identity", async () => {
    mockExecSequence([
      CLI_VERSION,
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 57, resets_at: "2026-03-25T18:00:00.000Z" },
            seven_day: { usedPercentage: 12, resetsAt: "2026-04-01T00:00:00.000Z" },
            extra_usage: { is_enabled: true, utilization: 37.8 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.binaryPath).toBe("claude (PATH)");
    expect(diagnostics.checkedCommands).toEqual(["claude --version", "claude auth status --json"]);
    expect(diagnostics.quota?.extra_usage).toBeUndefined();
    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: true,
      five_hour: { percentRemaining: 43 },
      seven_day: { percentRemaining: 88 },
    });
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    // Claude CLI quota does not expose an account, so it must stay uncached.
    await expect(anthropicLoginsIdentity([])).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("probes configured Windows Claude .exe paths without cmd wrapping", async () => {
    setProcessPlatform("win32");
    mockExecSequence([{ stdout: "2.1.123 (Claude Code)\n" }, cliQuotaStatus(10, 20)]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " C:/Users/alice/.local/bin/claude.exe ",
    });

    expect(diagnostics.version).toBe("2.1.123");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe("C:/Users/alice/.local/bin/claude.exe");
    expect(execFileMock.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ["C:/Users/alice/.local/bin/claude.exe", ["--version"]],
      ["C:/Users/alice/.local/bin/claude.exe", ["auth", "status", "--json"]],
    ]);
  });

  it("uses the first install folder that has claude when it is not on PATH", async () => {
    setProcessPlatform("linux");
    const [claudeLocal = "", localBin = ""] = CLAUDE_INSTALL_FOLDER_CANDIDATES;
    fsMocks.existsSync.mockImplementation(
      (path) => path === localBin || path === "/usr/local/bin/claude",
    );
    mockExecSequence([CLI_MISSING, { stdout: "2.1.0 (Claude Code)\n" }, cliQuotaStatus(10, 20)]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual([claudeLocal, localBin]);
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("2.1.0");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe(localBin);
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      buildClaudeCommandInvocation(localBin, ["--version"]).display,
      buildClaudeCommandInvocation(localBin, ["auth", "status", "--json"]).display,
    ]);
    expect(execFileMock.mock.calls[2]?.slice(0, 2)).toEqual([
      localBin,
      ["auth", "status", "--json"],
    ]);
  });

  it.each([
    [
      "the default claude on Linux, after checking the install folders",
      "linux",
      undefined,
      "claude --version",
      CLAUDE_INSTALL_FOLDER_CANDIDATES,
      `Claude CLI (\`claude\`) is not installed or not on PATH. Also checked: ${CLAUDE_INSTALL_FOLDER_CANDIDATES.join(", ")}.`,
    ],
    [
      "the default claude on Windows, without install folders",
      "win32",
      undefined,
      "claude --version",
      [],
      "Claude CLI (`claude`) is not installed or not on PATH.",
    ],
    [
      "a configured binary path, without install folders",
      "linux",
      " /Applications/Claude Code.app/Contents/MacOS/claude ",
      '"/Applications/Claude Code.app/Contents/MacOS/claude" --version',
      [],
      "Claude CLI (`/Applications/Claude Code.app/Contents/MacOS/claude`) is not installed or not on PATH.",
    ],
  ] as const)(
    "reports a missing Claude CLI for %s",
    async (_label, platform, binaryPath, checkedCommand, installFoldersChecked, message) => {
      setProcessPlatform(platform);
      mockExecSequence([CLI_MISSING]);

      const diagnostics = await getAnthropicDiagnostics({ binaryPath });

      expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual(installFoldersChecked);
      expect(diagnostics).toEqual({
        installed: false,
        version: null,
        authStatus: "unknown",
        quotaSupported: false,
        quotaSource: "none",
        binaryPath: null,
        checkedCommands: [checkedCommand],
        message,
      });
      await expect(hasAnthropicCredentialsConfigured({ binaryPath })).resolves.toBe(false);
      await expect(queryAnthropicQuota({ binaryPath })).resolves.toBeNull();
    },
  );

  it("reports unauthenticated Claude CLI status without reading OAuth credentials", async () => {
    mockExecSequence([
      CLI_VERSION,
      { code: 1, stderr: "Not logged in. Run `claude auth login` to continue." },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("unauthenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude auth login");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("falls back to plain auth status when --json is unsupported", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "Claude CLI version 1.2.3\n" },
      { code: 1, stderr: "unexpected argument '--json'" },
      { stdout: "Authenticated" },
    ]);
    readFileMock.mockRejectedValue(ENOENT_ERROR);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      "claude auth status --json",
      "claude auth status",
    ]);
    expect(diagnostics.message).toContain(NO_QUOTA_MESSAGE);
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
  });

  it.each([
    ["sanitizes unexpected output", { code: 1, stderr: "bad\u001b[31m-output" }, "bad-output"],
    [
      "reports a timeout",
      { code: "ETIMEDOUT", killed: true, errorMessage: "spawn claude ETIMEDOUT" },
      "Timed out while running Claude CLI auth status.",
    ],
  ])("%s from the auth status probe", async (_label, authStatusStep, expectedMessage) => {
    mockExecSequence([CLI_VERSION, authStatusStep]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.message).toContain(expectedMessage);
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("returns a sanitized error result when the CLI probe throws unexpectedly", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("probe \u001b[31mboom");
    });

    const result = await queryAnthropicQuota();
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toContain("Claude CLI probe failed");
      expect(result.error).toContain("probe boom");
      expect(result.error).not.toContain("\u001b");
    }
  });

  it("caches fallback-backed diagnostics until the test helper clears the cache", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "token-1" } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "token-2" } }));
    fetchResponseMock
      .mockResolvedValueOnce(
        mockResponse(200, {
          usage: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
        }),
      )
      .mockResolvedValueOnce(
        mockResponse(200, {
          usage: { five_hour: { used_percentage: 30 }, seven_day: { used_percentage: 40 } },
        }),
      );

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quotaSource).toBe("claude-credentials-oauth-api");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    clearAnthropicDiagnosticsCacheForTests();

    const third = await getAnthropicDiagnostics();
    expect(third.quota?.five_hour.percentRemaining).toBe(70);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });
});

describe("OAuth credential sources", () => {
  it("uses OpenCode Anthropic OAuth when Claude CLI is unavailable", async () => {
    mockExecSequence([CLI_MISSING]);
    mockOpenCodeLogin("opencode-access-token", Date.now() + 60_000);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, { five_hour: { utilization: 20 }, seven_day: { utilization: 30 } }),
    );

    // The availability check trusts the OpenCode login without spawning the CLI.
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(false);
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("opencode-auth-oauth-api");
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(80);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(70);
    await expect(queryAnthropicQuota()).resolves.toMatchObject({ success: true });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("reports an OpenCode OAuth failure when Claude CLI is unavailable", async () => {
    mockExecSequence([CLI_MISSING]);
    mockOpenCodeLogin("opencode-access-token", Date.now() + 60_000);
    fetchResponseMock.mockResolvedValue(mockResponse(429, "rate limited", "30"));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.message).toContain("Anthropic API error 429: rate limited");

    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Anthropic API error 429: rate limited"),
    });
  });

  it("falls back to Claude OAuth usage when local Claude auth omits quota windows", async () => {
    setUpCredentialsFileFallback(1);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        ...fableWeeklyUsage,
        extra_usage: { is_enabled: true, utilization: 37.8 },
      }),
    );

    // Availability stays local-only: no credential read or usage request.
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota).toEqual({
      success: true,
      five_hour: { percentRemaining: 58, resetTimeIso: "2026-07-21T14:10:00.268Z" },
      seven_day: { percentRemaining: 72, resetTimeIso: "2026-07-27T07:00:00.268Z" },
      extra_usage: { percentRemaining: 62 },
      fable_weekly: { percentRemaining: 98, resetTimeIso: "2026-07-27T07:00:00.268Z" },
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer oauth-access-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });
    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: true,
      fable_weekly: { percentRemaining: 98 },
    });
  });

  it("prefers OpenCode's own Anthropic OAuth credentials over Claude Code credentials", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([CLI_VERSION, CLI_AUTHENTICATED]);
    mockOpenCodeLogin("opencode-access-token", Date.now() + 60_000);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        five_hour: { utilization: 20, resets_at: "2026-03-25T18:00:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-04-01T00:00:00.000Z" },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("opencode-auth-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(80);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(70);
    expect(bearerTokensSent()).toEqual(["Bearer opencode-access-token"]);
    // Neither the Keychain (a third command) nor the credentials file was read.
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it.each([
    ["has no Anthropic login", null],
    [
      "has an expired OAuth token",
      {
        anthropic: {
          type: "oauth",
          access: "expired-opencode-token",
          expires: Date.now() - 60_000,
        },
      },
    ],
    ["has only an API key", { anthropic: { type: "api", key: "sk-ant-api-key" } }],
  ])("uses the macOS Keychain token when OpenCode %s", async (_label, opencodeAuth) => {
    setProcessPlatform("darwin");
    mockExecSequence([
      CLI_VERSION,
      CLI_AUTHENTICATED,
      keychainToken("oauth-access-token-from-keychain"),
    ]);
    storedAuthMock.mockResolvedValue(opencodeAuth);
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        oauth_usage: {
          fiveHour: { usedPercent: 25, resetAt: "2026-03-25T18:00:00.000Z" },
          sevenDay: { usedPercent: 40, resetAt: "2026-04-01T00:00:00.000Z" },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.oauthCredentialSource).toBe("claude-credentials");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(75);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(60);
    expect(bearerTokensSent()).toEqual(["Bearer oauth-access-token-from-keychain"]);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("falls back to the Claude credentials file when the macOS Keychain entry is unusable", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      CLI_VERSION,
      CLI_AUTHENTICATED,
      { stdout: JSON.stringify({ claudeAiOauth: {} }) },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token-from-file" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockResponse(200, {
        usage: { five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 } },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(95);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(90);
    expect(bearerTokensSent()).toEqual(["Bearer oauth-access-token-from-file"]);
  });

  it("falls back to Claude credentials when OpenCode OAuth is rejected", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([CLI_VERSION, CLI_AUTHENTICATED, keychainToken("claude-keychain-token")]);
    mockOpenCodeLogin("revoked-opencode-token", Date.now() + 60_000);
    // The 401 body read times out; a rejected token still triggers the fallback.
    fetchWithTimeoutMock.mockImplementationOnce(async (_url, options) => {
      const controller = new AbortController();
      controller.abort();
      return await options.consume(
        {
          ok: false,
          status: 401,
          text: vi.fn().mockRejectedValue(new Error("timed out while reading body")),
        } as unknown as Response,
        controller.signal,
      );
    });
    fetchResponseMock.mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.oauthCredentialSource).toBe("claude-credentials");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(90);
    expect(bearerTokensSent()).toEqual([
      "Bearer revoked-opencode-token",
      "Bearer claude-keychain-token",
    ]);
  });

  it("keeps and reports the first usable credential when the usage endpoint rate limits it", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([CLI_VERSION, CLI_AUTHENTICATED]);
    mockOpenCodeLogin("opencode-access-token");
    fetchResponseMock.mockResolvedValue(
      mockResponse(429, JSON.stringify({ error: { type: "rate_limit_error" } })),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no credentials file on Linux", "linux", [], ENOENT_ERROR, [CREDENTIALS_FILE]],
    [
      "neither a Keychain entry nor a credentials file on macOS",
      "darwin",
      [{ code: 44, stderr: "The specified item could not be found in the keychain." }],
      ENOENT_ERROR,
      ["Claude Code-credentials", CREDENTIALS_FILE],
    ],
    [
      "a malformed access token",
      "linux",
      [],
      JSON.stringify({ claudeAiOauth: { accessToken: 123 } }),
      ["Claude OAuth access token missing"],
    ],
  ] as const)(
    "explains missing quota when Claude CLI is signed in but there is %s",
    async (_label, platform, keychainSteps, credentialsFile, expectedDetails) => {
      setProcessPlatform(platform);
      mockExecSequence([CLI_VERSION, CLI_AUTHENTICATED, ...keychainSteps]);
      if (credentialsFile instanceof Error) readFileMock.mockRejectedValue(credentialsFile);
      else readFileMock.mockResolvedValue(credentialsFile);

      const diagnostics = await getAnthropicDiagnostics();
      expect(diagnostics.installed).toBe(true);
      expect(diagnostics.authStatus).toBe("authenticated");
      expect(diagnostics.quotaSupported).toBe(false);
      expect(diagnostics.quotaSource).toBe("none");
      expect(diagnostics.message).toContain(NO_QUOTA_MESSAGE);
      for (const detail of expectedDetails) expect(diagnostics.message).toContain(detail);

      await expect(queryAnthropicQuota()).resolves.toEqual({
        success: false,
        error: diagnostics.message,
      });
      expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    },
  );
});

describe("OAuth usage request", () => {
  it.each([
    [
      "invalid JSON",
      () => {
        const response = mockResponse(200, "{");
        vi.mocked(response.json).mockRejectedValue(new Error("invalid json"));
        return response;
      },
      "Failed to parse Anthropic quota response",
    ],
    [
      "an unexpected JSON shape",
      () => mockResponse(200, { ok: true }),
      "Unexpected Anthropic quota response shape",
    ],
  ])("returns no quota when the API returns %s", async (_label, response, expectedMessage) => {
    setUpCredentialsFileFallback(1);
    fetchResponseMock.mockResolvedValue(response());

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain(expectedMessage);
    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(expectedMessage),
    });
  });

  it("honors Retry-After delta-seconds, redacts the token and suppresses repeated requests", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(3, "oauth-secret-token");
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "rate limited oauth-\u001b[31msecret-token", "45"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("Anthropic API error 429: rate limited [redacted]");
    expect(first.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 45s.",
    );
    expect(first.message).not.toContain("oauth-secret-token");
    expect(first.message).not.toContain("\u001b");

    await vi.advanceTimersByTimeAsync(5_001);
    const suppressed = await getAnthropicDiagnostics();
    expect(suppressed.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 40s.",
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(40_000);
    const retried = await getAnthropicDiagnostics();
    expect(retried.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("redacts an access token reconstructed while sanitizing a request error", async () => {
    setUpCredentialsFileFallback(1, "oauth-secret-token");
    fetchResponseMock.mockRejectedValue(
      new Error("request failed for oauth-\u001b[31msecret-token"),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.message).toContain("request failed for [redacted]");
    expect(diagnostics.message).not.toContain("oauth-secret-token");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it.each([
    ["a future HTTP date", "Fri, 10 Jul 2026 12:02:00 GMT", "120s"],
    ["missing", undefined, "30s"],
    ["invalid", "30junk", "30s"],
    ["negative", "-1", "30s"],
    ["zero", "0", "30s"],
    ["a past date", "Thu, 09 Jul 2026 12:00:00 GMT", "30s"],
    ["over fifteen minutes", "3600", "900s"],
  ])("pauses the probe for a %s Retry-After", async (_label, retryAfter, expectedRetry) => {
    useFakeNow();
    setUpCredentialsFileFallback(2);
    fetchResponseMock.mockResolvedValue(mockResponse(429, "rate limited", retryAfter));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain(`retry in ${expectedRetry}.`);

    await vi.advanceTimersByTimeAsync(5_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "cannot be read",
      false,
      undefined,
      "Anthropic API returned 429 Anthropic OAuth usage probe paused after HTTP 429; retry in 30s.",
      "retry in 25s.",
    ],
    ["times out", true, "45", "body stalled", "retry in 40s."],
  ])(
    "establishes a cooldown when the 429 response body %s",
    async (_label, bodyReadTimesOut, retryAfter, firstMessage, suppressedMessage) => {
      useFakeNow();
      setUpCredentialsFileFallback(2);
      const response = mockResponse(429, "rate limited", retryAfter);
      vi.mocked(response.text).mockRejectedValue(new Error("body stalled"));
      fetchWithTimeoutMock.mockImplementationOnce(async (_url, options) => {
        const controller = new AbortController();
        if (bodyReadTimesOut) controller.abort();
        return await options.consume(response, controller.signal);
      });

      const first = await getAnthropicDiagnostics();
      expect(first.message).toContain(firstMessage);

      await vi.advanceTimersByTimeAsync(5_001);
      const suppressed = await getAnthropicDiagnostics();
      expect(suppressed.message).toContain(suppressedMessage);
      expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    },
  );

  it("increases fallback backoff for consecutive 429 responses", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(4);
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "first"))
      .mockResolvedValueOnce(mockResponse(429, "second"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    const second = await getAnthropicDiagnostics();
    expect(second.message).toContain("retry in 60s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("resets the backoff sequence after a non-429 response", async () => {
    useFakeNow();
    setUpCredentialsFileFallback(4);
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "first"))
      .mockResolvedValueOnce(mockResponse(500, "server\u001b[31m error"))
      .mockResolvedValueOnce(mockResponse(429, "second"))
      .mockResolvedValueOnce(mockResponse(500, "server error"));

    await getAnthropicDiagnostics();
    await vi.advanceTimersByTimeAsync(30_001);
    const serverError = await getAnthropicDiagnostics();
    expect(serverError.message).toContain("Anthropic API error 500: server error");
    expect(serverError.message).not.toContain("\u001b");
    await vi.advanceTimersByTimeAsync(5_001);
    const second429 = await getAnthropicDiagnostics();
    expect(second429.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(4);
  });

  it("retains the Claude credential cooldown while retrying a rejected OpenCode token", async () => {
    useFakeNow();
    setProcessPlatform("darwin");
    mockExecSequence([
      CLI_VERSION,
      CLI_AUTHENTICATED,
      keychainToken("claude-keychain-token"),
      CLI_VERSION,
      CLI_AUTHENTICATED,
      keychainToken("claude-keychain-token"),
    ]);
    mockOpenCodeLogin("revoked-opencode-token", Date.now() + 120_000);
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(401, "revoked"))
      .mockResolvedValueOnce(mockResponse(429, "rate limited", "30"))
      .mockResolvedValueOnce(mockResponse(401, "revoked"));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_001);
    const second = await getAnthropicDiagnostics();
    expect(second.message).toContain("retry in 25s.");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent OAuth usage requests for the same observed token", async () => {
    setUpCredentialsFileFallback(2);
    let resolveFetch!: (response: Response) => void;
    fetchResponseMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = getAnthropicDiagnostics({ binaryPath: "claude-a" });
    const second = getAnthropicDiagnostics({ binaryPath: "claude-b" });
    await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1));
    resolveFetch(mockResponse(200, USAGE_10_20));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.quotaSupported).toBe(true);
    expect(secondResult.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply an old token cooldown to a newly observed token", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "old-token" } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "new-token" } }));
    fetchResponseMock
      .mockResolvedValueOnce(mockResponse(429, "rate limited", "900"))
      .mockResolvedValueOnce(mockResponse(200, USAGE_10_20));

    const first = await getAnthropicDiagnostics({ binaryPath: "claude-a" });
    expect(first.quotaSupported).toBe(false);
    const second = await getAnthropicDiagnostics({ binaryPath: "claude-b" });
    expect(second.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });
});

describe("anthropicLoginsIdentity", () => {
  async function identity() {
    return anthropicLoginsIdentity(await readAnthropicLogins());
  }

  it("derives identity from the OpenCode logins, without asking the Claude CLI", async () => {
    mockOpenCodeLogin("opencode-access-secret");

    const resolved = await identity();

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:opencode-auth",
      principal: { kind: "credential", value: "opencode-access-secret" },
    });
    expect(JSON.stringify(resolved)).not.toContain("opencode-access-secret");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("counts an OpenCode login it could not read as present but derives no identity from it", async () => {
    mockExecSequence([CLI_MISSING]);
    storedAuthMock.mockResolvedValue({
      anthropic: { type: "oauth", resolveError: "refresh_failed: HTTP 500" },
    });

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    await expect(identity()).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("derives identity from Claude's credentials without OpenCode logins", async () => {
    setUpCredentialsFileFallback(1, "claude-access-secret");

    const resolved = await identity();

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:claude-credentials",
      principal: { kind: "credential", value: "claude-access-secret" },
    });
    expect(resolved).not.toContain("claude-access-secret");
  });
});
