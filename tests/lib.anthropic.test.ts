import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseUsageResponse,
  queryAnthropicQuota,
  resolveAnthropicCredentials,
  resolveAnthropicCredentialsFromFile,
} from "../src/lib/anthropic.js";

vi.mock("fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

const MOCK_TOKEN = "sk-ant-oauth-test-token";
const MOCK_EXPIRES_FUTURE = Date.now() + 60 * 60 * 1000;

const MOCK_USAGE_RESPONSE = {
  five_hour: { used_percentage: 57, resets_at: "2026-03-25T18:00:00.000Z" },
  seven_day: { used_percentage: 12, resets_at: "2026-04-01T00:00:00.000Z" },
};

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  delete process.env["CLAUDE_CODE_OAUTH_TOKEN"];
});

describe("resolveAnthropicCredentialsFromFile", () => {
  it("prefers ~/.claude/.credentials.json over env", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "env-token-value";

    const result = resolveAnthropicCredentialsFromFile({
      claudeAiOauth: {
        accessToken: MOCK_TOKEN,
        expiresAt: MOCK_EXPIRES_FUTURE,
      },
    });

    expect(result).toEqual({
      accessToken: MOCK_TOKEN,
      expiresAt: MOCK_EXPIRES_FUTURE,
      source: "file",
    });
  });

  it("falls back to env when the file has no access token", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "env-token-value";

    const result = resolveAnthropicCredentialsFromFile({
      claudeAiOauth: {},
    });

    expect(result).toEqual({
      accessToken: "env-token-value",
      source: "env",
    });
  });

  it("returns null when neither file nor env contain credentials", () => {
    expect(resolveAnthropicCredentialsFromFile(null)).toBeNull();
    expect(resolveAnthropicCredentialsFromFile({ claudeAiOauth: {} })).toBeNull();
  });
});

describe("resolveAnthropicCredentials", () => {
  it("reads ~/.claude/.credentials.json when present", async () => {
    const { existsSync, readFileSync } = await import("fs");
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: MOCK_TOKEN,
          expiresAt: MOCK_EXPIRES_FUTURE,
        },
      }),
    );

    await expect(resolveAnthropicCredentials()).resolves.toEqual({
      accessToken: MOCK_TOKEN,
      expiresAt: MOCK_EXPIRES_FUTURE,
      source: "file",
    });
  });

  it("falls back to env when the credentials file is absent", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "env-token-value";

    await expect(resolveAnthropicCredentials()).resolves.toEqual({
      accessToken: "env-token-value",
      source: "env",
    });
  });

  it("returns null when the credentials file is invalid and env is unset", async () => {
    const { existsSync, readFileSync } = await import("fs");
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue("not-json{{{");

    await expect(resolveAnthropicCredentials()).resolves.toBeNull();
  });
});

describe("parseUsageResponse", () => {
  it("parses a valid response", () => {
    const result = parseUsageResponse(MOCK_USAGE_RESPONSE);
    expect(result).not.toBeNull();
    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("drops invalid reset timestamps instead of surfacing raw text", () => {
    const result = parseUsageResponse({
      five_hour: { used_percentage: 10, resets_at: "\u001b[31mbad-reset" },
      seven_day: { used_percentage: 20, resets_at: "not-a-date" },
    });

    expect(result?.five_hour.resetTimeIso).toBeUndefined();
    expect(result?.seven_day.resetTimeIso).toBeUndefined();
  });

  it("clamps percentRemaining to [0, 100]", () => {
    const result = parseUsageResponse({
      five_hour: { used_percentage: 120, resets_at: "" },
      seven_day: { used_percentage: -10, resets_at: "" },
    });
    expect(result?.five_hour.percentRemaining).toBe(0);
    expect(result?.seven_day.percentRemaining).toBe(100);
  });

  it("returns null when required windows are missing", () => {
    expect(parseUsageResponse({ seven_day: { used_percentage: 10, resets_at: "" } })).toBeNull();
    expect(parseUsageResponse({ five_hour: { used_percentage: 10, resets_at: "" } })).toBeNull();
  });

  it("returns null for non-object input or invalid percentages", () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse("string")).toBeNull();
    expect(parseUsageResponse(42)).toBeNull();
    expect(
      parseUsageResponse({
        five_hour: { used_percentage: "not-a-number", resets_at: "" },
        seven_day: { used_percentage: 10, resets_at: "" },
      }),
    ).toBeNull();
  });
});

describe("queryAnthropicQuota", () => {
  it("returns null when no credentials are found", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);

    await expect(queryAnthropicQuota()).resolves.toBeNull();
  });

  it("returns an error when file credentials are expired", async () => {
    const { existsSync, readFileSync } = await import("fs");
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: MOCK_TOKEN,
          expiresAt: Date.now() - 1_000,
        },
      }),
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
    if (out && !out.success) {
      expect(out.error).toContain("expired");
      expect(out.error).toContain(".claude/.credentials.json");
    }
  });

  it("returns success result with parsed windows", async () => {
    const { existsSync, readFileSync } = await import("fs");
    (existsSync as any).mockReturnValue(true);
    (readFileSync as any).mockReturnValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: MOCK_TOKEN,
          expiresAt: MOCK_EXPIRES_FUTURE,
        },
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(MOCK_USAGE_RESPONSE), { status: 200 })) as any,
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(true);
    if (out?.success) {
      expect(out.five_hour.percentRemaining).toBe(43);
      expect(out.seven_day.percentRemaining).toBe(88);
    }
  });

  it("returns error on 401 or 403 response", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = MOCK_TOKEN;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })) as any,
    );
    let out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Forbidden", { status: 403 })) as any,
    );
    out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
  });

  it("returns error on non-ok response with sanitized body text", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = MOCK_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad\u001b[31m-body", { status: 500 })) as any,
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
    if (out && !out.success) {
      expect(out.error).toContain("500");
      expect(out.error).not.toContain("\u001b");
    }
  });

  it("returns error when fetch throws and sanitizes the message", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = MOCK_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network \u001b[31mdown"))) as any,
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
    if (out && !out.success) {
      expect(out.error).toContain("Quota fetch failed");
      expect(out.error).toContain("network down");
      expect(out.error).not.toContain("\u001b");
    }
  });

  it("returns error when response JSON is unparseable", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = MOCK_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{{{bad json", { status: 200 })) as any,
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
  });

  it("returns error when response shape is unexpected", async () => {
    const { existsSync } = await import("fs");
    (existsSync as any).mockReturnValue(false);
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = MOCK_TOKEN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as any,
    );

    const out = await queryAnthropicQuota();
    expect(out?.success).toBe(false);
    if (out && !out.success) {
      expect(out.error).toContain("Unexpected");
    }
  });
});
