import { expect } from "vitest";

import type { buildQuotaStatusReport } from "../../src/lib/quota-status.js";

type QuotaStatusReportParams = Parameters<typeof buildQuotaStatusReport>[0];
type ProviderAvailability = QuotaStatusReportParams["providerAvailability"][number];

export const DEFAULT_QUOTA_STATUS_REPORT_GENERATED_AT_MS = Date.UTC(2026, 2, 12, 12, 45, 0);

export function makeProviderAvailability(
  id: string,
  overrides: Partial<Omit<ProviderAvailability, "id">> = {},
): ProviderAvailability {
  return {
    id,
    enabled: true,
    available: true,
    ...overrides,
  };
}

export function makeProviderAvailabilityList(
  providerIds: readonly string[],
  overridesByProviderId: Record<string, Partial<Omit<ProviderAvailability, "id">>> = {},
): ProviderAvailability[] {
  return providerIds.map((id) => makeProviderAvailability(id, overridesByProviderId[id]));
}

export function makeQuotaStatusReportParams(
  overrides: Partial<QuotaStatusReportParams> = {},
): QuotaStatusReportParams {
  const { enabledProviders = [], providerAvailability, ...rest } = overrides;
  const resolvedProviderAvailability =
    providerAvailability ??
    (Array.isArray(enabledProviders) ? makeProviderAvailabilityList(enabledProviders) : []);

  return {
    configSource: "test",
    configPaths: [],
    enabledProviders,
    cursorPlan: "none",
    pricingSnapshotSource: "auto",
    onlyCurrentModel: false,
    providerAvailability: resolvedProviderAvailability,
    generatedAtMs: DEFAULT_QUOTA_STATUS_REPORT_GENERATED_AT_MS,
    ...rest,
  } as QuotaStatusReportParams;
}

export async function buildQuotaStatusReportForTest(
  overrides: Partial<QuotaStatusReportParams> = {},
): Promise<string> {
  const { buildQuotaStatusReport } = await import("../../src/lib/quota-status.js");
  return buildQuotaStatusReport(makeQuotaStatusReportParams(overrides));
}

export async function buildProviderStatusReport(
  providerIds: string | readonly string[],
  overrides: Partial<QuotaStatusReportParams> = {},
): Promise<string> {
  const enabledProviders = Array.isArray(providerIds) ? [...providerIds] : [providerIds];
  return buildQuotaStatusReportForTest({
    enabledProviders,
    providerAvailability: makeProviderAvailabilityList(enabledProviders),
    ...overrides,
  });
}

export function getReportSection(report: string, title: string): string {
  const start = report.indexOf(`${title}\n`);
  expect(start).toBeGreaterThanOrEqual(0);

  const rest = report.slice(start + title.length + 1);
  const nextSectionOffset = rest.search(/\n[a-z0-9_]+:\n/u);
  if (nextSectionOffset === -1) {
    return report.slice(start);
  }

  return report.slice(start, start + title.length + 1 + nextSectionOffset);
}

export function expectReportSection(
  report: string,
  title: string,
  expectedLines: readonly string[],
  absentLines: readonly string[] = [],
): string {
  const section = getReportSection(report, title);
  for (const line of expectedLines) {
    expect(section).toContain(line);
  }
  for (const line of absentLines) {
    expect(section).not.toContain(line);
  }
  return section;
}
