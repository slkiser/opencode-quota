import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

type ProviderLedgerRow = {
  provider: string;
  authSetup: string;
  dataFrom: string;
  reports: string;
};

function readVisibleCellText(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function readPreConfiguredProviderSection(document: string): string {
  const headingIndex = document.search(
    /^#{2,3} (?:Pre-configured providers|Pre-configured American providers)$/m,
  );
  if (headingIndex === -1) throw new Error("Pre-configured provider section heading not found");

  const providerSection = document.slice(headingIndex);
  const customProvidersOffset = providerSection.search(/^#{2,3} Custom providers$/m);
  if (customProvidersOffset === -1) throw new Error("Custom provider section heading not found");

  return providerSection.slice(0, customProvidersOffset);
}

function readPreConfiguredProviderTables(document: string): ProviderLedgerRow[][] {
  const lines = readPreConfiguredProviderSection(document).split("\n");
  const tables: ProviderLedgerRow[][] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("| Provider")) continue;

    const rows: ProviderLedgerRow[] = [];
    index += 2;
    while (index < lines.length && lines[index].startsWith("|")) {
      const [provider, authSetup, dataFrom, reports] = lines[index]
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      rows.push({
        provider,
        authSetup: readVisibleCellText(authSetup),
        dataFrom,
        reports,
      });
      index += 1;
    }
    tables.push(rows);
  }

  return tables;
}

function readTierNeutralProviderTables(document: string): ProviderLedgerRow[][] {
  return readPreConfiguredProviderTables(document).map((table) =>
    table.map((row) => ({
      ...row,
      provider: row.provider === "xAI SuperGrok" ? "xAI" : row.provider,
    })),
  );
}

describe("README provider ledger", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");

  it("keeps the README and provider guide ledgers consistent", () => {
    expect(readTierNeutralProviderTables(readme)).toEqual(
      readTierNeutralProviderTables(providerGuide),
    );
  });

  it("keeps the basic provider documentation structure", () => {
    for (const document of [readme, providerGuide]) {
      expect(document).toMatch(/^#.+Providers|^## Providers$/m);
      expect(document).toMatch(/^#{2,3} Custom providers$/m);
      expect(document).toContain("npx @slkiser/opencode-quota@4 provider add");
    }
  });
});
