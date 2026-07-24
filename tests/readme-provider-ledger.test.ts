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

function readPreConfiguredProviderSection(document: string): string {
  const headingIndex = document.search(/^#{2,3} Pre-configured providers$/m);
  const providerSection = document.slice(headingIndex);
  const customProvidersOffset = providerSection.search(/^#{2,3} Custom providers$/m);
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
      const [provider, , dataFrom, reports] = lines[index]
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      rows.push({ provider, dataFrom, reports });
      index += 1;
    }
    tables.push(rows);
  }

  return tables;
}

function readPreConfiguredProviderLedger(document: string): ProviderLedgerRow[] {
  return readPreConfiguredProviderTables(document).flat();
}

describe("README provider ledger", () => {
  const readme = read("README.md");
  const providerGuide = read("docs/readme/providers.md");
  const providerTemplate = read("contributing/provider-template/README.md");

  it("keeps the README and provider guide ledgers consistent", () => {
    expect(readPreConfiguredProviderTables(readme)).toEqual(
      readPreConfiguredProviderTables(providerGuide),
    );
  });

  it("keeps audience tables alphabetized with intentional duplicates", () => {
    const expectedProviders = [
      [
        "Anthropic (Claude)",
        "Chutes AI",
        "Cursor",
        "GitHub Copilot",
        "Google AGY",
        "Google Antigravity",
        "NanoGPT",
        "Ollama Cloud",
        "OpenAI",
        "OpenCode Go",
        "OpenCode Zen",
        "OpenRouter",
        "Synthetic",
        "xAI SuperGrok",
      ],
      [
        "Anthropic (Claude)",
        "Chutes AI",
        "Cursor",
        "Gemini CLI (deprecated)",
        "GitHub Copilot",
        "Google AGY",
        "Google Antigravity",
        "NanoGPT",
        "OpenAI",
        "OpenCode Zen",
        "OpenRouter",
        "Synthetic",
        "xAI SuperGrok",
      ],
      [
        "Alibaba Coding Plan",
        "DeepSeek",
        "Kimi Code",
        "MiniMax Coding Plan",
        "MiniMax Coding Plan (CN)",
        "Qwen Code",
        "Xiaomi MiMo",
        "Z.ai Coding Plan",
        "Zhipu Coding Plan",
      ],
      ["Kimi Code", "MiniMax Coding Plan", "MiniMax Coding Plan (CN)", "Zhipu Coding Plan"],
    ];

    for (const document of [readme, providerGuide]) {
      expect(
        readPreConfiguredProviderTables(document).map((table) => table.map((row) => row.provider)),
      ).toEqual(expectedProviders);
      const providerSection = readPreConfiguredProviderSection(document);
      const chineseHeadingIndex = providerSection.indexOf("### Chinese providers");
      const disclosures = Array.from(
        providerSection.matchAll(
          /<details( open)?>\s*<summary><strong>([^<]+)<\/strong><\/summary>/g,
        ),
      ).map((match) => ({
        region: (match.index ?? 0) < chineseHeadingIndex ? "americas" : "chinese",
        label: match[2],
        open: match[1] !== undefined,
      }));
      expect(disclosures).toEqual([
        { region: "americas", label: "Personal", open: true },
        { region: "americas", label: "Business / Enterprise", open: false },
        { region: "chinese", label: "Personal", open: true },
        { region: "chinese", label: "Business / Team", open: false },
      ]);
    }
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
      "Budget and balance",
      "Quota and balance",
      "Balance and status",
    ]);

    const rows = readPreConfiguredProviderLedger(readme);
    for (const row of rows) {
      expect(allowedReports.has(row.reports), `${row.provider}: ${row.reports}`).toBe(true);
    }

    for (const provider of ["OpenAI", "Qwen Code"]) {
      expect(rows.filter((row) => row.provider === provider).map((row) => row.reports)).toEqual(
        rows.filter((row) => row.provider === provider).map(() => "Quota"),
      );
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
      expect(document).toMatch(/^### American providers$/m);
      expect(document).toMatch(/^### Chinese providers$/m);
      expect(document).toContain("Custom providers");
      expect(document).toContain("| Data from");
      expect(document).not.toContain("| Source");
    }

    expect(readme).toContain(
      "You can add a provider with an HTTPS quota API, or track a local usage estimate",
    );
    expect(readme).not.toContain(customReports);
    expect(providerGuide).toContain(customReports);
  });
});
