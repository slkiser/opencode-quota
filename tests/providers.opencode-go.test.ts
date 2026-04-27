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
import { _parseUsage } from "../src/lib/opencode-go.js";

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

function buildDashboardHtml(
  rolling: [number, number],
  weekly: [number, number],
  monthly: [number, number],
): string {
  return `<html><script>
    rollingUsage:$R[1]={status:"ok",resetInSec:${rolling[1]},usagePercent:${rolling[0]}},
    weeklyUsage:$R[2]={status:"ok",resetInSec:${weekly[1]},usagePercent:${weekly[0]}},
    monthlyUsage:$R[3]={status:"ok",resetInSec:${monthly[1]},usagePercent:${monthly[0]}}
  </script></html>`;
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

  it("returns all three usage entries on successful dashboard scrape", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const rolling: [number, number] = [0, 18000]; // 0%, 5h
    const weekly: [number, number] = [100, 10271]; // 100%, ~2.8h
    const monthly: [number, number] = [50, 2066217]; // 50%, ~24d

    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(rolling, weekly, monthly));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);

    expect(out.entries[0]).toMatchObject({
      label: "Rolling:",
      percentRemaining: 100,
    });
    expect(out.entries[0]).not.toHaveProperty("resetTimeIso");
    expect(out.entries[0]).not.toHaveProperty("resetText");

    expect(out.entries[1]).toMatchObject({
      label: "Weekly:",
      percentRemaining: 0,
      resetTimeIso: new Date(now + weekly[1] * 1000).toISOString(),
    });
    expect(out.entries[2]).toMatchObject({
      label: "Monthly:",
      percentRemaining: 50,
      resetTimeIso: new Date(now + monthly[1] * 1000).toISOString(),
    });

    for (const entry of out.entries) {
      expect(entry.group).toBe("OpenCode Go");
    }
  });

  it("always shows countdown for Weekly and Monthly even with 0% usage", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml([0, 18000], [0, 604800], [0, 2592000]));

    const out = await runProviderFetch();
    expectAttemptedWithNoErrors(out);

    // Rolling: 0% -> blank
    expect(out.entries[0]).toMatchObject({
      label: "Rolling:",
      percentRemaining: 100,
    });
    expect(out.entries[0].resetTimeIso).toBeUndefined();

    // Weekly: 0% -> countdown
    expect(out.entries[1]).toMatchObject({
      label: "Weekly:",
      percentRemaining: 100,
      resetTimeIso: new Date(now + 604800 * 1000).toISOString(),
    });

    // Monthly: 0% -> countdown
    expect(out.entries[2]).toMatchObject({
      label: "Monthly:",
      percentRemaining: 100,
      resetTimeIso: new Date(now + 2592000 * 1000).toISOString(),
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

describe("_parseUsage", () => {
  it("returns null for empty string", () => {
    expect(_parseUsage("", "monthlyUsage")).toBeNull();
  });

  it("parses rollingUsage specifically", () => {
    const html = "rollingUsage:$R[1]={usagePercent:5,resetInSec:100}";
    expect(_parseUsage(html, "rollingUsage")).toEqual({ usagePercent: 5, resetInSec: 100 });
  });

  it("parses weeklyUsage specifically", () => {
    const html = "weeklyUsage:$R[1]={usagePercent:80,resetInSec:5000}";
    expect(_parseUsage(html, "weeklyUsage")).toEqual({ usagePercent: 80, resetInSec: 5000 });
  });

  it("parses monthlyUsage specifically", () => {
    const html = "monthlyUsage:$R[1]={usagePercent:55,resetInSec:3600}";
    expect(_parseUsage(html, "monthlyUsage")).toEqual({ usagePercent: 55, resetInSec: 3600 });
  });

  it("handles fuzzy matching scoped to the key", () => {
    const html = 'rollingUsage: {"usagePercent": 5, "resetInSec": 50}';
    expect(_parseUsage(html, "rollingUsage")).toEqual({ usagePercent: 5, resetInSec: 50 });
  });

  it("handles the exact pattern found in opencode.htm", () => {
    const html = 'weeklyUsage:$R[32]={status:"rate-limited",resetInSec:10271,usagePercent:100}';
    expect(_parseUsage(html, "weeklyUsage")).toEqual({ usagePercent: 100, resetInSec: 10271 });
  });

  it("ignores unrelated scalar fields and finds the correct hydration object", () => {
    // This HTML snippet mimics production where monthlyUsage appears as a scalar first (billing),
    // then as a hydration object.
    const html = `
      "monthlyUsage": 1322715454,
      "other": {"foo": "bar"},
      monthlyUsage:$R[33]={status:"ok",resetInSec:2066217,usagePercent:50}
    `;
    expect(_parseUsage(html, "monthlyUsage")).toEqual({ usagePercent: 50, resetInSec: 2066217 });
  });

  it("handles braces inside string literals", () => {
    const html = 'rollingUsage:$R[1]={status:"contains { braces }",usagePercent:10,resetInSec:100}';
    expect(_parseUsage(html, "rollingUsage")).toEqual({ usagePercent: 10, resetInSec: 100 });
  });

  it("returns error with masked snippet on parsing failure", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(
      "<html><body>monthlyUsage:$R[1]={wrong:0} some sensitive info like 12345 and test@example.com</body></html>",
    );

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("Snippet:");
    expect(out.errors[0]?.message).toContain("v3.4.0-diag");
    expect(out.errors[0]?.message).toContain("***"); // Masked digits
    expect(out.errors[0]?.message).toContain("[EMAIL]"); // Masked email
  });
});
