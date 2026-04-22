import { afterEach, describe, expect, it, vi } from "vitest";

import { execFile } from "child_process";
import { readFile } from "fs/promises";

import { fetchWithTimeout } from "../src/lib/http.js";
import {
  buildClaudeCommandInvocation,
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  hasAnthropicCredentialsConfigured,
  parseUsageResponse,
  queryAnthropicQuota,
} from "../src/lib/anthropic.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

type ExecSequenceStep = {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  errorMessage?: string;
  killed?: boolean;
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);
const fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);
const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
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

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function mockInvalidJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockRejectedValue(new Error("invalid json")),
    text: vi.fn().mockResolvedValue("{"),
  } as unknown as Response;
}

afterEach(() => {
  execFileMock.mockReset();
  readFileMock.mockReset();
  fetchWithTimeoutMock.mockReset();
  clearAnthropicDiagnosticsCacheForTests();
  if (originalProcessPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }
});

describe("parseUsageResponse", () => {
  it("parses the current five_hour / seven_day response shape", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 57, resets_at: "2026-03-25T18:00:00.000Z" },
      seven_day: { utilization: 12, resets_at: "2026-04-01T00:00:00.000Z" },
    });

    expect(result).not.toBeNull();
    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses nested quota roots and extra alias fields", () => {
    const result = parseUsageResponse({
      quota: {
        fiveHour: { usedPercent: "35", resetAt: "2026-03-25T18:00:00.000Z" },
        sevenDay: { percent_used: 15, resetsAt: "2026-04-01T00:00:00.000Z" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(65);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(85);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("drops invalid reset timestamps and clamps percent remaining", () => {
    const result = parseUsageResponse({
      usage: {
        five_hour: { used_percentage: 120, resets_at: "\u001b[31mbad-reset" },
        seven_day: { used_percent: -10, reset_at: "not-a-date" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(0);
    expect(result?.five_hour.resetTimeIso).toBeUndefined();
    expect(result?.seven_day.percentRemaining).toBe(100);
    expect(result?.seven_day.resetTimeIso).toBeUndefined();
  });

  it("returns null when required quota windows are missing or invalid", () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse("bad-shape")).toBeNull();
    expect(
      parseUsageResponse({
        rate_limits: {
          five_hour: { used_percentage: "nope" },
          seven_day: { utilization: 12 },
        },
      }),
    ).toBeNull();
    expect(
      parseUsageResponse({
        rateLimits: {
          fiveHour: { used_percentage: 30 },
        },
      }),
    ).toBeNull();
  });
});

describe("Claude CLI diagnostics", () => {
  it("builds a Windows-safe Claude CLI invocation for shim-based installs", () => {
    const invocation = buildClaudeCommandInvocation(
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      ["auth", "status", "--json"],
      { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "\"C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd\" \"auth\" \"status\" \"--json\"",
      ],
      display: "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd auth status --json",
    });
  });

  it("reports missing Claude CLI as unavailable without quota data", async () => {
    mockExecSequence([
      {
        code: "ENOENT",
        errorMessage: "spawn claude ENOENT",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics).toEqual({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      checkedCommands: ["claude --version"],
      message: "Claude CLI (`claude`) is not installed or not on PATH.",
    });
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toBeNull();
  });

  it("uses a configured Claude binary path for probe commands", async () => {
    mockExecSequence([
      {
        code: "ENOENT",
        errorMessage: "spawn /Applications/Claude Code.app/Contents/MacOS/claude ENOENT",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " /Applications/Claude Code.app/Contents/MacOS/claude ",
    });

    expect(diagnostics.checkedCommands).toEqual([
      "\"/Applications/Claude Code.app/Contents/MacOS/claude\" --version",
    ]);
    expect(diagnostics.message).toContain("/Applications/Claude Code.app/Contents/MacOS/claude");
  });

  it("reports unauthenticated Claude CLI status", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        code: 1,
        stderr: "Not logged in. Run `claude auth login` to continue.",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("unauthenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude auth login");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toBeNull();
  });

  it("returns quota data when Claude auth status JSON includes quota windows", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: {
              used_percentage: 57,
              resets_at: "2026-03-25T18:00:00.000Z",
            },
            seven_day: {
              usedPercentage: 12,
              resetsAt: "2026-04-01T00:00:00.000Z",
            },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(43);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(88);

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(43);
      expect(quota.seven_day.percentRemaining).toBe(88);
    }
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
  });

  it("keeps Anthropic availability local-only when only the OAuth fallback can provide quota", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("falls back to Claude OAuth usage when local Claude auth omits quota windows", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        oauth_usage: {
          fiveHour: {
            usedPercent: 35,
            resetAt: "2026-03-25T18:00:00.000Z",
          },
          sevenDay: {
            percent_used: 15,
            resetsAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(65);
    expect(diagnostics.quota?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(85);
    expect(diagnostics.quota?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: "Bearer oauth-access-token",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(65);
      expect(quota.seven_day.percentRemaining).toBe(85);
    }

    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to macOS Keychain Claude OAuth credentials when local Claude auth omits quota windows", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: "oauth-access-token-from-keychain",
          },
        }),
      },
    ]);
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        oauth_usage: {
          fiveHour: {
            usedPercent: 25,
            resetAt: "2026-03-25T18:00:00.000Z",
          },
          sevenDay: {
            usedPercent: 40,
            resetAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(75);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(60);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: "Bearer oauth-access-token-from-keychain",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to the Claude credentials file when the macOS Keychain entry is unusable", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {},
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token-from-file",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(
      mockJsonResponse({
        usage: {
          five_hour: { used_percentage: 5 },
          seven_day: { used_percentage: 10 },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(95);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(90);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      headers: {
        Authorization: "Bearer oauth-access-token-from-file",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("returns no quota when the Claude OAuth fallback credentials are unavailable", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
    );
    expect(diagnostics.message).toContain(".claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
      );
      expect(quota.error).toContain(".claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(1);
  });

  it("includes the macOS Keychain source when Claude OAuth fallback credentials are unavailable on macOS", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      {
        code: 44,
        stderr: "The specified item could not be found in the keychain.",
      },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude Code-credentials");
    expect(diagnostics.message).toContain(".claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude Code-credentials");
      expect(quota.error).toContain(".claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("returns no quota when the Claude OAuth fallback access token is malformed", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 123,
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude OAuth access token missing");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude OAuth access token missing");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("returns no quota when the Claude OAuth fallback API returns a non-2xx response", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue("rate\u001b[31m limited"),
    } as unknown as Response);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Anthropic API error 429: rate limited");
    expect(diagnostics.message).not.toContain("\u001b");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Anthropic API error 429: rate limited");
      expect(quota.error).not.toContain("\u001b");
    }
  });

  it("returns no quota when the Claude OAuth fallback API returns invalid JSON", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(mockInvalidJsonResponse());

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Failed to parse Anthropic quota response");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Failed to parse Anthropic quota response");
    }
  });

  it("returns no quota when the Claude OAuth fallback API returns an unexpected JSON shape", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchWithTimeoutMock.mockResolvedValue(mockJsonResponse({ ok: true }));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Unexpected Anthropic quota response shape");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Unexpected Anthropic quota response shape");
    }
  });

  it("falls back to plain auth status when --json is unsupported", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "Claude CLI version 1.2.3\n" },
      {
        code: 1,
        stderr: "unexpected argument '--json'",
      },
      {
        stdout: "Authenticated",
      },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

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
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
    );
    expect(diagnostics.message).toContain(".claude/.credentials.json");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from both the local CLI and Claude OAuth fallback.",
      );
      expect(quota.error).toContain(".claude/.credentials.json");
    }
  });

  it("sanitizes unexpected auth probe output", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        code: 1,
        stderr: "bad\u001b[31m-output",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.message).toContain("bad-output");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("caches diagnostics until the test helper clears the cache", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          quota: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      },
    ]);

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(90);
    expect(execFileMock).toHaveBeenCalledTimes(2);

    clearAnthropicDiagnosticsCacheForTests();

    const third = await getAnthropicDiagnostics();
    expect(third.quota?.five_hour.percentRemaining).toBe(70);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("caches fallback-backed diagnostics until the test helper clears the cache", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
        }),
      },
    ]);
    readFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-1" },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-2" },
        }),
      );
    fetchWithTimeoutMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      );

    const first = await getAnthropicDiagnostics();
    const second = await getAnthropicDiagnostics();
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(90);
    expect(first.quotaSource).toBe("claude-credentials-oauth-api");
    expect(second.quotaSource).toBe("claude-credentials-oauth-api");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    clearAnthropicDiagnosticsCacheForTests();

    const third = await getAnthropicDiagnostics();
    expect(third.quota?.five_hour.percentRemaining).toBe(70);
    expect(third.quotaSource).toBe("claude-credentials-oauth-api");
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
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
});
