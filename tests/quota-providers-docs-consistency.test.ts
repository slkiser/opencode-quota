import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { validateQuotaProviders } from "../src/lib/quota-providers.js";
import {
  hasMarkdownLinkTo,
  readFencedCodeBlocks,
  readMarkdownParagraphContaining,
  readMarkdownSection,
} from "./helpers/markdown-document.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("quota provider Phase 7 documentation consistency", () => {
  it("keeps the documented OpenRouter example valid", () => {
    expect(
      validateQuotaProviders([
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          mode: "remote-api",
          url: "https://openrouter.ai/api/v1/key",
          format: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ]),
    ).toEqual({
      value: [
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          mode: "remote-api",
          url: "https://openrouter.ai/api/v1/key",
          format: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      issues: [],
    });
  });

  it("keeps the README concise and the detailed provider guides complete", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const providers = read("docs/readme/providers.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const external = read("docs/readme/external-integration.md");
    const manualInstall = read("docs/readme/manual-install.md");
    const migration = read("docs/readme/v4-migration.md");

    const readmeCommands = readMarkdownSection(readme, /^Commands$/);
    const readmeCustomProviders = readMarkdownSection(readme, /^Custom providers$/);
    const configurationCustomProviders = readMarkdownSection(configuration, /^Custom providers$/);
    const providerGuideCustomProviders = readMarkdownSection(providers, /^Custom providers$/);
    const troubleshootingProviderFixes = readMarkdownSection(troubleshooting, /^Provider fixes$/);
    const externalJsonBasics = readMarkdownSection(external, /^JSON basics$/);

    const providerAddCommand = "npx @slkiser/opencode-quota@latest provider add";
    expect(readmeCommands).toContain(providerAddCommand);
    expect(readmeCustomProviders).toContain(providerAddCommand);
    expect(
      hasMarkdownLinkTo(readmeCustomProviders, "docs/readme/providers.md#custom-providers"),
    ).toBe(true);
    expect(readme).not.toContain("experimental.quotaToast");
    expect(readme).not.toContain("apiKeyEnv");

    for (const document of [
      readme,
      configuration,
      providers,
      troubleshooting,
      external,
      manualInstall,
      migration,
    ]) {
      expect(document).not.toContain("accounting-v1");
    }

    expect(configuration).toContain("provider add");
    expect(configuration).toContain("experimental.quotaToast");
    expect(configuration).toContain("quotaProviders");
    expect(configuration).toContain("JSONC");

    for (const document of [configuration, providers]) {
      expect(document).toContain("apiKeyEnv");
      expect(document).toContain("provider.<providerId>.options.apiKey");
      expect(document).toContain("opencode.db");
      expect(document).toContain("quota-providers");
    }

    expect(configurationCustomProviders).toContain("global-only");
    expect(
      readMarkdownParagraphContaining(
        configurationCustomProviders,
        "`modelIds`",
        "`onlyCurrentModel`",
      ),
    ).toMatch(/`modelIds`[\s\S]*\bonly\b[\s\S]*`onlyCurrentModel`/);
    const pricingMapRule = readMarkdownParagraphContaining(
      configurationCustomProviders,
      "pricingModelMap",
      "successful automatic match",
    );
    expect(pricingMapRule).toMatch(
      /pricingModelMap[\s\S]*\b(?:cannot|must not|does not) override\b[\s\S]*\bsuccessful automatic match\b/i,
    );
    expect(
      readMarkdownParagraphContaining(
        configurationCustomProviders,
        "budget percentage",
        "unavailable",
      ),
    ).toMatch(/budget percentage[\s\S]*\b(?:reported|shown|marked) unavailable\b/i);
    expect(configurationCustomProviders).toContain("~/.local/state/opencode/opencode-quota/");
    expect(providerGuideCustomProviders).toContain("limited to 256 KiB");
    expect(providerGuideCustomProviders).toContain("limited to 100 rows");
    expect(providerGuideCustomProviders).toContain(
      "128 objects, 384 object properties, and 640 array elements",
    );
    expect(providerGuideCustomProviders).toContain("at most 32 container levels");
    expect(providerGuideCustomProviders).toContain("absolute magnitude at most `1e15`");
    expect(providerGuideCustomProviders).toContain("offsets through `±14:00`");
    expect(providerGuideCustomProviders).toContain("Metric compatibility and fixed output");
    expect(providerGuideCustomProviders).toContain("`used-limit`");
    expect(providerGuideCustomProviders).toContain('For `metric.type: "value"`');
    expect(providerGuideCustomProviders).toContain("Pair denominators");
    const unitRule = readMarkdownParagraphContaining(
      providerGuideCustomProviders,
      "`unit`",
      "`unitPosition`",
      "`percentage`",
      "`status`",
    );
    expect(unitRule).toMatch(
      /`unit`[\s\S]*`unitPosition`[\s\S]*\b(?:must|required to)\b[\s\S]*\btogether\b/i,
    );
    expect(unitRule).toMatch(
      /\b(?:forbidden|not allowed|must not appear)\b[\s\S]*`percentage`[\s\S]*`status`/i,
    );
    const secretRule = readMarkdownParagraphContaining(
      providerGuideCustomProviders,
      "secrets",
      "adapter display configuration",
    );
    expect(secretRule).toMatch(
      /\b(?:never|must not|cannot|forbidden)\b[\s\S]*\bsecrets\b[\s\S]*adapter display configuration/i,
    );
    expect(
      readMarkdownParagraphContaining(
        troubleshootingProviderFixes,
        "cached results",
        "substituted",
      ),
    ).toMatch(/cached results[\s\S]*\b(?:not|never) substituted\b/i);
    const hiddenDiagnostics = readMarkdownParagraphContaining(
      troubleshootingProviderFixes,
      "URLs",
      "request/response contents",
      "raw errors",
    );
    expect(hiddenDiagnostics).toMatch(
      /\b(?:hide|hides|hidden|exclude|excludes)\b[\s\S]*URLs[\s\S]*request\/response contents[\s\S]*raw errors/i,
    );
    expect(externalJsonBasics).toContain('"version": 2');
    expect(externalJsonBasics).toContain('providers["quota-providers"]');
    expect(externalJsonBasics).toContain("configured `quotaProviders` definition");
    expect(external).not.toContain("custom-sources");
    expect(external).not.toContain("Custom-provider");
    expect(externalJsonBasics).toContain('"sourceId": "openrouter-primary"');
    expect(externalJsonBasics).toContain('"sources": [');
    expect(externalJsonBasics).toContain('"id": "openrouter-primary"');
    expect(externalJsonBasics).toContain('"entryCount": 1');
    const sourceSummaryBlock = readFencedCodeBlocks(externalJsonBasics).find(
      (block) => block.info === "json" && block.content.includes('"sources"'),
    );
    if (sourceSummaryBlock === undefined) throw new Error("Source summary JSON example not found");
    const sourceSummaryExample = JSON.parse(`{${sourceSummaryBlock.content}}`) as {
      sources: Array<Record<string, unknown>>;
    };
    expect(sourceSummaryExample.sources).toHaveLength(1);
    expect(Object.keys(sourceSummaryExample.sources[0]).sort()).toEqual(
      ["id", "providerId", "status", "entryCount"].sort(),
    );

    const sourceSummaryRule = readMarkdownParagraphContaining(
      externalJsonBasics,
      "Each summary",
      "`providerId`",
      "`status`",
      "`entryCount`",
    );
    expect(sourceSummaryRule).toMatch(/\bexactly\b/i);
    expect(sourceSummaryRule).toMatch(/\beffective `providerId`/i);
    expect(sourceSummaryRule).toMatch(/\bcoarse `status`/i);
    expect(sourceSummaryRule).toMatch(
      /failed mapping candidates?[\s\S]*aggregate provider[\s\S]*`partial`/i,
    );
    expect(
      readMarkdownParagraphContaining(externalJsonBasics, "raw provider responses", "public JSON"),
    ).toMatch(/raw provider responses[\s\S]*\b(?:excluded|omitted) from public JSON\b/i);
  });

  it("links to the authoritative external references used by the README", () => {
    const referenceSection = readMarkdownSection(read("README.md"), /^Reference$/);

    for (const url of [
      "https://opencode.ai/docs/",
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
      "https://opencode.ai/docs/tui/",
      "https://models.dev/",
      "https://nodejs.org/en/download",
    ]) {
      expect(hasMarkdownLinkTo(referenceSection, url), url).toBe(true);
    }
  });

  it("keeps copy-paste integrations independent of entry order", () => {
    const external = read("docs/readme/external-integration.md");

    expect(external).not.toContain("entries[0].percentRemaining");
    expect(external).toContain('select(.renderType == "percent"');
    expect(external.match(/renderType/g)?.length).toBeGreaterThanOrEqual(5);
    expect(external).toContain('status: "partial"');
    expect(external).toContain("Results were incomplete");
  });

  it("keeps surface formatters generic", () => {
    for (const path of [
      "src/lib/quota-command-format.ts",
      "src/lib/toast-format-grouped.ts",
      "src/lib/tui-sidebar-format.ts",
      "src/lib/tui-compact-format.ts",
    ]) {
      const formatter = read(path);
      expect(formatter).not.toContain("quota-providers");
      expect(formatter).not.toContain("quotaProviders");
      expect(formatter).not.toContain("customSources");
    }
  });
});
