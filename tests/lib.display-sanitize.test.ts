import { describe, expect, it } from "vite-plus/test";

import { sanitizeQuotaProviderResult } from "../src/lib/display-sanitize.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import { accountingContractResult } from "./fixtures/accounting-contract.js";

const ACCOUNTING = accountingContractResult.entries[0]!.accounting;

describe("sanitizeQuotaProviderResult", () => {
  it("sanitizes and owns nested structured accounting data", () => {
    const input = {
      attempted: true,
      entries: [
        {
          accounting: { ...ACCOUNTING },
          kind: "percent",
          name: "Budget\u001b[31m",
          group: "Example\u001b[0m",
          metricLabel: "Monthly\u001b[31m",
          percentRemaining: 75,
          resetTimeIso: "2026-09-01T00:00:00.000Z",
          fixedWindow: {
            kind: "fixed_window",
            startedAtIso: "2026-08-01T00:00:00.000Z",
            observedAtIso: "2026-08-21T12:34:56.000Z",
            endsAtIso: "2026-09-01T00:00:00.000Z",
            fullReset: true,
          },
          runway: { kind: "before_reset", projectedAtIso: "2026-08-25T00:00:00.000Z" },
          semantic: {
            metric: { kind: "named", name: "Known\u001b[31m API" },
            prominence: "primary",
          },
          basis: {
            used: {
              quantity: {
                decimal: "5.75",
                unit: { kind: "custom", symbol: "NANO\u001b[31m" },
              },
              authority: "provider_reported",
            },
          },
        },
        {
          accounting: { ...ACCOUNTING, resultType: "balance" },
          kind: "quantity",
          name: "Balance",
          semantic: {
            metric: { kind: "component", component: "current_balance" },
            prominence: "supplementary",
          },
          quantity: { decimal: "42.500", unit: { kind: "currency", code: "USD" } },
        },
        {
          accounting: { ...ACCOUNTING, resultType: "status" },
          kind: "boolean",
          name: "Reload",
          semantic: {
            metric: { kind: "component", component: "auto_reload" },
            prominence: "supplementary",
          },
          value: true,
        },
        {
          accounting: { ...ACCOUNTING, resultType: "status" },
          kind: "value",
          name: "Legacy",
          value: "Active\u001b[31m",
        },
      ],
      errors: [{ label: "Remote\u001b[31m", message: "failed\u001b[0m", retryable: true }],
      statusDetails: [{ key: "balance\u001b[31m", value: "USD 42.50\u001b[0m" }],
      rawDetails: [{ key: "usage\u001b[31m", value: "USD 2.50\u001b[0m" }],
      presentation: {
        singleWindowDisplayName: "Fixture\u001b[31m",
        singleWindowShowRight: true,
        redundantQuotaFamily: "Claude\u001b[31m",
        classicStrategy: "preserve" as const,
      },
    } satisfies QuotaProviderResult;

    const sanitized = sanitizeQuotaProviderResult(input);
    expect(sanitized.entries[0]).toMatchObject({
      name: "Budget",
      group: "Example",
      metricLabel: "Monthly",
      semantic: { metric: { kind: "named", name: "Known API" } },
      basis: { used: { quantity: { unit: { kind: "custom", symbol: "NANO" } } } },
      fixedWindow: {
        observedAtIso: "2026-08-21T12:34:56.000Z",
        endsAtIso: "2026-09-01T00:00:00.000Z",
      },
      runway: { kind: "before_reset", projectedAtIso: "2026-08-25T00:00:00.000Z" },
    });
    expect(sanitized.entries[1]).toMatchObject({
      quantity: { decimal: "42.500", unit: { kind: "currency", code: "USD" } },
    });
    expect(sanitized.entries[2]).toMatchObject({ kind: "boolean", value: true });
    expect(sanitized.entries[3]).toMatchObject({ kind: "value", value: "Active" });
    expect(sanitized.errors).toEqual([{ label: "Remote", message: "failed", retryable: true }]);
    expect(sanitized.statusDetails).toEqual([{ key: "balance", value: "USD 42.50" }]);
    expect(sanitized.rawDetails).toEqual([{ key: "usage", value: "USD 2.50" }]);
    expect(sanitized.presentation).toEqual({
      singleWindowDisplayName: "Fixture",
      singleWindowShowRight: true,
      redundantQuotaFamily: "Claude",
      classicStrategy: "preserve",
    });

    const sanitizedPercent = sanitized.entries[0] as any;
    const inputPercent = input.entries[0] as any;
    expect(sanitizedPercent.accounting).not.toBe(inputPercent.accounting);
    expect(sanitizedPercent.semantic).not.toBe(inputPercent.semantic);
    expect(sanitizedPercent.semantic.metric).not.toBe(inputPercent.semantic.metric);
    expect(sanitizedPercent.basis.used).not.toBe(inputPercent.basis.used);
    expect(sanitizedPercent.basis.used.quantity).not.toBe(inputPercent.basis.used.quantity);
    expect(sanitizedPercent.basis.used.quantity.unit).not.toBe(
      inputPercent.basis.used.quantity.unit,
    );
    expect(sanitizedPercent.fixedWindow).not.toBe(inputPercent.fixedWindow);
    expect(sanitizedPercent.runway).not.toBe(inputPercent.runway);
    expect(sanitized.presentation).not.toBe(input.presentation);
    expect(sanitized.statusDetails).not.toBe(input.statusDetails);
    expect(sanitized.rawDetails).not.toBe(input.rawDetails);
  });
});
