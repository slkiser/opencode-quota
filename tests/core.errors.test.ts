import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

import { classifyError, describeError, providerError } from "../src/core/errors.js";
import type { QuotaErrorCode } from "../src/core/types.js";

const NOW_MS = Date.parse("2026-10-10T12:00:00.000Z");

/**
 * Messages as providers make them, by the code each one must get when it carries no facts of its
 * own. `text` is the part written in `from` (checked below, so a sample can't drift from its
 * producer); `message` fills in the rest the way the producer does. `node` is Node's own fetch.
 */
const PRODUCED: ReadonlyArray<{
  code: QuotaErrorCode;
  from: string;
  text: string;
  message?: string;
}> = [
  {
    code: "not_configured",
    from: "src/providers/quota-providers.ts",
    text: "API key not configured",
  },
  {
    code: "not_configured",
    from: "src/lib/api-key-resolver.ts",
    text: "auth entry present but key is empty",
    message: "Kimi auth entry present but key is empty",
  },
  {
    code: "not_configured",
    from: "src/lib/api-key-resolver.ts",
    text: "auth type:",
    message: 'Unsupported MiniMax auth type: "wellknown"',
  },
  {
    code: "not_configured",
    from: "src/lib/alibaba-auth.ts",
    text: "Unsupported Alibaba Coding Plan tier: ",
    message: "Unsupported Alibaba Coding Plan tier: max",
  },
  {
    code: "not_configured",
    from: "src/lib/google-oauth-quota.ts",
    text: "OAuth auth is missing a refresh token or project id",
    message: "Google AGY OAuth auth is missing a refresh token or project id",
  },
  {
    code: "not_configured",
    from: "src/lib/opencode-console-auth.ts",
    text: "OpenCode Console credential has no access token",
  },
  {
    code: "not_configured",
    from: "src/providers/mimo.ts",
    text: "Invalid config (",
    message: "Invalid config (quota.json): Failed to parse JSON",
  },
  { code: "not_configured", from: "src/lib/copilot.ts", text: "Config must be a JSON object" },
  { code: "not_configured", from: "src/lib/mimo-config.ts", text: "Invalid cookie header" },
  { code: "login_expired", from: "src/lib/openai.ts", text: "Token expired" },
  { code: "login_expired", from: "src/lib/google-oauth-quota.ts", text: "Token revoked" },
  { code: "login_expired", from: "src/lib/google-oauth-quota.ts", text: "Token refresh failed" },
  {
    code: "login_expired",
    from: "src/lib/google-oauth-quota.ts",
    text: "quota auth error: ",
    message: "Google AGY quota auth error: 403",
  },
  {
    code: "login_expired",
    from: "src/lib/openai.ts",
    text: "OpenAI sign-in could not be refreshed: ",
    message:
      "OpenAI sign-in could not be refreshed: refresh_failed: HTTP 401. Run `opencode auth login openai`.",
  },
  {
    code: "login_expired",
    from: "src/providers/anthropic.ts",
    text: "Anthropic sign-in could not be read: ",
    message:
      "Anthropic sign-in could not be read: refresh_failed: HTTP 500. Run `opencode auth login anthropic`.",
  },
  {
    code: "login_expired",
    from: "src/providers/anthropic.ts",
    text: "Anthropic sign-in expired. ",
    message: "Anthropic sign-in expired. Run `opencode auth login anthropic`.",
  },
  {
    code: "login_expired",
    from: "src/lib/api-key-resolver.ts",
    text: "OpenCode could not read this login: ",
    message: "OpenCode could not read this login: refresh_failed: invalid_grant",
  },
  {
    code: "login_expired",
    from: "src/providers/xai.ts",
    text: "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
  },
  {
    code: "login_expired",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
  },
  {
    code: "login_expired",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Cloud API Key credentials are missing or expired for team seats; this requires login. Run `bl auth login --open-api`, or set ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET.",
  },
  {
    code: "login_expired",
    from: "src/providers/mimo.ts",
    text: "request requires login",
    message: "Xiaomi MiMo usage request requires login",
  },
  {
    code: "login_expired",
    from: "src/lib/quota-providers-remote.ts",
    text: "HTTP ${",
    message: "HTTP 401",
  },
  {
    code: "no_plan",
    from: "src/lib/opencode-go.ts",
    text: "OpenCode Go not subscribed (403 EntitlementError)",
  },
  {
    code: "no_plan",
    from: "src/lib/opencode-go.ts",
    text: "OpenCode Go subscription not found for this console account (404)",
  },
  {
    code: "no_plan",
    from: "src/lib/opencode-go.ts",
    text: "OpenCode Go subscription is not active",
  },
  {
    code: "rate_limited",
    from: "src/lib/anthropic.ts",
    text: "Anthropic OAuth usage probe paused after HTTP 429; retry in ",
    message: "Anthropic OAuth usage probe paused after HTTP 429; retry in 42s.",
  },
  {
    code: "rate_limited",
    from: "src/lib/copilot.ts",
    text: " (GitHub API rate limit exhausted)",
    message: "GitHub API error 403: API rate limit exceeded (GitHub API rate limit exhausted)",
  },
  {
    code: "rate_limited",
    from: "src/lib/quota-providers-remote.ts",
    text: "HTTP ${",
    message: "HTTP 429",
  },
  {
    code: "timeout",
    from: "src/lib/http.ts",
    text: "Request timeout after ",
    message: "Request timeout after 10s",
  },
  { code: "timeout", from: "src/lib/google-oauth-quota.ts", text: "API timeout" },
  { code: "timeout", from: "src/lib/google-oauth-quota.ts", text: "Token refresh timeout" },
  {
    code: "timeout",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Timed out while running the Alibaba Cloud CLI.",
  },
  {
    code: "timeout",
    from: "src/lib/anthropic.ts",
    text: "Timed out while running Claude CLI auth status.",
  },
  { code: "network", from: "node", text: "fetch failed" },
  {
    code: "network",
    from: "src/lib/opencode-zen.ts",
    text: "request failed: ",
    message: "OpenCode Console billing/status request failed: fetch failed",
  },
  {
    code: "network",
    from: "src/providers/mimo.ts",
    text: "request failed: ",
    message: "Xiaomi MiMo usage request failed: socket hang up",
  },
  { code: "network", from: "node", text: "connect ECONNREFUSED 127.0.0.1:443" },
  { code: "network", from: "node", text: "getaddrinfo ENOTFOUND api.example.com" },
  {
    code: "provider_error",
    from: "src/lib/quota-providers-remote.ts",
    text: "HTTP ${",
    message: "HTTP 503",
  },
  {
    code: "provider_error",
    from: "src/lib/openai.ts",
    text: "OpenAI API error ${",
    message: "OpenAI API error 500",
  },
  {
    code: "provider_error",
    from: "src/providers/glm-coding-plan.ts",
    text: "API error",
    message: "Z.ai API error 500: internal",
  },
  {
    code: "provider_error",
    from: "src/lib/opencode-zen.ts",
    text: "error ${status}",
    message: "OpenCode Console billing/status error 500",
  },
  {
    code: "provider_error",
    from: "src/providers/mimo.ts",
    text: "request failed (HTTP ${",
    message: "Xiaomi MiMo usage request failed (HTTP 500)",
  },
  {
    code: "provider_error",
    from: "src/lib/google-oauth-quota.ts",
    text: "quota API error: ",
    message: "Gemini CLI quota API error: 500",
  },
  {
    code: "provider_error",
    from: "src/lib/anthropic.ts",
    text: "Anthropic API returned ",
    message: "Anthropic API returned 503",
  },
  { code: "bad_response", from: "src/providers/glm-coding-plan.ts", text: "Invalid quota data" },
  {
    code: "bad_response",
    from: "src/lib/quota-providers-remote.ts",
    text: "Invalid quota-v1 response",
  },
  {
    code: "bad_response",
    from: "src/lib/opencode-go.ts",
    text: "Invalid OpenCode Go API response: ",
    message: "Invalid OpenCode Go API response: usage must be an object",
  },
  {
    code: "bad_response",
    from: "src/lib/opencode-zen.ts",
    text: "Could not parse OpenCode Console ",
    message: "Could not parse OpenCode Console billing/status response",
  },
  { code: "bad_response", from: "src/lib/mimo-config.ts", text: "Failed to parse JSON" },
  {
    code: "bad_response",
    from: "src/lib/quota-providers-remote.ts",
    text: "Expected a JSON response",
  },
  {
    code: "bad_response",
    from: "src/lib/quota-providers-remote.ts",
    text: "Invalid JSON response",
  },
  {
    code: "bad_response",
    from: "src/lib/quota-providers-remote.ts",
    text: "exceeded ${",
    message: "Response exceeded 262144 bytes",
  },
  { code: "bad_response", from: "src/lib/quota-providers-remote.ts", text: "Redirect rejected" },
  {
    code: "bad_response",
    from: "src/providers/ollama-cloud.ts",
    text: "Ollama Cloud balance API returned an unexpected response shape",
  },
  {
    code: "bad_response",
    from: "src/lib/anthropic.ts",
    text: "Unexpected Anthropic quota response shape",
  },
  {
    code: "bad_response",
    from: "src/providers/ollama-cloud.ts",
    text: "Included: missing or invalid, expected an object",
  },
  {
    code: "bad_response",
    from: "src/providers/ollama-cloud.ts",
    text: "Included: invalid, expected credits or session and weekly limits",
  },
  {
    code: "bad_response",
    from: "src/providers/mimo.ts",
    text: "response did not match the expected schema",
    message: "Xiaomi MiMo usage response did not match the expected schema",
  },
  {
    code: "bad_response",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Cloud CLI did not return valid JSON.",
  },
  {
    code: "bad_response",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Cloud CLI returned an invalid team seat payload.",
  },
  { code: "no_data", from: "src/providers/xai.ts", text: "No quota data" },
  {
    code: "no_data",
    from: "src/lib/google-oauth-quota.ts",
    text: "quota data available",
    message: "No Google AGY quota data available",
  },
  {
    code: "no_data",
    from: "src/providers/ollama-cloud.ts",
    text: "Ollama Cloud returned no limits or balance",
  },
  { code: "no_data", from: "src/lib/google-agy.ts", text: "Quota summary API unavailable" },
  {
    code: "no_data",
    from: "src/lib/anthropic.ts",
    text: "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.",
  },
  {
    code: "local_tool",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
  },
  {
    code: "local_tool",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Could not start Alibaba Cloud CLI.",
  },
  {
    code: "local_tool",
    from: "src/providers/anthropic.ts",
    text: "Claude CLI probe failed: ",
    message: "Claude CLI probe failed: spawn EACCES",
  },
  {
    code: "local_tool",
    from: "src/lib/alibaba-token-plan.ts",
    text: "Alibaba Token Plan is not supported on this platform.",
  },
  {
    code: "internal",
    from: "src/lib/quota-providers-remote.ts",
    text: "Failed to read accounting data",
  },
  { code: "internal", from: "src/providers/quota-providers.ts", text: "Provider execution failed" },
  {
    code: "internal",
    from: "src/providers/quota-providers.ts",
    text: "Failed to read OpenCode's messages",
  },
];

describe("classifyError", () => {
  it.each(PRODUCED.map((row) => [row.message ?? row.text, row.code, row.from, row.text] as const))(
    'classifies "%s" as %s',
    (message, code, from, text) => {
      expect(message).toContain(text.split("${")[0]);
      if (from !== "node") expect(readFileSync(from, "utf8")).toContain(text);
      expect(classifyError(message, NOW_MS).code).toBe(code);
    },
  );

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

describe("providerError", () => {
  it("takes the code, status and retry time from the request's facts over the words", () => {
    expect(
      providerError(
        "Kimi API error 503: busy",
        { code: "rate_limited", status: 503, retryAtMs: NOW_MS + 60_000 },
        NOW_MS,
      ),
    ).toEqual({
      code: "rate_limited",
      status: 503,
      retryAtMs: NOW_MS + 60_000,
      detail: "Kimi API error 503: busy",
    });
  });

  /**
   * Failed requests as providers report them: the message (`text` checked in `from`, as above)
   * with the facts its request gave. Words naming a rate limit, a missing plan, an expired login
   * or a timeout beat a bare `provider_error`; the status and retry time stay.
   */
  it.each([
    {
      from: "src/lib/copilot.ts",
      text: " error ${failure.status}${errorWords(",
      message:
        "GitHub API error 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      facts: { code: "provider_error", status: 403, retryAtMs: NOW_MS + 60_000 },
      expected: { code: "rate_limited", status: 403, retryAtMs: NOW_MS + 60_000 },
    },
    {
      from: "src/providers/kimi-code.ts",
      text: "Kimi API error ${failure.status}${errorWords(",
      message: "Kimi API error 403: not subscribed to the coding plan",
      facts: { code: "provider_error", status: 403 },
      expected: { code: "no_plan", status: 403 },
    },
    {
      from: "src/providers/deepseek.ts",
      text: "DeepSeek API error ${failure.status}${errorWords(",
      message: "DeepSeek API error 400: token expired",
      facts: { code: "provider_error", status: 400 },
      expected: { code: "login_expired", status: 400 },
    },
    {
      from: "src/providers/xai.ts",
      text: "xAI API error ${failure.status}${errorWords(",
      message: "xAI API error 400: rate limit reached for this team",
      facts: { code: "provider_error", status: 400 },
      expected: { code: "rate_limited", status: 400 },
    },
    {
      from: "src/providers/kimi-code.ts",
      text: "Kimi API error ${failure.status}${errorWords(",
      message: "Kimi API error 504: Gateway Timeout",
      facts: { code: "provider_error", status: 504 },
      expected: { code: "timeout", status: 504 },
    },
    {
      from: "src/providers/glm-coding-plan.ts",
      text: "${apiError} ${failure.status}${errorWords(",
      message: "Z.ai API error 500: invalid config on the server",
      facts: { code: "provider_error", status: 500 },
      expected: { code: "provider_error", status: 500 },
    },
    {
      from: "src/lib/google-oauth-quota.ts",
      text: "quota API error: ${failure.status}",
      message: "Gemini CLI quota API error: 500",
      facts: { code: "provider_error", status: 500 },
      expected: { code: "provider_error", status: 500 },
    },
    {
      from: "src/lib/google-oauth-quota.ts",
      text: "quota auth error: ${failure.status}",
      message: "Google AGY quota auth error: 403",
      facts: { code: "login_expired", status: 403 },
      expected: { code: "login_expired", status: 403 },
    },
    {
      from: "src/lib/google-oauth-quota.ts",
      text: "`HTTP ${failure.status}`",
      message: "HTTP 400",
      facts: { code: "login_expired", status: 400 },
      expected: { code: "login_expired", status: 400 },
    },
    {
      from: "src/lib/anthropic.ts",
      text: "Anthropic API returned ${failure.status}",
      message: "Anthropic API returned 503",
      facts: { code: "provider_error", status: 503 },
      expected: { code: "provider_error", status: 503 },
    },
  ] as const)("$message → $expected.code", ({ from, text, message, facts, expected }) => {
    expect(message).toContain(text.replace(/^`/u, "").split("${")[0]);
    expect(readFileSync(from, "utf8")).toContain(text);
    expect(providerError(message, facts, NOW_MS)).toEqual({ ...expected, detail: message });
  });

  it("reads the words without facts", () => {
    expect(providerError("HTTP 503", undefined, NOW_MS)).toEqual(classifyError("HTTP 503", NOW_MS));
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
    [{ code: "rate_limited", retryAtMs: NOW_MS + 24 * 60 * 60_000 }, "Rate limited, retry in 24h"],
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
