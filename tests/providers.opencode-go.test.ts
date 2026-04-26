import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  resolveOpenCodeGoConfigCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-go-config.js", () => ({
  resolveOpenCodeGoConfigCached: mocks.resolveOpenCodeGoConfigCached,
  DEFAULT_OPENCODE_GO_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { opencodeGoProvider } from "../src/providers/opencode-go.js";
import { _parseMonthlyUsage } from "../src/lib/opencode-go.js";

function mockConfigNone() {
  mocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({ state: "none" });
}

function mockConfigIncomplete(source = "env", missing = "OPENCODE_GO_AUTH_COOKIE") {
  mocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
    state: "incomplete",
    source,
    missing,
  });
}

function mockConfigInvalid(
  source = "/tmp/opencode-go.json",
  error = "Failed to parse JSON: Unexpected end of JSON input",
) {
  mocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
    state: "invalid",
    source,
    error,
  });
}

function mockConfigConfigured(workspaceId = "ws-123", authCookie = "cookie-abc") {
  mocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce({
    state: "configured",
    config: { workspaceId, authCookie },
    source: "env",
  });
}

function buildDashboardHtml(usagePercent: number, resetInSec: number): string {
  return `<html><script>monthlyUsage:$R[42]={usagePercent:${usagePercent},resetInSec:${resetInSec}}</script></html>`;
}

function buildDashboardHtmlResetFirst(usagePercent: number, resetInSec: number): string {
  return `<html><script>monthlyUsage:$R[7]={resetInSec:${resetInSec},usagePercent:${usagePercent}}</script></html>`;
}

function mockDashboardSuccess(html: string) {
  mocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: true,
    text: async () => html,
  });
}

function mockDashboardHttpFailure(status: number, text: string) {
  mocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: false,
    status,
    text: async () => text,
  });
}

async function runProviderFetch() {
  return opencodeGoProvider.fetch({ config: {} } as any);
}

describe("opencode-go provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns attempted:false when config is none", async () => {
    mockConfigNone();
    const out = await runProviderFetch();
    expectNotAttempted(out);
  });

  it("returns error when config is incomplete", async () => {
    mockConfigIncomplete();
    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("OPENCODE_GO_AUTH_COOKIE");
  });

  it("returns error when config is invalid", async () => {
    mockConfigInvalid();
    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("Invalid config");
    expect(out.errors[0]?.message).toContain("/tmp/opencode-go.json");
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("returns usage entry on successful dashboard scrape", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(42, 1209600));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "OpenCode Go",
      group: "OpenCode Go",
      label: "Monthly:",
      percentRemaining: 58,
    });
    expect(out.entries[0]).toHaveProperty("resetTimeIso");
  });

  it("parses resetInSec-first field order", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtmlResetFirst(75, 604800));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      percentRemaining: 25,
    });
  });

  it("returns error on HTTP failure", async () => {
    mockConfigConfigured();
    mockDashboardHttpFailure(403, "Forbidden");

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("403");
  });

  it("returns error when dashboard HTML does not contain usage data", async () => {
    mockConfigConfigured();
    mockDashboardSuccess("<html><body>No usage data here</body></html>");

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("Could not parse");
  });

  it("returns error on network failure", async () => {
    mockConfigConfigured();
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("network timeout"));

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("network timeout");
  });

  it("lower-bounds usagePercent at 0 and allows over-100 usage values", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(150, 100));

    const out = await runProviderFetch();
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({ percentRemaining: -50 });
  });

  it("sanitizes error text from dashboard responses", async () => {
    mockConfigConfigured();
    mockDashboardHttpFailure(500, "\u001b[31mInternal Error\nretry\u001b[0m");

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe("OpenCode Go dashboard error 500: Internal Error retry");
  });
});

describe("opencode-go matchesCurrentModel", () => {
  it.each([
    ["opencode-go/some-model", true],
    ["opencode-go-subscription/any", true],
    ["openai/gpt-4", false],
    ["copilot/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeGoProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});

describe("opencode-go isAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [{ state: "configured", config: { workspaceId: "ws", authCookie: "ck" }, source: "env" }, true],
    [{ state: "incomplete", source: "env", missing: "authCookie" }, false],
    [{ state: "invalid", source: "/tmp/opencode-go.json", error: "broken" }, false],
    [{ state: "none" }, false],
  ])("returns correct availability for config state %j", async (configState, expected) => {
    mocks.resolveOpenCodeGoConfigCached.mockResolvedValueOnce(configState);
    const available = await opencodeGoProvider.isAvailable({} as any);
    expect(available).toBe(expected);
  });
});

describe("_parseMonthlyUsage", () => {
  it("returns null for empty string", () => {
    expect(_parseMonthlyUsage("")).toBeNull();
  });

  it("parses usagePercent-first ordering", () => {
    const html = "monthlyUsage:$R[42]={usagePercent:55,resetInSec:3600}";
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 55, resetInSec: 3600 });
  });

  it("parses resetInSec-first ordering", () => {
    const html = "monthlyUsage:$R[7]={resetInSec:7200,usagePercent:30}";
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 30, resetInSec: 7200 });
  });

  it("returns null when pattern is missing", () => {
    expect(_parseMonthlyUsage("<html><body>hello</body></html>")).toBeNull();
  });

  it("handles extra fields in the object", () => {
    const html = "monthlyUsage:$R[1]={usagePercent:10,foo:bar,resetInSec:500}";
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 10, resetInSec: 500 });
  });

  it("handles quoted property names and spaces", () => {
    const html = 'monthlyUsage:$R[123]={"usagePercent": 45, "resetInSec" : 7200}';
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 45, resetInSec: 7200 });
  });

  it("handles single quotes and decimal values", () => {
    const html = "monthlyUsage:$R[0]={'usagePercent':12.5, 'resetInSec':30.5}";
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 12.5, resetInSec: 30.5 });
  });

  it("handles quoted numeric values", () => {
    const html = 'monthlyUsage:$R[99]={usagePercent:"88",resetInSec:"1000"}';
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 88, resetInSec: 1000 });
  });

  it("handles variations of $R (e.g. no brackets, colon)", () => {
    const html1 = "monthlyUsage:$R42={usagePercent:10,resetInSec:100}";
    const html2 = "monthlyUsage:$R:7={usagePercent:20,resetInSec:200}";
    const html3 = "monthlyUsage: $R = {usagePercent:30,resetInSec:300}";
    expect(_parseMonthlyUsage(html1)).toEqual({ usagePercent: 10, resetInSec: 100 });
    expect(_parseMonthlyUsage(html2)).toEqual({ usagePercent: 20, resetInSec: 200 });
    expect(_parseMonthlyUsage(html3)).toEqual({ usagePercent: 30, resetInSec: 300 });
  });

  it("handles fuzzy matching of JSON objects without $R marker", () => {
    const html = '<div>Data: {"usagePercent": 5, "resetInSec": 50}</div>';
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 5, resetInSec: 50 });
  });

  it("handles the exact pattern found in opencode.htm", () => {
    const html = 'monthlyUsage:$R[33]={status:"ok",resetInSec:2066217,usagePercent:50}';
    expect(_parseMonthlyUsage(html)).toEqual({ usagePercent: 50, resetInSec: 2066217 });
  });

  it("normalizes workspaceId if it is a full URL", async () => {
    const fullUrl = "https://opencode.ai/workspace/wrk_999/go";
    mockConfigConfigured(fullUrl, "auth-token");
    mockDashboardSuccess(buildDashboardHtml(10, 100));

    await runProviderFetch();

    // Verify fetchWithTimeout was called with the normalized URL
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk_999/go",
      expect.any(Object),
      expect.any(Number),
    );
  });

  it("returns error with masked snippet on parsing failure", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(
      "<html><body>monthlyUsage:$R[1]={wrong:0} some sensitive info like 12345 and test@example.com</body></html>",
    );

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("Snippet:");
    expect(out.errors[0]?.message).toContain("v3.3.2-diag");
    expect(out.errors[0]?.message).toContain("***"); // Masked digits
    expect(out.errors[0]?.message).toContain("[EMAIL]"); // Masked email
  });
});
