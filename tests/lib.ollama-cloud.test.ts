import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import {
  _extractPlanTier,
  _extractResetTimes,
  _extractUsagePercentFromTrack,
  queryOllamaCloudQuota,
} from "../src/lib/ollama-cloud.js";

function mockResponse(params: {
  ok: boolean;
  status: number;
  text?: string;
  headers?: Record<string, string>;
}) {
  mocks.fetchWithTimeout.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    headers: {
      get: (name: string) => params.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => params.text ?? "",
  });
}

function buildSettingsHtml(): string {
  return `
    <html>
      <body>
        <span class="capitalize">pro</span>
        <div data-usage-track aria-label="25% used"></div>
        <span class="local-time" data-time="2026-06-14T10:00:00.000Z"></span>
        <div data-usage-track aria-label="40.5% used"></div>
        <span class="local-time" data-time="2026-06-21T10:00:00.000Z"></span>
      </body>
    </html>
  `;
}

describe("queryOllamaCloudQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes a bare cookie value before sending the settings request", async () => {
    mockResponse({ ok: true, status: 200, text: buildSettingsHtml() });

    await queryOllamaCloudQuota("raw-cookie");

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://ollama.com/settings",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "__Secure-session=raw-cookie",
        }),
        redirect: "manual",
      }),
      10_000,
    );
  });

  it("does not duplicate the __Secure-session cookie prefix", async () => {
    mockResponse({ ok: true, status: 200, text: buildSettingsHtml() });

    await queryOllamaCloudQuota("__Secure-session=prefixed-cookie", { requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "__Secure-session=prefixed-cookie",
        }),
      }),
      1234,
    );
  });

  it("rejects CRLF in cookie values before making a request", async () => {
    const out = await queryOllamaCloudQuota("bad\r\nCookie: injected");

    expect(out).toEqual({
      success: false,
      error: "Cookie contains invalid CRLF characters",
    });
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("returns session and weekly usage from a successful settings page scrape", async () => {
    mockResponse({ ok: true, status: 200, text: buildSettingsHtml() });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out).toEqual({
      success: true,
      session: {
        usagePercent: 25,
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
      weekly: {
        usagePercent: 40.5,
        percentRemaining: 59.5,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
      planTier: "pro",
    });
  });

  it("returns session usage when only one valid usage track is present", async () => {
    mockResponse({
      ok: true,
      status: 200,
      text: `<div data-usage-track aria-label="25% used"></div>
        <span class="local-time" data-time="2026-06-14T10:00:00.000Z"></span>`,
    });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out).toEqual({
      success: true,
      session: {
        usagePercent: 25,
        percentRemaining: 75,
        resetTimeIso: "2026-06-14T10:00:00.000Z",
      },
    });
  });

  it("returns weekly usage when the first usage track is invalid and the second is valid", async () => {
    mockResponse({
      ok: true,
      status: 200,
      text: `<div data-usage-track aria-label="session"></div>
        <span class="local-time" data-time="2026-06-14T10:00:00.000Z"></span>
        <div data-usage-track aria-label="40% used"></div>
        <span class="local-time" data-time="2026-06-21T10:00:00.000Z"></span>`,
    });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out).toEqual({
      success: true,
      weekly: {
        usagePercent: 40,
        percentRemaining: 60,
        resetTimeIso: "2026-06-21T10:00:00.000Z",
      },
    });
  });

  it("parses style-only usage tracks without aria labels", async () => {
    mockResponse({
      ok: true,
      status: 200,
      text: '<div data-usage-track style="width: 33%"></div>',
    });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out).toEqual({
      success: true,
      session: {
        usagePercent: 33,
        percentRemaining: 67,
        resetTimeIso: undefined,
      },
    });
  });

  it("reports redirects as expired or invalid cookie authentication errors", async () => {
    mockResponse({
      ok: false,
      status: 302,
      headers: { location: "https://ollama.com/signin?next=/settings" },
    });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out && !out.success ? out.error : "").toBe(
      "Authentication error: redirected to https://ollama.com/signin?next=/settings — cookie may be expired",
    );
  });

  it("reports unauthorized settings responses without leaking the cookie", async () => {
    mockResponse({ ok: false, status: 401, text: "Unauthorized\nPlease sign in" });

    const out = await queryOllamaCloudQuota("secret-cookie");

    expect(out && !out.success ? out.error : "").toBe(
      "Ollama Cloud settings error 401: Unauthorized Please sign in",
    );
    expect(out && !out.success ? out.error : "").not.toContain("secret-cookie");
  });

  it("returns a clear parse error for non-matching settings HTML", async () => {
    mockResponse({ ok: true, status: 200, text: "<html><body>No usage data here</body></html>" });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out && !out.success ? out.error : "").toBe(
      "Could not parse usage tracks from Ollama Cloud settings page (found 0)",
    );
  });

  it("returns a clear parse error when usage tracks do not contain percentages", async () => {
    mockResponse({
      ok: true,
      status: 200,
      text: '<div data-usage-track aria-label="session"></div><div data-usage-track aria-label="weekly"></div>',
    });

    const out = await queryOllamaCloudQuota("cookie");

    expect(out && !out.success ? out.error : "").toBe(
      "Could not extract any usage percentages from Ollama Cloud settings page",
    );
  });
});

describe("ollama-cloud HTML parsing helpers", () => {
  it("extracts usage percentages from aria labels and width styles", () => {
    expect(_extractUsagePercentFromTrack('data-usage-track aria-label="12.5% used"')).toBe(12.5);
    expect(
      _extractUsagePercentFromTrack('data-usage-track style="width: 33%" aria-label="usage"'),
    ).toBe(33);
  });

  it("extracts reset times and plan tier", () => {
    const html = '<span class="local-time" data-time="2026-06-14T10:00:00Z"></span><span class="capitalize">free</span>';

    expect(_extractResetTimes(html)).toEqual(["2026-06-14T10:00:00Z"]);
    expect(_extractPlanTier(html)).toBe("free");
  });
});
