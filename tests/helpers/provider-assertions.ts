import { expect } from "vitest";

import type { QuotaProviderResult, QuotaToastEntry } from "../../src/lib/entries.js";

export function expectNotAttempted(out: QuotaProviderResult): void {
  expect(out.attempted).toBe(false);
  expect(out.entries).toEqual([]);
  expect(out.errors).toEqual([]);
}

export const PROVIDER_ACCOUNTING_LEDGER: Record<string, Array<QuotaToastEntry["accounting"]>> = {
  anthropic: [
    {
      resultType: "quota",
      acquisitionMethod: "local_cli",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  copilot: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "usage",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  openai: [
    {
      resultType: "rate_limit",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  cursor: [
    {
      resultType: "budget",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "spend",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  "qwen-code": [
    {
      resultType: "quota",
      acquisitionMethod: "local_estimation",
      ownership: "maintained",
      authority: "locally_derived",
    },
    {
      resultType: "rate_limit",
      acquisitionMethod: "local_estimation",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  "alibaba-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "local_estimation",
      ownership: "maintained",
      authority: "locally_derived",
    },
  ],
  synthetic: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  chutes: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "google-antigravity": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "google-gemini-cli": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "google-agy": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  zai: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  zhipu: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  nanogpt: [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "minimax-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "minimax-china-coding-plan": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "kimi-for-coding": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  deepseek: [
    {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    {
      resultType: "status",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "opencode-go": [
    {
      resultType: "quota",
      acquisitionMethod: "dashboard_scrape",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "ollama-cloud": [
    {
      resultType: "quota",
      acquisitionMethod: "dashboard_scrape",
      ownership: "maintained",
      authority: "provider_reported",
    },
  ],
  "quota-providers": [
    {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
    {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
    {
      resultType: "spend",
      acquisitionMethod: "remote_api",
      ownership: "user_configured",
      authority: "provider_reported",
    },
  ],
};

export function visibleEntries(
  entries: QuotaToastEntry[],
  providerId?: string,
): Array<Record<string, unknown>> {
  return entries.map((entry) => {
    expect(entry.accounting).toEqual(
      expect.objectContaining({
        resultType: expect.stringMatching(/^(quota|rate_limit|usage|spend|budget|balance|status)$/),
        acquisitionMethod: expect.stringMatching(
          /^(remote_api|dashboard_scrape|local_cli|local_runtime_accounting|local_estimation)$/,
        ),
        ownership: expect.stringMatching(/^(maintained|user_configured)$/),
        authority: expect.stringMatching(/^(provider_reported|locally_derived)$/),
      }),
    );
    if (providerId) {
      expect(PROVIDER_ACCOUNTING_LEDGER[providerId]).toContainEqual(entry.accounting);
    }
    const { accounting: _accounting, ...visible } = entry;
    return visible;
  });
}

export function expectAttemptedWithNoErrors(out: QuotaProviderResult): void {
  expect(out.attempted).toBe(true);
  expect(out.errors).toEqual([]);
  visibleEntries(out.entries);
}

export function expectAttemptedWithErrorLabel(out: QuotaProviderResult, label: string): void {
  expect(out.attempted).toBe(true);
  expect(out.entries).toEqual([]);
  expect(out.errors[0]?.label).toBe(label);
}
