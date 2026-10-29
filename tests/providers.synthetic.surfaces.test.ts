import { describe, expect, it } from "vite-plus/test";

import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const EMPTY_OBJECT_DIAGNOSTIC = "Synthetic returned no quota data for this account.";

const emptyObjectData: QuotaRenderData = {
  entries: [],
  errors: [{ label: "Synthetic", message: EMPTY_OBJECT_DIAGNOSTIC }],
};

describe("Synthetic empty-object four-surface formatting", () => {
  it("shows the no-quota diagnostic without fabricating rows or auth inference", () => {
    const outputs = renderAccountingFourSurfaces({
      data: emptyObjectData,
      accountingDetail: "summary",
      toastMaxWidth: 64,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain(EMPTY_OBJECT_DIAGNOSTIC);
      expect(output).not.toContain("5h:");
      expect(output).not.toContain("Weekly:");
      expect(output).not.toContain("0/0");
      expect(output).not.toContain("$0/$0");
      expect(output).not.toContain("Clerk");
      expect(output).not.toContain("invalid");
      expect(output).not.toContain("subscription");
      expect(output).not.toMatch(/[█░]/u);
    }
  });
});
