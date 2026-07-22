import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  _parseDataSlotBillingData,
  _parseDataSlotPaymentData,
  _parseSsrBillingData,
  _parseSsrPaymentData,
  queryOpenCodeZenQuota,
} from "../src/lib/opencode-zen.js";

function response(body: string, status = 200): Response {
  return new Response(body, { status });
}

function ssrHtml(balance: number, monthlyLimit?: number, monthlyUsage?: number): string {
  const fields = [
    `monthlyUsage:${monthlyUsage ?? ""}`,
    `balance:${balance}`,
    `monthlyLimit:${monthlyLimit ?? ""}`,
  ].join(",");
  return `<html><script>$R[42]={billing:{${fields}}}</script></html>`;
}

function dataSlotHtml(): string {
  return `<div data-slot="billing-item">
    <span data-slot="billing-label">Balance</span>
    <span data-slot="billing-value">$42.50</span>
  </div>
  <div data-slot="billing-item">
    <span data-slot="billing-label">Monthly Limit</span>
    <span data-slot="billing-value">$100.00</span>
  </div>
  <div data-slot="billing-item">
    <span data-slot="billing-label">Monthly Usage</span>
    <span data-slot="billing-value">$12.50</span>
  </div>`;
}

describe("OpenCode Zen billing parser", () => {
  it("parses SolidJS fields independently of field order", () => {
    expect(_parseSsrBillingData(ssrHtml(425_000_000, 20, 12_500_000))).toEqual({
      balance: 425_000_000,
      monthlyLimit: 20,
      monthlyUsage: 12_500_000,
      lastPayment: null,
    });
  });

  it("accepts a zero balance and omits missing optional values", () => {
    expect(_parseSsrBillingData("$R[1]={billing:{balance:0}}")).toEqual({
      balance: 0,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
    });
  });

  it.each([
    ["empty HTML", ""],
    ["missing balance", "$R[1]={billing:{monthlyLimit:20}}"],
    ["negative balance", "$R[1]={billing:{balance:-1}}"],
  ])("rejects %s", (_label, html) => {
    expect(_parseSsrBillingData(html)).toBeNull();
  });

  it("parses the data-slot fallback and preserves PR #140 units", () => {
    expect(_parseDataSlotBillingData(dataSlotHtml())).toEqual({
      balance: 42.5 * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      monthlyLimit: 100,
      monthlyUsage: 12.5 * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
      lastPayment: null,
    });
  });

  it("parses the original SSR payment-list fallback", () => {
    expect(
      _parseSsrPaymentData('$R["payment.list"]=[{"amount":2100000000,"workspaceID":"wrk"}]'),
    ).toBe(21);
  });

  it("uses the first non-refunded positive data-slot payment", () => {
    const html = `<table data-slot="payments-table-element">
      <tr><td data-slot="payment-amount" data-refunded="true">$10.00</td></tr>
      <tr><td data-slot="payment-amount">$20.00</td></tr>
    </table>`;
    expect(_parseDataSlotPaymentData(html)).toBe(20);
  });
});

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the exact fixed GET contract from PR #140", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(response("$R[1]={billing:{balance:50000000}}"));

    await queryOpenCodeZenQuota("wrk /unsafe", "cookie-secret", {
      requestTimeoutMs: 4_321,
    });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/workspace/wrk%20%2Funsafe/billing",
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
          Accept: "text/html",
          Cookie: "auth=cookie-secret",
        },
      },
      4_321,
    );
    const init = mocks.fetchWithTimeout.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("returns parsed SSR data and attaches the payment fallback", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      response(
        "$R[1]={billing:{balance:4250000000,monthlyLimit:100,monthlyUsage:575000000}}" +
          '$R["payment.list"]=[{"amount":2100000000}]',
      ),
    );

    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 575_000_000,
        lastPayment: 21,
      },
    });
  });

  it("falls back to data-slot billing HTML", async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(response(dataSlotHtml()));

    await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 1_250_000_000,
        lastPayment: null,
      },
    });
  });

  it.each(["", "<html><body>Nothing here</body></html>"])(
    "returns a stable parse error for malformed or empty HTML",
    async (html) => {
      mocks.fetchWithTimeout.mockResolvedValueOnce(response(html));
      await expect(queryOpenCodeZenQuota("wrk_abc", "cookie")).resolves.toEqual({
        success: false,
        error: expect.stringContaining("Could not parse OpenCode Zen billing data"),
      });
    },
  );

  it("does not expose an HTTP response body", async () => {
    const secretBody = "private-html-body-cookie-secret";
    mocks.fetchWithTimeout.mockResolvedValueOnce(response(secretBody, 403));

    const result = await queryOpenCodeZenQuota("wrk_abc", "cookie-secret");

    expect(result).toEqual({
      success: false,
      error: "OpenCode Zen billing error 403",
    });
    expect(JSON.stringify(result)).not.toContain(secretBody);
    expect(JSON.stringify(result)).not.toContain("cookie-secret");
  });

  it("sanitizes network and timeout errors and redacts configured secrets", async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(
      new Error("\u001b[31mtimeout for wrk_secret with cookie-secret\nretry\u001b[0m"),
    );

    const result = await queryOpenCodeZenQuota("wrk_secret", "cookie-secret");

    expect(result).toEqual({
      success: false,
      error: "timeout for [redacted] with [redacted] retry",
    });
    expect(JSON.stringify(result)).not.toContain("wrk_secret");
    expect(JSON.stringify(result)).not.toContain("cookie-secret");
  });
});
