import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { rowsFromProviderResult } from "../src/core/rows.js";
import type { Amount, QuotaRow } from "../src/core/types.js";
import { getCopilotQuotaAuthDiagnostics, queryCopilotQuota } from "../src/lib/copilot.js";
import { copilotProvider } from "../src/providers/copilot.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

/** A PAT config by default: its one query gives the rows. */
const logins = vi.hoisted(() => ({ pat: { state: "valid" }, oauth: [] as unknown[] }));

vi.mock("../src/lib/copilot.js", () => ({
  readCopilotLogins: vi.fn(async () => ({ ...logins })),
  queryCopilotQuota: vi.fn(),
  getCopilotQuotaAuthDiagnostics: vi.fn(),
}));

const NOW_MS = Date.parse("2026-01-15T00:00:00.000Z");
const RESET = "2026-02-01T00:00:00.000Z";

function diagnostics(effectiveSource: "pat" | "oauth" | "none", billingScope = "none") {
  return {
    pat: { state: "absent", checkedPaths: [] },
    oauth: {
      configured: effectiveSource === "oauth",
      keyName: null,
      hasRefreshToken: false,
      hasAccessToken: false,
      hasEnterpriseUrl: false,
    },
    effectiveSource,
    billingScope,
    billingApiAccessLikely: false,
  } as unknown as ReturnType<typeof getCopilotQuotaAuthDiagnostics>;
}

async function fetchRows() {
  return rowsFromProviderResult("copilot", await copilotProvider.fetch({} as never), NOW_MS);
}

function amount(value: Amount | undefined): string | null {
  if (!value) return null;
  return `${value.decimal} ${value.unit.kind === "currency" ? value.unit.code : value.unit.kind === "count" ? value.unit.unit : value.unit.symbol}`;
}

/** id, account, label, type, authority, value, used, limit, reset. */
function summary(rows: QuotaRow[]) {
  return rows.map((row) => [
    row.id,
    row.account ?? null,
    row.label,
    row.type,
    row.authority,
    row.percentRemaining ?? row.text,
    amount(row.used),
    amount(row.limit),
    row.resetsAt ?? null,
  ]);
}

beforeEach(() => {
  vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValue(diagnostics("none"));
  logins.pat = { state: "valid" };
  logins.oauth = [];
});

describe("copilot provider", () => {
  it.each([
    [
      "not set up when Copilot accounting is unavailable",
      null,
      { rows: [], error: { code: "not_configured" } },
      null,
    ],
    [
      "a failed query as the error",
      { success: false, error: "Forbidden" },
      { rows: [], error: { code: "internal", detail: "Forbidden" } },
      "Copilot: Forbidden",
    ],
  ])("reports %s", async (_name, result, expected, errorLine) => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce(result as never);

    const fetched = await fetchRows();

    expect(fetched).toMatchObject(expected);
    if (errorLine) expect(fetched.debug).toContainEqual({ key: "error", value: errorLine });
  });

  it.each([
    {
      name: "personal AI Credit usage without a limit as text",
      result: {
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        period: { year: 2026, month: 1 },
        used: 100,
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        authority: "provider_reported",
      },
      rows: [
        [
          "copilot.allowance",
          "personal",
          "Credits",
          "usage",
          "provider_reported",
          "Used 100 | Included 80 | Billed 20 ($0.20)",
          null,
          null,
          null,
        ],
      ],
    },
    {
      name: "premium interactions with used and limit, rounded as shown",
      result: {
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 600.505,
        total: 1000,
        percentRemaining: 40,
        authority: "locally_derived",
        plan: "enterprise",
        resetTimeIso: RESET,
      },
      rows: [
        [
          "copilot.allowance",
          "enterprise",
          "Premium interactions",
          "quota",
          "locally_derived",
          40,
          "600.51 interaction",
          "1000 interaction",
          RESET,
        ],
      ],
    },
    {
      name: "over-limit AI credits with a clamped percentage",
      result: {
        success: true,
        mode: "user_quota",
        unit: "ai_credits",
        used: 3739,
        total: 3000,
        percentRemaining: 0,
        authority: "provider_reported",
        plan: "business",
      },
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "quota",
          "provider_reported",
          0,
          "3739 credit",
          "3000 credit",
          null,
        ],
      ],
    },
    {
      name: "legacy premium requests",
      result: {
        success: true,
        mode: "user_quota",
        unit: "premium_requests",
        used: 150,
        total: 1500,
        percentRemaining: 90,
        authority: "locally_derived",
        plan: "pro+",
      },
      rows: [
        [
          "copilot.allowance",
          "pro+",
          "Premium requests",
          "quota",
          "locally_derived",
          90,
          "150 request",
          "1500 request",
          null,
        ],
      ],
    },
    {
      name: "unlimited premium requests as text",
      result: {
        success: true,
        mode: "user_quota",
        unit: "premium_requests",
        used: 5,
        unlimited: true,
        authority: "provider_reported",
        plan: "pro",
        resetTimeIso: RESET,
      },
      rows: [
        [
          "copilot.allowance",
          "pro",
          "Premium requests",
          "quota",
          "provider_reported",
          "Unlimited",
          null,
          null,
          RESET,
        ],
      ],
    },
    {
      name: "the plan alone when usage needs a billing token",
      result: {
        success: true,
        mode: "user_plan",
        authority: "provider_reported",
        plan: "business",
        resetTimeIso: RESET,
      },
      rows: [
        [
          "copilot.allowance",
          "business",
          "Plan",
          "quota",
          "provider_reported",
          "business | usage needs billing token",
          null,
          null,
          RESET,
        ],
      ],
    },
    {
      name: "pooled organization credits plus an additional-usage budget",
      result: {
        success: true,
        mode: "organization_usage",
        organization: "acme",
        username: "alice",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 100,
        authority: "provider_reported",
        includedUsed: 80,
        billedUsed: 20,
        billedAmountUsd: 0.2,
        budget: {
          amountUsd: 1,
          spentUsd: 0.2,
          scope: "user",
          percentRemaining: 80,
          authority: "locally_derived",
        },
      },
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "usage",
          "provider_reported",
          "Used 100 | Included 80 | Billed 20 ($0.20) | 2026-01 | org=acme | user=alice",
          null,
          null,
          null,
        ],
        [
          "copilot.additional_budget",
          "business",
          "Budget",
          "budget",
          "locally_derived",
          80,
          "0.2 USD",
          "1 USD",
          null,
        ],
      ],
    },
    {
      name: "a zero budget as text",
      result: {
        success: true,
        mode: "enterprise_usage",
        enterprise: "octo",
        period: { year: 2026, month: 1 },
        unit: "ai_credits",
        used: 10,
        authority: "provider_reported",
        includedUsed: 0,
        billedUsed: 10,
        billedAmountUsd: 0.1,
        budget: {
          amountUsd: 0,
          spentUsd: 0.1,
          scope: "enterprise",
          authority: "provider_reported",
        },
      },
      rows: [
        [
          "copilot.allowance",
          "business",
          "Credits",
          "usage",
          "provider_reported",
          "Used 10 | Included 0 | Billed 10 ($0.10) | 2026-01 | enterprise=octo",
          null,
          null,
          null,
        ],
        [
          "copilot.additional_budget",
          "business",
          "Budget",
          "budget",
          "provider_reported",
          "$0.10 spent | $0.00 budget | scope=enterprise",
          null,
          null,
          null,
        ],
      ],
    },
  ])("shows $name", async ({ result, rows }) => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce(result as never);

    const fetched = await fetchRows();

    expect(fetched.error).toBeUndefined();
    expect(summary(fetched.rows)).toEqual(rows);
  });

  it("keeps a failed budget read next to the usage it has", async () => {
    vi.mocked(queryCopilotQuota).mockResolvedValueOnce({
      success: true,
      mode: "organization_usage",
      organization: "acme",
      period: { year: 2026, month: 1 },
      unit: "ai_credits",
      used: 10,
      authority: "provider_reported",
      includedUsed: 10,
      billedUsed: 0,
      warnings: ["Budget endpoint forbidden"],
    });

    const fetched = await fetchRows();

    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["copilot.allowance", "business"],
    ]);
    expect(fetched.error).toMatchObject({ code: "internal" });
    expect(fetched.debug).toContainEqual({
      key: "error",
      value: "Copilot: Budget endpoint forbidden",
    });
  });

  it("queries each OpenCode login and shows one it could not read as an error", async () => {
    vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValue(diagnostics("oauth", "user"));
    logins.pat = { state: "absent" };
    logins.oauth = [
      {
        id: "copilot-alice",
        integrationId: "github-copilot",
        label: "alice",
        active: true,
        value: { type: "oauth" },
        resolveError: "refresh_failed: HTTP 401",
      },
      {
        id: "copilot-bob",
        integrationId: "github-copilot",
        label: "bob",
        active: false,
        value: { type: "oauth", access: "bob-token", enterpriseUrl: "acme.ghe.com" },
      },
    ];
    const signInError =
      "Copilot sign-in could not be read: refresh_failed: HTTP 401. Run `opencode auth login github-copilot`.";
    vi.mocked(queryCopilotQuota)
      .mockResolvedValueOnce({ success: false, error: signInError })
      .mockResolvedValueOnce({
        success: true,
        mode: "user_quota",
        unit: "premium_interactions",
        used: 600,
        total: 1_000,
        percentRemaining: 40,
        authority: "provider_reported",
        plan: "enterprise",
      });

    const fetched = await fetchRows();

    expect(vi.mocked(queryCopilotQuota).mock.calls.map(([options]) => options?.authData)).toEqual([
      { "github-copilot": { type: "oauth", resolveError: "refresh_failed: HTTP 401" } },
      { "github-copilot": { type: "oauth", access: "bob-token", enterpriseUrl: "acme.ghe.com" } },
    ]);
    expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
      ["copilot.allowance", "bob (enterprise)"],
    ]);
    expect(fetched.rowLogins).toEqual(["copilot-bob"]);
    expect(fetched.debug).toEqual(
      expect.arrayContaining([
        { key: "billing_scope", value: "user" },
        { key: "error", value: `[Copilot alice] (active): ${signInError}` },
      ]),
    );
  });

  it("uses runtime provider ids or trusted local billing auth for availability", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providerIds: ["github-copilot"] }),
      ),
    ).resolves.toBe(true);

    const openAiOnly = createProviderAvailabilityContext({ providerIds: ["openai"] });
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(false);
    vi.mocked(getCopilotQuotaAuthDiagnostics).mockReturnValueOnce({
      ...diagnostics("pat"),
      billingApiAccessLikely: true,
    });
    await expect(copilotProvider.isAvailable(openAiOnly)).resolves.toBe(true);
  });

  it("does not claim availability when provider lookup throws", async () => {
    await expect(
      copilotProvider.isAvailable(
        createProviderAvailabilityContext({ providersError: new Error("boom") }),
      ),
    ).resolves.toBe(false);
  });
});
