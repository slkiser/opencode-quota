import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { validateQuotaProviders } from "../src/lib/quota-providers.js";

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

    expect(readme).toContain("provider add");
    expect(readme).toContain("[Provider setup guide](docs/readme/providers.md#custom-providers)");
    expect(readme).not.toContain("experimental.quotaToast");
    expect(readme).not.toContain("apiKeyEnv");

    expect(configuration).toContain("provider add");
    expect(configuration).toContain("experimental.quotaToast");
    expect(configuration).toContain("quotaProviders");
    expect(configuration).toContain("JSONC");

    for (const document of [configuration, providers]) {
      expect(document).toContain("apiKeyEnv");
      expect(document).toContain("provider.<providerId>.options.apiKey");
      expect(document).toContain("auth.json");
      expect(document).toContain("quota-providers");
    }

    expect(configuration).toContain("global-only");
    expect(configuration).toContain("affects only `onlyCurrentModel`");
    expect(configuration).toContain("pricingModelMap");
    expect(configuration).toContain("cannot override a successful");
    expect(configuration).toContain("budget percentage is reported unavailable");
    expect(configuration).toContain("~/.local/state/opencode/opencode-quota/");
    expect(providers).toContain("limited to 256 KiB");
    expect(providers).toContain("limited to 100 rows");
    expect(troubleshooting).toContain("cached results are not substituted");
    expect(troubleshooting).toContain("URLs, request/response contents, raw errors");
    expect(external).toContain('"version": 2');
    expect(external).toContain('providers["quota-providers"]');
    expect(external).toContain("configured `quotaProviders` definition");
    expect(external).not.toContain("custom-sources");
    expect(external).not.toContain("Custom-provider");
    expect(external).toContain('"sourceId": "openrouter-primary"');
    expect(external).toContain('"sources": [');
    expect(external).toContain('"id": "openrouter-primary"');
    expect(external).toContain('"entryCount": 1');
    expect(external).toContain(
      "Each summary is exactly `id`, effective `providerId`, coarse `status`, and `entryCount`",
    );
    expect(external).toContain("raw provider responses remain excluded from public JSON");
  });

  it("links to the authoritative external references used by the README", () => {
    const readme = read("README.md");

    for (const url of [
      "https://opencode.ai/docs/",
      "https://opencode.ai/docs/config/",
      "https://opencode.ai/docs/plugins/",
      "https://opencode.ai/docs/tui/",
      "https://models.dev/",
      "https://nodejs.org/en/download",
    ]) {
      expect(readme).toContain(`](${url})`);
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
