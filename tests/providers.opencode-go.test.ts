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
import { _parseWindowUsage } from "../src/lib/opencode-go.js";

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

type OpenCodeGoTestWindow = "rolling" | "weekly" | "monthly";

const DASHBOARD_FIELD_BY_WINDOW: Record<OpenCodeGoTestWindow, string> = {
  rolling: "rollingUsage",
  weekly: "weeklyUsage",
  monthly: "monthlyUsage",
};

function buildDashboardHtml(
  rollingUsagePercent: number,
  rollingResetInSec: number,
  weeklyUsagePercent: number,
  weeklyResetInSec: number,
  monthlyUsagePercent: number,
  monthlyResetInSec: number,
): string {
  return buildPartialDashboardHtml({
    rolling: [rollingUsagePercent, rollingResetInSec],
    weekly: [weeklyUsagePercent, weeklyResetInSec],
    monthly: [monthlyUsagePercent, monthlyResetInSec],
  });
}

function buildDashboardHtmlResetFirst(
  rollingUsagePercent: number,
  rollingResetInSec: number,
  weeklyUsagePercent: number,
  weeklyResetInSec: number,
  monthlyUsagePercent: number,
  monthlyResetInSec: number,
): string {
  return `<html><script>rollingUsage:$R[10]={resetInSec:${rollingResetInSec},usagePercent:${rollingUsagePercent}}weeklyUsage:$R[11]={resetInSec:${weeklyResetInSec},usagePercent:${weeklyUsagePercent}}monthlyUsage:$R[12]={resetInSec:${monthlyResetInSec},usagePercent:${monthlyUsagePercent}}</script></html>`;
}

function buildPartialDashboardHtml(
  windows: Partial<Record<OpenCodeGoTestWindow, [usagePercent: number, resetInSec: number]>>,
): string {
  const chunks = (["rolling", "weekly", "monthly"] as const)
    .map((window, index) => {
      const usage = windows[window];
      if (!usage) return "";
      const [usagePercent, resetInSec] = usage;
      return `${DASHBOARD_FIELD_BY_WINDOW[window]}:$R[${10 + index}]={usagePercent:${usagePercent},resetInSec:${resetInSec}}`;
    })
    .join("");

  return `<html><script>${chunks}</script></html>`;
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

async function runProviderFetch(opencodeGoWindows?: Array<"rolling" | "weekly" | "monthly">) {
  return opencodeGoProvider.fetch({ config: { opencodeGoWindows } } as any);
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

  it("returns usage entries on successful dashboard scrape", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(7, 18000, 2, 540000, 16, 2480000));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]).toMatchObject({
      name: "OpenCode Go 5h",
      group: "OpenCode Go",
      label: "5h:",
      percentRemaining: 93,
    });
    expect(out.entries[0]).toHaveProperty("resetTimeIso");
    expect(out.entries[1]).toMatchObject({
      name: "OpenCode Go Weekly",
      group: "OpenCode Go",
      label: "Weekly:",
      percentRemaining: 98,
    });
    expect(out.entries[1]).toHaveProperty("resetTimeIso");
    expect(out.entries[2]).toMatchObject({
      name: "OpenCode Go Monthly",
      group: "OpenCode Go",
      label: "Monthly:",
      percentRemaining: 84,
    });
    expect(out.entries[2]).toHaveProperty("resetTimeIso");
  });

  it("parses decimal dashboard usage values", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(7.5, 18000, 2.25, 540000, 16.75, 2480000));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({ percentRemaining: 92.5 });
    expect(out.entries[1]).toMatchObject({ percentRemaining: 97.75 });
    expect(out.entries[2]).toMatchObject({ percentRemaining: 83.25 });
  });

  it("filters windows based on opencodeGoWindows config", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(7, 18000, 2, 540000, 16, 2480000));

    const out = await runProviderFetch(["weekly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "OpenCode Go Weekly",
      group: "OpenCode Go",
      label: "Weekly:",
      percentRemaining: 98,
    });
  });

  it("defaults to available windows when opencodeGoWindows is not set", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildPartialDashboardHtml({ rolling: [7, 18000], monthly: [16, 2480000] }));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual(["OpenCode Go 5h", "OpenCode Go Monthly"]);
  });

  it("succeeds when weekly is selected and only weeklyUsage is present", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildPartialDashboardHtml({ weekly: [2, 540000] }));

    const out = await runProviderFetch(["weekly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      name: "OpenCode Go Weekly",
      group: "OpenCode Go",
      label: "Weekly:",
      percentRemaining: 98,
    });
  });

  it("returns a clear error when a selected weekly window is missing", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildPartialDashboardHtml({ rolling: [7, 18000], monthly: [16, 2480000] }));

    const out = await runProviderFetch(["weekly"]);

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.entries).toHaveLength(0);
    expect(out.errors[0]?.message).toContain("weekly");
    expect(out.errors[0]?.message).toContain("weeklyUsage");
  });

  it("supports custom window combinations", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(7, 18000, 2, 540000, 16, 2480000));

    const out = await runProviderFetch(["rolling", "monthly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0]).toMatchObject({ name: "OpenCode Go 5h" });
    expect(out.entries[1]).toMatchObject({ name: "OpenCode Go Monthly" });
  });

  it("keeps selected windows in canonical order", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtml(7, 18000, 2, 540000, 16, 2480000));

    const out = await runProviderFetch(["weekly", "monthly", "rolling"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Weekly",
      "OpenCode Go Monthly",
    ]);
  });

  it("treats reordered full window selection as the default missing-window-tolerant selection", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildPartialDashboardHtml({ rolling: [7, 18000], monthly: [16, 2480000] }));

    const out = await runProviderFetch(["weekly", "monthly", "rolling"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual(["OpenCode Go 5h", "OpenCode Go Monthly"]);
  });

  it("parses resetInSec-first field order", async () => {
    mockConfigConfigured();
    mockDashboardSuccess(buildDashboardHtmlResetFirst(10, 3600, 20, 7200, 30, 14400));

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]).toMatchObject({ percentRemaining: 90 });
    expect(out.entries[1]).toMatchObject({ percentRemaining: 80 });
    expect(out.entries[2]).toMatchObject({ percentRemaining: 70 });
  });

  it("returns error on HTTP failure", async () => {
    mockConfigConfigured();
    mockDashboardHttpFailure(403, "Forbidden");

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("403");
  });

  it("returns parse error when dashboard HTML does not contain any known usage windows", async () => {
    mockConfigConfigured();
    mockDashboardSuccess("<html><body>No usage data here</body></html>");

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toContain("Could not parse any known OpenCode Go dashboard usage windows");
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
    mockDashboardSuccess(buildDashboardHtml(150, 100, 0, 200, 50, 300));

    const out = await runProviderFetch();
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toMatchObject({ percentRemaining: -50 });
    expect(out.entries[1]).toMatchObject({ percentRemaining: 100 });
    expect(out.entries[2]).toMatchObject({ percentRemaining: 50 });
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

describe("_parseWindowUsage", () => {
  const rollingRePctFirst = /rollingUsage:\$R\[\d+\]=\{[^}]*usagePercent:(\d+)[^}]*resetInSec:(\d+)[^}]*\}/;
  const rollingReResetFirst = /rollingUsage:\$R\[\d+\]=\{[^}]*resetInSec:(\d+)[^}]*usagePercent:(\d+)[^}]*\}/;

  it("returns null for empty string", () => {
    expect(_parseWindowUsage("", rollingRePctFirst, rollingReResetFirst)).toBeNull();
  });

  it("parses usagePercent-first ordering", () => {
    const html = "rollingUsage:$R[42]={usagePercent:55,resetInSec:3600}";
    expect(_parseWindowUsage(html, rollingRePctFirst, rollingReResetFirst)).toEqual({
      usagePercent: 55,
      resetInSec: 3600,
    });
  });

  it("parses resetInSec-first ordering", () => {
    const html = "rollingUsage:$R[7]={resetInSec:7200,usagePercent:30}";
    expect(_parseWindowUsage(html, rollingRePctFirst, rollingReResetFirst)).toEqual({
      usagePercent: 30,
      resetInSec: 7200,
    });
  });

  it("returns null when pattern is missing", () => {
    expect(
      _parseWindowUsage("<html><body>hello</body></html>", rollingRePctFirst, rollingReResetFirst),
    ).toBeNull();
  });

  it("handles extra fields in the object", () => {
    const html = "rollingUsage:$R[1]={usagePercent:10,foo:bar,resetInSec:500}";
    expect(_parseWindowUsage(html, rollingRePctFirst, rollingReResetFirst)).toEqual({
      usagePercent: 10,
      resetInSec: 500,
    });
  });
});
