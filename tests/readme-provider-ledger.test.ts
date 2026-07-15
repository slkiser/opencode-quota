import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

type ProviderLedgerRow = {
  provider: string;
  dataFrom: string;
  reports: string;
};

function readPreConfiguredProviderLedger(document: string): ProviderLedgerRow[] {
  const headingIndex = document.indexOf("Pre-configured providers");
  const tableIndex = document.indexOf("| Provider", headingIndex);
  const lines = document.slice(tableIndex).split("\n");
  const tableEnd = lines.findIndex((line) => !line.startsWith("|"));
  const table = lines.slice(2, tableEnd);

  return table.map((line) => {
    const [provider, , dataFrom, reports] = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    return { provider, dataFrom, reports };
  });
}

describe("README provider ledger", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");
  const providerTemplate = read("contributing/provider-template/README.md");

  it("keeps the README and provider guide ledgers consistent", () => {
    expect(readPreConfiguredProviderLedger(readme)).toEqual(
      readPreConfiguredProviderLedger(providerGuide),
    );
  });

  it("uses friendly report wording and Quota-first ordering", () => {
    for (const document of [readme, providerGuide]) {
      expect(document).not.toContain("Usage/quota");
      expect(document).not.toContain("Quota/usage");
    }

    const allowedReports = new Set([
      "Quota",
      "Quota and usage",
      "Usage and budget",
      "Budget and spend",
      "Quota and balance",
      "Balance and status",
    ]);

    const rows = readPreConfiguredProviderLedger(readme);
    for (const row of rows) {
      expect(allowedReports.has(row.reports), `${row.provider}: ${row.reports}`).toBe(true);
    }

    for (const provider of ["OpenAI", "Qwen Code"]) {
      expect(rows.find((row) => row.provider === provider)?.reports).toBe("Quota");
    }
  });

  it("uses the approved provider headings and data provenance label", () => {
    const customReports =
      "Custom providers can report quota, rate limit, usage, spend, budget, balance, or status.";

    expect(providerTemplate).toContain("`Data from` rather than `Source`");
    expect(providerTemplate).toContain("friendly labels, not exact internal result types");
    expect(providerTemplate).toContain("`Quota` as the umbrella");
    expect(providerTemplate).toContain("exact internal `resultType` values");

    for (const document of [readme, providerGuide]) {
      expect(document).toContain("Pre-configured providers");
      expect(document).toContain("Custom providers");
      expect(document).toContain(customReports);
      expect(document).toContain("| Data from");
      expect(document).not.toContain("| Source");
    }
  });
});
