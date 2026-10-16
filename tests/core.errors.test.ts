import { describe, expect, it, vi } from "vite-plus/test";

import { classifyError, describeError } from "../src/core/errors.js";
import type { QuotaErrorCode } from "../src/core/types.js";

const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");

/** Real messages from today's providers and pipeline, by the code each one must get. */
const REAL_MESSAGES: Record<QuotaErrorCode, readonly string[]> = {
  not_configured: [
    "Not configured",
    "API key not configured",
    "DeepSeek auth entry present but key is empty",
    'Unsupported MiniMax auth type: "wellknown"',
    "Unsupported Alibaba Coding Plan tier: max",
    "Google AGY OAuth auth is missing a refresh token or project id",
    "OpenCode Console credential has no access token",
    "Invalid config (quota.json): enabled must be a boolean",
    "Config must be a JSON object",
    "Invalid cookie header",
  ],
  login_expired: [
    "Token expired",
    "Token revoked",
    "Token refresh failed",
    "OpenAI sign-in could not be refreshed: fetch failed. Run `opencode auth login openai`.",
    "Anthropic sign-in could not be read: bad JSON. Run `opencode auth login anthropic`.",
    "OpenCode could not read this login: refresh_failed: invalid_grant",
    "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
    "Xiaomi MiMo usage request requires login",
    "HTTP 401",
  ],
  no_plan: [
    "OpenCode Go not subscribed (403 EntitlementError)",
    "OpenCode Go subscription not found for this console account (404)",
    "OpenCode Go subscription is not active",
  ],
  rate_limited: [
    "Anthropic OAuth usage probe paused after HTTP 429; retry in 42s",
    "HTTP 429",
    "Too many requests",
  ],
  timeout: [
    "Request timeout after 10s",
    "API timeout",
    "Timed out while running the Alibaba Cloud CLI.",
    "Token refresh timeout",
  ],
  network: [
    "fetch failed",
    "OpenCode Console usage request failed: ECONNRESET",
    "Xiaomi MiMo usage request failed: socket hang up",
    "connect ECONNREFUSED 127.0.0.1:443",
    "getaddrinfo ENOTFOUND api.example.com",
  ],
  provider_error: [
    "HTTP 503",
    "OpenAI API error 500",
    "Z.ai API error 500: internal",
    "OpenCode Console usage error 500",
    "Xiaomi MiMo usage request failed (HTTP 500)",
  ],
  bad_response: [
    "Invalid quota data",
    "Invalid quota-v1 response",
    "Invalid json-v1 response: missing field",
    "Invalid OpenCode Go API response: windows",
    "Could not parse OpenCode Console usage response",
    "Failed to parse JSON",
    "Expected a JSON response",
    "Invalid JSON response",
    "Response exceeded 262144 bytes",
    "Redirect rejected",
    "Ollama Cloud balance API returned an unexpected response shape",
    "Included: missing or invalid, expected an object",
    "Included: invalid, expected credits or session and weekly limits",
    "Xiaomi MiMo usage response did not match the expected schema",
    "Alibaba Cloud CLI did not return valid JSON.",
  ],
  no_data: [
    "No quota data",
    "No Google AGY quota data available",
    "Ollama Cloud returned no limits or balance",
    "Quota summary API unavailable",
    "Alibaba Personal Token Plan usage returned no quota windows.",
    "No local usage yet",
    "Quota unavailable via local Claude CLI or OAuth credentials",
    "Anthropic OAuth quota unavailable",
    "Unavailable (not detected)",
  ],
  local_tool: [
    "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
    "Could not start Alibaba Cloud CLI.",
    "Claude CLI probe failed: exit code 1",
    "Alibaba Personal Token Plan is not supported on this platform.",
  ],
  internal: [
    "Failed to read quota data",
    "Invalid normalized provider result",
    "Provider execution failed",
    "Failed to update local accounting state",
    "Unable to resolve Copilot billing scope.",
  ],
};

describe("classifyError", () => {
  for (const [code, messages] of Object.entries(REAL_MESSAGES)) {
    it.each(messages)(`classifies "%s" as ${code}`, (message) => {
      expect(classifyError(message, NOW_MS).code).toBe(code);
    });
  }

  it("keeps the scrubbed message as the detail", () => {
    expect(classifyError("HTTP 503\u001b[31m\nbusy", NOW_MS)).toEqual({
      code: "provider_error",
      status: 503,
      detail: "HTTP 503 busy",
    });
    expect(classifyError("", NOW_MS)).toEqual({ code: "internal" });
  });

  it.each([
    { value: "alice.smith@example.com", shown: "[email]", hidden: "smith" },
    { value: "/Users/alice/.config/opencode/x.json", shown: "~/.config", hidden: "ali" },
  ])("hides $hidden before it cuts a long detail", ({ value, shown, hidden }) => {
    // os.homedir() reads HOME, and USERPROFILE on Windows.
    vi.stubEnv("HOME", "/Users/alice");
    vi.stubEnv("USERPROFILE", "/Users/alice");
    // Unhidden, the cut at 300 characters would keep the first 16 characters of `value`.
    const filler = "1234567.".repeat(40).slice(0, 300 - " ".length - 16);
    const { detail } = classifyError(`${filler} ${value}`, NOW_MS);

    expect(detail).toContain(`${filler} ${shown}`);
    expect(detail).not.toContain(hidden);
  });

  it("reads the retry time of a rate limit", () => {
    expect(
      classifyError("Anthropic OAuth usage probe paused after HTTP 429; retry in 42s", NOW_MS),
    ).toMatchObject({ code: "rate_limited", status: 429, retryAtMs: NOW_MS + 42_000 });
    expect(classifyError("Too many requests", NOW_MS)).not.toHaveProperty("retryAtMs");
  });

  it("names the local program and whether it is missing", () => {
    expect(
      classifyError("Alibaba Cloud CLI (bl) was not found on the trusted PATH.", NOW_MS),
    ).toMatchObject({ tool: "Alibaba Cloud CLI", missing: true });
    expect(classifyError("Claude CLI probe failed: exit code 1", NOW_MS)).toMatchObject({
      tool: "Claude CLI",
    });
    expect(classifyError("Claude CLI probe failed: exit code 1", NOW_MS)).not.toHaveProperty(
      "missing",
    );
  });

  it("does not mistake words that only look like network codes", () => {
    expect(classifyError("economy plan has no usable data", NOW_MS).code).toBe("no_data");
  });
});

describe("describeError", () => {
  it.each([
    [{ code: "not_configured" }, "Not set up"],
    [{ code: "login_expired" }, "Sign in again"],
    [{ code: "no_plan" }, "No active plan"],
    [{ code: "rate_limited" }, "Rate limited"],
    [{ code: "rate_limited", retryAtMs: NOW_MS + 42_000 }, "Rate limited, retry in 1m"],
    [{ code: "rate_limited", retryAtMs: NOW_MS + 7 * 60_000 }, "Rate limited, retry in 7m"],
    [{ code: "rate_limited", retryAtMs: NOW_MS + 90 * 60_000 }, "Rate limited, retry in 2h"],
    [{ code: "rate_limited", retryAtMs: NOW_MS - 1 }, "Rate limited"],
    [{ code: "timeout" }, "Timed out"],
    [{ code: "network" }, "Can't reach Copilot"],
    [{ code: "provider_error", status: 502 }, "Provider error 502"],
    [{ code: "provider_error" }, "Provider error"],
    [{ code: "bad_response" }, "Unexpected reply"],
    [{ code: "no_data" }, "Nothing reported"],
    [{ code: "local_tool", tool: "Claude CLI", missing: true }, "Claude CLI not found"],
    [{ code: "local_tool", tool: "Claude CLI" }, "Claude CLI failed"],
    [{ code: "local_tool" }, "Local tool failed"],
    [{ code: "internal" }, "Couldn't read"],
  ] as const)("%o → %s", (error, words) => {
    expect(describeError(error, "Copilot", NOW_MS)).toBe(words);
  });
});
