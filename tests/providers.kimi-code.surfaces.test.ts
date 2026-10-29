import { describe, expect, it } from "vite-plus/test";

import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const bothRegionsData: QuotaRenderData = {
  entries: [
    {
      accounting: ACCOUNTING,
      name: "Kimi Code Weekly limit",
      group: "Kimi Code",
      label: "Weekly:",
      right: "20/100",
      percentRemaining: 80,
    },
    {
      accounting: ACCOUNTING,
      name: "Kimi Code (CN) Weekly limit",
      group: "Kimi Code (CN)",
      label: "Weekly:",
      right: "60/100",
      percentRemaining: 40,
    },
  ],
  errors: [],
};

describe("Kimi regional four-surface formatting", () => {
  it("keeps Global and CN quota rows distinguishable on command, toast, sidebar, and compact output", () => {
    const outputs = renderAccountingFourSurfaces({
      data: bothRegionsData,
      accountingDetail: "summary",
      toastMaxWidth: 80,
      toastNarrowAt: 44,
      compactMaxWidth: 200,
    });

    for (const [surface, output] of Object.entries(outputs)) {
      expect(output, surface).toContain("Kimi Code");
      expect(output, surface).toContain("(CN)");
      expect(output, surface).toContain("80%");
      expect(output, surface).toContain("40%");
    }
  });
});
