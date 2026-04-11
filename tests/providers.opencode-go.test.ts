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

  it("clamps usagePercent to [0, 100]", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(150, 100));

    const out = await runProviderFetch();
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({ percentRemaining: 0 });
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
    [{ state: "incomplete", source: "env", missing: "authCookie" }, true],
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
});
