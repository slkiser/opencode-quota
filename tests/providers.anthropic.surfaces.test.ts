import { describe, expect, it } from "vitest";

import type { QuotaToastEntry } from "../src/lib/entries.js";
import { renderAccountingFourSurfaces } from "./helpers/accounting-four-surface.js";

const accounting = {
  resultType: "quota" as const,
  acquisitionMethod: "remote_api" as const,
  ownership: "maintained" as const,
  authority: "provider_reported" as const,
};

const entries: QuotaToastEntry[] = [
  {
    accounting,
    name: "Claude 5h",
    group: "Claude",
    label: "5h:",
    percentRemaining: 43,
  },
  {
    accounting,
    name: "Claude Weekly",
    group: "Claude",
    label: "Weekly:",
    percentRemaining: 88,
  },
  {
    accounting,
    name: "Claude Usage Credits",
    group: "Claude Usage Credits",
    label: "Monthly:",
    percentRemaining: 62,
  },
];

describe("Anthropic four-surface formatting", () => {
  it("identifies Usage Credits without changing the existing Claude quota rows", () => {
    const outputs = renderAccountingFourSurfaces({
      data: { entries, errors: [] },
      accountingDetail: "summary",
      toastMaxWidth: 64,
      toastNarrowAt: 44,
      compactMaxWidth: 160,
    });

    for (const output of Object.values(outputs)) {
      expect(output).toContain("Claude Usage Credits");
      expect(output).toContain("43%");
      expect(output).toContain("88%");
      expect(output).toContain("62%");
    }

    for (const output of [outputs.command, outputs.toast, outputs.sidebar]) {
      expect(output).toMatch(/Month(?:ly| quota)/u);
    }

    expect(outputs.compact).toBe("Claude 5h 43%, 7d 88% | Claude Usage Credits 62%");
  });
});
