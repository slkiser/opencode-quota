import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  _parseSsrBillingData,
  _parseDataSlotBillingData,
  _parseSsrPaymentData,
  _parseDataSlotPaymentData,
  queryOpenCodeZenQuota,
} from "../src/lib/opencode-zen.js";

// ---- Helpers ----

const ssrHtml = (balance: number, monthlyLimit?: number, monthlyUsage?: number): string =>
  monthlyLimit !== undefined && monthlyUsage !== undefined
    ? `<!DOCTYPE html><html><body><div id="root">$R[42]={billing:{balance:${balance},monthlyLimit:${monthlyLimit},monthlyUsage:${monthlyUsage}}}</div></body></html>`
    : `<!DOCTYPE html><html><body><div id="root">$R[42]={billing:{balance:${balance}}}</div></body></html>`;

const ssrHtmlOrder = (monthlyUsage: number, monthlyLimit: number, balance: number): string =>
  `<!DOCTYPE html><html><body><div id="root">$R[42]={billing:{monthlyUsage:${monthlyUsage},monthlyLimit:${monthlyLimit},balance:${balance}}}</div></body></html>`;

const dataSlotHtml = (balanceUsd: string, monthlyLimitUsd?: string, monthlyUsageUsd?: string): string => {
  let items = `<div data-slot="billing-item"><span data-slot="billing-label">Balance</span><span data-slot="billing-value">$${balanceUsd}</span></div>`;
  if (monthlyLimitUsd) items += `<div data-slot="billing-item"><span data-slot="billing-label">Monthly Limit</span><span data-slot="billing-value">$${monthlyLimitUsd}</span></div>`;
  if (monthlyUsageUsd) items += `<div data-slot="billing-item"><span data-slot="billing-label">Monthly Usage</span><span data-slot="billing-value">$${monthlyUsageUsd}</span></div>`;
  return `<!DOCTYPE html><html><body>${items}</body></html>`;
};

const ssrPayments = (...payments: Array<{ amount: number }>) =>
  `$R["payment.list"]=${JSON.stringify(payments.map(p => ({ id: "pay_01J", workspaceID: "wrk", timeCreated: new Date().toISOString(), amount: p.amount })))}`;

const paymentTable = (...payments: Array<{ amount: string; refunded?: boolean }>) => {
  const rows = payments.map(p => `<tr><td data-slot="payment-date">Jan 15</td><td data-slot="payment-id">pay_01J</td><td data-slot="payment-amount"${p.refunded ? ' data-refunded="true"' : ""}>$${p.amount}</td><td data-slot="payment-receipt">-</td></tr>`).join("");
  return `<div data-slot="payments-table"><table data-slot="payments-table-element"><thead><tr><th>Date</th><th>Payment ID</th><th>Amount</th><th>Receipt</th></tr></thead><tbody>${rows}</tbody></table></div>`;
};

const mockResponse = (body: string, status = 200, ok = true) => ({
  ok, status, text: vi.fn().mockResolvedValue(body),
});

// ---- Tests ----

describe("parseSsrBillingData", () => {
  it.each([
    ["balance, monthlyLimit, monthlyUsage", ssrHtml(425000000, 20, 12500000), { balance: 425000000, monthlyLimit: 20, monthlyUsage: 12500000, lastPayment: null }],
    ["different field order", ssrHtmlOrder(12500000, 20, 425000000), { balance: 425000000, monthlyLimit: 20, monthlyUsage: 12500000, lastPayment: null }],
    ["balance only (no limit)", ssrHtml(50000000), { balance: 50000000, monthlyLimit: null, monthlyUsage: null, lastPayment: null }],
  ])("parses %s", (_name, html, expected) => {
    expect(_parseSsrBillingData(html)).toEqual(expected);
  });

  it.each([
    ["no billing data", "<html><body>No data</body></html>"],
    ["negative balance", `$R[42]={billing:{balance:-100}}`],
    ["empty HTML", ""],
  ])("returns null for %s", (_name, html) => {
    expect(_parseSsrBillingData(html)).toBeNull();
  });
});

describe("parseDataSlotBillingData", () => {
  it.each([
    ["balance + limit + usage", dataSlotHtml("42.50", "100.00", "12.50"), { balance: 4250000000, monthlyLimit: 100, monthlyUsage: 1250000000, lastPayment: null }],
    ["balance only", dataSlotHtml("15.00"), { balance: 1500000000, monthlyLimit: null, monthlyUsage: null, lastPayment: null }],
  ])("parses %s", (_name, html, expected) => {
    expect(_parseDataSlotBillingData(html)).toEqual(expected);
  });

  it.each([
    ["no matching items", "<html><body>No data</body></html>"],
    ["empty HTML", ""],
  ])("returns null for %s", (_name, html) => {
    expect(_parseDataSlotBillingData(html)).toBeNull();
  });
});

describe("parseSsrPaymentData", () => {
  it.each([
    ["extracts amount from SSR payment list", ssrPayments({ amount: 2100000000 }), 21],
    ["uses first (most recent) payment", ssrPayments({ amount: 2000000000 }, { amount: 500000000 }), 20],
  ])("%s", (_name, html, expected) => {
    expect(_parseSsrPaymentData(html)).toBe(expected);
  });

  it.each([
    ["no payment list present", "<html><body>No payments</body></html>", null],
    ["zero-amount (coupon) payments", ssrPayments({ amount: 0 }), null],
    ["empty HTML", "", null],
  ])("returns %s", (_name, html, expected) => {
    expect(_parseSsrPaymentData(html)).toBe(expected);
  });
});

describe("parseDataSlotPaymentData", () => {
  it.each([
    ["first non-refunded payment", paymentTable({ amount: "21.00" }), 21],
    ["skips refunded, uses next", paymentTable({ amount: "10.00", refunded: true }, { amount: "20.00" }), 20],
  ])("extracts %s", (_name, html, expected) => {
    expect(_parseDataSlotPaymentData(html)).toBe(expected);
  });

  it.each([
    ["no payment table", "<html><body>No payments</body></html>", null],
    ["all payments refunded", paymentTable({ amount: "10.00", refunded: true }), null],
    ["empty HTML", "", null],
  ])("returns null when %s", (_name, html, _expected) => {
    expect(_parseDataSlotPaymentData(html)).toBeNull();
  });
});

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches billing page and returns SSR parsed data", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse(ssrHtml(425000000, 20, 12500000)));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: true, data: { balance: 425000000, monthlyLimit: 20, monthlyUsage: 12500000, lastPayment: null } });
  });

  it("falls back to data-slot format", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse(dataSlotHtml("42.50", "100.00", "12.50")));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: true, data: { balance: 4250000000, monthlyLimit: 100, monthlyUsage: 1250000000, lastPayment: null } });
  });

  it("reports HTTP error", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse("Forbidden", 403, false));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: expect.stringContaining("OpenCode Zen billing error 403") });
  });

  it("reports unparseable HTML", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse("<html><body>Nothing here</body></html>"));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: expect.stringContaining("Could not parse OpenCode Zen billing data") });
  });

  it("reports fetch errors", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("Network failure"));
    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-def");
    expect(result).toEqual({ success: false, error: "Network failure" });
  });

  it("constructs correct URL and headers", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(mockResponse(ssrHtml(50000000)));
    await queryOpenCodeZenQuota("wrk_test123", "cookie-xyz");
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk_test123/billing",
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Cookie: "auth=cookie-xyz" }) }),
      expect.any(Number),
    );
  });
});
