import { describe, expect, it } from "vitest";

import { sanitizeQuotaProviderResult } from "../src/lib/display-sanitize.js";
import { accountingContractResult } from "./fixtures/accounting-contract.js";

describe("sanitizeQuotaProviderResult", () => {
  it("preserves presentation and owns nested accounting metadata", () => {
    const input = {
      ...accountingContractResult,
      presentation: {
        singleWindowDisplayName: "Fixture",
        singleWindowShowRight: true,
        classicStrategy: "preserve" as const,
      },
    };

    const sanitized = sanitizeQuotaProviderResult(input);
    expect(sanitized.presentation).toEqual(input.presentation);
    expect(sanitized.entries[0]?.accounting).toEqual(input.entries[0]?.accounting);
    expect(sanitized.entries[0]?.accounting).not.toBe(input.entries[0]?.accounting);
  });
});
