import { describe, expect, it } from "vite-plus/test";

import { resolveAnthropicOAuth } from "../src/lib/anthropic-auth.js";

describe("anthropic auth resolution", () => {
  it.each([
    [
      "resolves the OpenCode anthropic OAuth entry",
      { anthropic: { type: "oauth", access: "opencode-token", expires: 4_000 } },
      { state: "configured", accessToken: "opencode-token", expiresAt: 4_000 },
    ],
    [
      "resolves entries without an expiry",
      { anthropic: { type: "oauth", access: "opencode-token" } },
      { state: "configured", accessToken: "opencode-token" },
    ],
    [
      "ignores API key auth entries because the usage endpoint requires OAuth",
      { anthropic: { type: "api", access: "opencode-token" } },
      { state: "none" },
    ],
    [
      "ignores blank access tokens",
      { anthropic: { type: "oauth", access: "   " } },
      { state: "none" },
    ],
    [
      "reports expired entries as expired instead of configured",
      { anthropic: { type: "oauth", access: "opencode-token", expires: 1_000 } },
      { state: "expired", expiresAt: 1_000 },
    ],
    [
      "reports a login OpenCode could not return as failed",
      { anthropic: { type: "oauth", resolveError: "refresh_failed: HTTP 500" } },
      { state: "failed", error: "refresh_failed: HTTP 500" },
    ],
    ["returns none when auth data is missing", null, { state: "none" }],
    ["returns none when the anthropic entry is missing", {}, { state: "none" }],
  ])("%s", (_label, auth, expected) => {
    expect(resolveAnthropicOAuth(auth as never, { nowMs: 2_000 })).toStrictEqual(expected);
  });
});
