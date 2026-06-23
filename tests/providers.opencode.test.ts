import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeZenConfigCached: vi.fn(),
}));

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  resolveOpenCodeZenConfigCached: mocks.resolveOpenCodeZenConfigCached,
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

vi.mock("../src/lib/opencode-zen.js", () => ({
  queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
}));

import { opencodeProvider } from "../src/providers/opencode.js";

function mockConfig(state: "none" | "incomplete" | "invalid" | "configured", opts?: Record<string, unknown>) {
  const configs: Record<string, unknown> = {
    none: { state: "none" },
    incomplete: { state: "incomplete", source: "env", missing: "OPENCODE_AUTH_COOKIE" },
    invalid: { state: "invalid", source: "/tmp/opencode.json", error: "Failed to parse JSON: Unexpected end of JSON input" },
    configured: { state: "configured", config: { workspaceId: "wrk_123", authCookie: "cookie-abc" }, source: "env" },
  };
  mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce(configs[state] as never);
}

describe("opencode provider", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("isAvailable", () => {
    it.each([
      ["configured", true],
      ["none", false],
      ["incomplete", false],
    ])("returns %s when config state is %s", async (_label, expected) => {
      mockConfig(expected ? "configured" : "none");
      expect(await opencodeProvider.isAvailable({} as any)).toBe(expected);
    });
  });

  describe("matchesCurrentModel", () => {
    it.each([
      ["opencode/gpt-5", true],
      ["opencode/claude-opus-4-6", true],
      ["opencode/gemini-3-flash", true],
      ["openai/gpt-5", false],
      ["anthropic/claude-opus-4-6", false],
      ["google/gemini-3-flash", false],
    ])("model %s => %s", (model, expected) => {
      expect(opencodeProvider.matchesCurrentModel?.(model)).toBe(expected);
    });
  });

  describe("fetch", () => {
    it("returns not attempted when config is none", async () => {
      mockConfig("none");
      expectNotAttempted(await opencodeProvider.fetch({ config: {} } as any));
    });

    it.each([
      ["incomplete config", "incomplete", "Missing OPENCODE_AUTH_COOKIE"],
      ["invalid config", "invalid", "Invalid config"],
    ])("returns error for %s", async (_label, configState, msgContains) => {
      mockConfig(configState as "incomplete" | "invalid");
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithErrorLabel(result, "OpenCode");
      expect(result.errors[0]?.message).toContain(msgContains);
    });

    it("returns error when quota query fails", async () => {
      mockConfig("configured");
      mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: false, error: "Network error" });
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithErrorLabel(result, "OpenCode");
      expect(result.errors[0]?.message).toContain("Network error");
    });

    it("returns value entry when no monthly limit", async () => {
      mockConfig("configured");
      mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: true, data: { balance: 4250000000, monthlyLimit: null, monthlyUsage: null } });
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      expect(result.entries[0]).toMatchObject({ kind: "value", name: "", group: "OpenCode Zen", value: "$42.50" });
    });

    it("returns percent entry when monthly limit exists", async () => {
      mockConfig("configured");
      mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: true, data: { balance: 4250000000, monthlyLimit: 100, monthlyUsage: 575000000 } });
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      expect(result.entries[0]).toMatchObject({ kind: "percent", name: "", group: "OpenCode Zen" });
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBeCloseTo(42.5, 1);
      }
    });

    it("uses plugin config monthlyLimit when provided", async () => {
      mockConfig("configured");
      mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: true, data: { balance: 4250000000, monthlyLimit: 100, monthlyUsage: 575000000 } });
      const result = await opencodeProvider.fetch({ config: { opencodeMonthlyLimit: 200 } } as any);
      expectAttemptedWithNoErrors(result);
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBeCloseTo(21.25, 1);
      }
    });

    it.each([
      ["zero balance", 0, 100, 0],
      ["usage exceeding limit", 0, 100, 0],
      ["balance exceeds limit", 20000000000, 100, 100],
    ])("handles %s correctly", async (_label, balance, limit, expectedPercent) => {
      mockConfig("configured");
      mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({ success: true, data: { balance, monthlyLimit: limit, monthlyUsage: null } });
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBe(expectedPercent);
      }
    });
  });
});
