import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  resolveOpenCodeZenConfigCached: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/opencode-zen-config.js", () => ({
  resolveOpenCodeZenConfigCached: mocks.resolveOpenCodeZenConfigCached,
  DEFAULT_OPENCODE_ZEN_CONFIG_CACHE_MAX_AGE_MS: 30_000,
}));

import { opencodeProvider } from "../src/providers/opencode.js";
import {
  _parseSsrBillingData,
  _parseDataSlotBillingData,
  _parseSsrPaymentData,
  _parseDataSlotPaymentData,
  queryOpenCodeZenQuota,
} from "../src/lib/opencode-zen.js";

// ---- HTML helpers ----

const ssrHtml = (balance: number, monthlyLimit?: number, monthlyUsage?: number): string =>
  monthlyLimit !== undefined && monthlyUsage !== undefined
    ? `<!DOCTYPE html><html><body><div id="root">$R[42]={billing:{balance:${balance},monthlyLimit:${monthlyLimit},monthlyUsage:${monthlyUsage}}}</div></body></html>`
    : `<!DOCTYPE html><html><body><div id="root">$R[42]={billing:{balance:${balance}}}</div></body></html>`;

const dataSlotHtml = (balanceUsd: string, monthlyLimitUsd?: string, monthlyUsageUsd?: string): string => {
  let items = `<div data-slot="billing-item"><span data-slot="billing-label">Balance</span><span data-slot="billing-value">$${balanceUsd}</span></div>`;
  if (monthlyLimitUsd) items += `<div data-slot="billing-item"><span data-slot="billing-label">Monthly Limit</span><span data-slot="billing-value">$${monthlyLimitUsd}</span></div>`;
  if (monthlyUsageUsd) items += `<div data-slot="billing-item"><span data-slot="billing-label">Monthly Usage</span><span data-slot="billing-value">$${monthlyUsageUsd}</span></div>`;
  return `<!DOCTYPE html><html><body>${items}</body></html>`;
};

const ssrPayments = (...payments: Array<{ amount: number }>) =>
  `$R["payment.list"]=${JSON.stringify(payments.map(p => ({ id: "pay_01J", workspaceID: "wrk", timeCreated: new Date().toISOString(), amount: p.amount })))}`;

const paymentTable = (...payments: Array<{ amount: string; refunded?: boolean }>) => {
  const rows = payments.map(p =>
    `<tr><td data-slot="payment-date">Jan 15</td><td data-slot="payment-id">pay_01J</td><td data-slot="payment-amount"${p.refunded ? ' data-refunded="true"' : ""}>$${p.amount}</td><td data-slot="payment-receipt">-</td></tr>`,
  ).join("");
  return `<div data-slot="payments-table"><table data-slot="payments-table-element"><thead><tr><th>Date</th><th>Payment ID</th><th>Amount</th><th>Receipt</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

const mockResponse = (body: string, status = 200, ok = true) => ({
  ok, status, text: vi.fn().mockResolvedValue(body),
});

// ---- Config mocks ----

function mockConfig(state: "none" | "incomplete" | "invalid" | "configured") {
  const configs: Record<string, unknown> = {
    none: { state: "none" },
    incomplete: { state: "incomplete", source: "env", missing: "OPENCODE_AUTH_COOKIE" },
    invalid: { state: "invalid", source: "/tmp/opencode.json", error: "Failed to parse JSON: Unexpected end of JSON input" },
    configured: { state: "configured", config: { workspaceId: "wrk_123", authCookie: "cookie-abc" }, source: "env" },
  };
  mocks.resolveOpenCodeZenConfigCached.mockResolvedValueOnce(configs[state] as never);
}

function mockFetchHtml(html: string) {
  mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse(html));
}

function mockFetchHttpError(status: number, body: string) {
  mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse(body, status, false));
}

// ---- Parser tests (opencode-go pattern: tested in provider file) ----

describe("parseSsrBillingData", () => {
  it("parses balance, monthlyLimit, monthlyUsage from SSR", () => {
    expect(_parseSsrBillingData(ssrHtml(425000000, 20, 12500000))).toEqual({
      balance: 425000000, monthlyLimit: 20, monthlyUsage: 12500000, lastPayment: null,
    });
  });

  it("parses balance only (no limit/usage)", () => {
    expect(_parseSsrBillingData(ssrHtml(50000000))).toEqual({
      balance: 50000000, monthlyLimit: null, monthlyUsage: null, lastPayment: null,
    });
  });

  it.each([
    ["no billing data", "<html><body>No data</body></html>"],
    ["negative balance", `$R[42]={billing:{balance:-100}}`],
  ])("returns null for %s", (_name, html) => {
    expect(_parseSsrBillingData(html)).toBeNull();
  });
});

describe("parseDataSlotBillingData", () => {
  it("parses balance, limit, and usage", () => {
    expect(_parseDataSlotBillingData(dataSlotHtml("42.50", "100.00", "12.50"))).toEqual({
      balance: 4250000000, monthlyLimit: 100, monthlyUsage: 1250000000, lastPayment: null,
    });
  });

  it("returns null for HTML without billing items", () => {
    expect(_parseDataSlotBillingData("<html><body>No data</body></html>")).toBeNull();
  });
});

describe("parseSsrPaymentData", () => {
  it("extracts amount from SSR payment list", () => {
    expect(_parseSsrPaymentData(ssrPayments({ amount: 2100000000 }))).toBe(21);
  });

  it("returns null for zero-amount (coupon) payments", () => {
    expect(_parseSsrPaymentData(ssrPayments({ amount: 0 }))).toBeNull();
  });
});

describe("parseDataSlotPaymentData", () => {
  it("skips refunded payments and uses the next", () => {
    expect(_parseDataSlotPaymentData(paymentTable({ amount: "10.00", refunded: true }, { amount: "20.00" }))).toBe(20);
  });

  it("returns null when all payments are refunded", () => {
    expect(_parseDataSlotPaymentData(paymentTable({ amount: "10.00", refunded: true }))).toBeNull();
  });
});

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches billing page and returns SSR parsed data", async () => {
    mockFetchHtml(ssrHtml(425000000, 20, 12500000));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: true, data: { balance: 425000000, monthlyLimit: 20, monthlyUsage: 12500000, lastPayment: null } });
  });

  it("falls back to data-slot format", async () => {
    mockFetchHtml(dataSlotHtml("42.50", "100.00", "12.50"));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: true, data: { balance: 4250000000, monthlyLimit: 100, monthlyUsage: 1250000000, lastPayment: null } });
  });

  it("reports HTTP error", async () => {
    mockFetchHttpError(403, "Forbidden");
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: expect.stringContaining("OpenCode Zen billing error 403") });
  });

  it("reports unparseable HTML", async () => {
    mockFetchHtml("<html><body>Nothing here</body></html>");
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: expect.stringContaining("Could not parse OpenCode Zen billing data") });
  });

  it("reports fetch errors", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("Network failure"));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: "Network failure" });
  });

  it("constructs correct URL and headers", async () => {
    mockFetchHtml(ssrHtml(50000000));
    await queryOpenCodeZenQuota("wrk_test123", "cookie-xyz");
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk_test123/billing",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Cookie: "auth=cookie-xyz" }) }),
      expect.any(Number),
    );
  });
});

// ---- Provider tests ----

describe("opencode provider", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("isAvailable", () => {
    it.each([
      ["configured", true],
      ["incomplete", false],
      ["invalid", false],
      ["none", false],
    ])("returns %s when config state is %s", async (state, expected) => {
      mockConfig(state as "configured" | "incomplete" | "invalid" | "none");
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
      mockFetchHttpError(403, "Forbidden");
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithErrorLabel(result, "OpenCode");
      expect(result.errors[0]?.message).toContain("OpenCode Zen billing error 403");
    });

    it("returns value entry when no monthly limit", async () => {
      mockConfig("configured");
      mockFetchHtml(ssrHtml(4250000000));
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      expect(result.entries[0]).toMatchObject({ kind: "value", group: "OpenCode Zen", value: "$42.50" });
    });

    it("returns percent entry when monthly limit exists", async () => {
      mockConfig("configured");
      mockFetchHtml(ssrHtml(4250000000, 100, 575000000));
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      expect(result.entries[0]).toMatchObject({ kind: "percent", group: "OpenCode Zen" });
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBeCloseTo(42.5, 1);
      }
    });

    it("uses plugin config opencodeMonthlyLimit when provided", async () => {
      mockConfig("configured");
      mockFetchHtml(ssrHtml(4250000000, 100, 575000000));
      const result = await opencodeProvider.fetch({ config: { opencodeMonthlyLimit: 200 } } as any);
      expectAttemptedWithNoErrors(result);
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBeCloseTo(21.25, 1);
      }
    });

    it.each([
      ["zero balance", 0, 100, 0],
      ["balance exceeds limit", 20000000000, 100, 100],
    ])("handles %s correctly", async (_label, balance, limit, expectedPercent) => {
      mockConfig("configured");
      mockFetchHtml(ssrHtml(balance, limit));
      const result = await opencodeProvider.fetch({ config: {} } as any);
      expectAttemptedWithNoErrors(result);
      if (result.entries[0]?.kind === "percent") {
        expect(result.entries[0].percentRemaining).toBe(expectedPercent);
      }
    });
  });
});
