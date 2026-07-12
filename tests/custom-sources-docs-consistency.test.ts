import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

import { validateCustomSources } from "../src/lib/custom-sources.js";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("custom source Phase 4 documentation consistency", () => {
  it("keeps the documented OpenRouter example valid", () => {
    expect(
      validateCustomSources([
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          url: "https://openrouter.ai/api/v1/key",
          preset: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ]),
    ).toEqual({
      value: [
        {
          id: "openrouter-primary",
          providerId: "openrouter",
          label: "OpenRouter Primary",
          url: "https://openrouter.ai/api/v1/key",
          preset: "openrouter-key-v1",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
      ],
      issues: [],
    });
  });

  it("documents the global-only boundary, auth order, matching, diagnostics, and v2 export", () => {
    const readme = read("README.md");
    const configuration = read("docs/readme/configuration.md");
    const providers = read("docs/readme/providers.md");
    const troubleshooting = read("docs/readme/troubleshooting.md");
    const external = read("docs/readme/external-integration.md");

    for (const document of [readme, configuration, providers]) {
      expect(document).toContain("<OpenCode user config dir>/opencode-quota/quota-toast.json");
      expect(document).toContain("apiKeyEnv");
      expect(document).toContain("provider.<providerId>.options.apiKey");
    }

    expect(configuration).toContain("auth.json");
    expect(providers).toContain("auth.json");
    expect(configuration).toContain("affects only `onlyCurrentModel`");
    expect(providers).toContain("limited to 256 KiB");
    expect(providers).toContain("limited to 100 rows");
    expect(troubleshooting).toContain("cached results are not substituted");
    expect(troubleshooting).toContain("URLs, request/response contents, raw errors");
    expect(external).toContain('"version": 2');
    expect(external).toContain('"sourceId": "openrouter-primary"');
    expect(external).toContain('"sources": [');
    expect(external).toContain('"id": "openrouter-primary"');
    expect(external).toContain('"entryCount": 1');
    expect(external).toContain(
      "Each summary is exactly `id`, `providerId`, coarse `status`, and `entryCount`",
    );
    expect(external).toContain("intentionally excluded from public JSON");
  });

  it("keeps surface formatters generic", () => {
    for (const path of [
      "src/lib/quota-command-format.ts",
      "src/lib/toast-format-grouped.ts",
      "src/lib/tui-sidebar-format.ts",
      "src/lib/tui-compact-format.ts",
    ]) {
      const formatter = read(path);
      expect(formatter).not.toContain("custom-sources");
      expect(formatter).not.toContain("customSources");
    }
  });
});
