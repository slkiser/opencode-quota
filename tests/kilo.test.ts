import { describe, expect, it } from "vitest";

import { normalizeKiloCookieHeader } from "../src/lib/kilo-config.js";
import { parseKiloUsagePage, parseKiloUsageSummaryResponse } from "../src/lib/kilo.js";

describe("Kilo config", () => {
  it("keeps only the NextAuth session cookie", () => {
    expect(
      normalizeKiloCookieHeader(
        "Cookie: foo=bar; __Secure-next-auth.session-token=secret; analytics=value",
      ),
    ).toBe("__Secure-next-auth.session-token=secret");
  });

  it("rejects CRLF and missing session cookies", () => {
    expect(normalizeKiloCookieHeader("__Secure-next-auth.session-token=secret\nX: y")).toBeNull();
    expect(normalizeKiloCookieHeader("foo=bar")).toBeNull();
  });
});

describe("Kilo usage parser", () => {
  it("extracts usage data from Next.js JSON", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          creditBalanceMicrodollars: 37_500_000,
          usedMicrodollars: 12_500_000,
          limitMicrodollars: 50_000_000,
          currentPeriodEnd: "2026-08-01T00:00:00.000Z",
          planName: "Kilo Pass",
        },
      },
    })}</script>`;

    expect(parseKiloUsagePage(html)).toMatchObject({
      usedMicrodollars: 12_500_000,
      limitMicrodollars: 50_000_000,
      balanceMicrodollars: 37_500_000,
      resetTimeIso: "2026-08-01T00:00:00.000Z",
      planName: "Kilo Pass",
    });
  });

  it("extracts simple text fallback data", () => {
    expect(
      parseKiloUsagePage("Plan Kilo Pass Balance $37.50 Used $12.50 Limit $50.00 reset 2026-08-01"),
    ).toMatchObject({
      usedMicrodollars: 12_500_000,
      limitMicrodollars: 50_000_000,
      balanceMicrodollars: 37_500_000,
      resetTimeIso: "2026-08-01",
    });
  });

  it("returns null when usage page has no recognized data", () => {
    expect(parseKiloUsagePage("<html>sign in</html>")).toBeNull();
  });

  it("extracts personal usage summary from tRPC JSON", () => {
    expect(
      parseKiloUsageSummaryResponse(
        JSON.stringify({
          result: {
            data: {
              costMicrodollars: 125_000,
              requestCount: 3,
              totalTokens: 52_876,
              freeRequestCount: 1,
              byokRequestCount: 2,
            },
          },
        }),
      ),
    ).toMatchObject({
      usedMicrodollars: 125_000,
      requestCount: 3,
      totalTokens: 52_876,
      freeRequestCount: 1,
      byokRequestCount: 2,
      planName: "Last 30 days",
    });
  });
});
