import { describe, expect, it } from "vitest";
import {
  projectAccountingDetails,
  formatAccountingDetails,
  displayQuotaEntries,
} from "../src/lib/accounting-display.js";
import { copilotAccounting } from "../src/providers/accounting-adapters.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";
import { formatQuotaRows } from "../src/lib/format.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
const fixture = (): QuotaProviderResult => ({
  attempted: true,
  entries: [{ name: "Copilot", percentRemaining: -25 }],
  errors: [],
  observation: { id: "fixture", observedAt: 0 },
  accounting: copilotAccounting({
    success: true,
    mode: "user_quota",
    unit: "ai_credits",
    authority: "provider_reported",
    used: 125,
    total: 100,
    percentRemaining: -25,
    billedAmountUsd: 0.25,
  }),
});
describe("shared accounting display", () => {
  it("projects the same value/operands/source to reports, sidebar and toast without replacing compact quota", () => {
    const result = fixture();
    const details = projectAccountingDetails("copilot", result);
    expect(details[0].value).toBe("-25% remaining");
    expect(details[0].facts).toContainEqual({
      label: "Used",
      value: "125 credits (Provider reported)",
    });
    expect(details[0].facts).toContainEqual({ label: "Source observation", value: "Unknown" });
    expect(details[0].facts).toContainEqual({
      label: "Fetched",
      value: "1970-01-01T00:00:00.000Z",
    });
    const data = { entries: result.entries, errors: [], accountingDetails: details };
    const command = formatQuotaCommand(data);
    expect(command).toContain("Accounting details");
    expect(command).toContain("USD 0.25");
    const sidebar = buildSidebarQuotaPanelLines({ data, config: DEFAULT_CONFIG }).join("\n");
    expect(sidebar).toContain("Billed spend: USD 0.25");
    expect(sidebar).toContain("0% left"); // existing compact floor remains compatible
    expect(command).toContain("-25% remaining"); // rich detail retains the over-limit fact
    const toast = formatQuotaRows({ version: "fixture", ...data });
    expect(toast).toContain("Billed spend: USD 0.25");
    expect(displayQuotaEntries(result)).toEqual([{ name: "Copilot", percentRemaining: -25 }]);
  });
  it("shows known accounts separately, keeps unknown data explicit and strips terminal controls", () => {
    const result = fixture();
    result.accounting!.rows[0].name = "Quota\x1b[31m\nlabel";
    result.accounting!.rows[0].account = { kind: "opaque", digest: "a".repeat(64) };
    const details = projectAccountingDetails("copilot", result);
    expect(details[0].name).toBe("Quota label");
    expect(details[0].facts).toContainEqual({ label: "Account", value: "Account aaaaaaaa" });
    expect(details[1].facts).toContainEqual({ label: "Account", value: "Unknown" });
    expect(formatAccountingDetails(details)).not.toContain("\x1b");
    expect(
      formatAccountingDetails(details, 24)
        .split("\n")
        .every((line) => Array.from(line).length <= 24),
    ).toBe(true);
  });
  it("renders typed-only quantities and unknown states as values instead of percentage bars", () => {
    const result = fixture();
    result.entries = [];
    result.accounting!.rows[0].value = {
      kind: "quantity",
      quantity: { decimal: "0.00001", unit: { kind: "currency", code: "EUR" } },
    };
    const entries = displayQuotaEntries(result);
    expect(entries[0]).toMatchObject({ kind: "value", value: "EUR 0.00001" });
    expect(entries[0]).not.toHaveProperty("percentRemaining");
    result.accounting!.rows[0].value = { kind: "quantity", quantity: null };
    expect(displayQuotaEntries(result)[0]).toMatchObject({ kind: "value", value: "Unknown" });
    expect(result.entries).toEqual([]); // render fallback never mutates stable exports/cache
  });
  it("keeps invalid/absent metadata out of display and tolerates invalid application timestamps", () => {
    expect(
      projectAccountingDetails("legacy", { attempted: true, entries: [], errors: [] }),
    ).toEqual([]);
    const result = fixture();
    result.observation!.observedAt = 1e20;
    expect(
      projectAccountingDetails("copilot", result)[0].facts.some((fact) => fact.label === "Fetched"),
    ).toBe(false);
  });
});
