import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function section(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

const ORG_ONLY = "Gemini Code Assist Standard or Enterprise (organization) accounts";

describe("Gemini CLI organization-only documentation", () => {
  const readme = read("README.md");
  const configuration = read("docs/readme/configuration.md");
  const providers = read("docs/readme/providers.md");
  const troubleshooting = read("docs/readme/troubleshooting.md");
  const migration = read("docs/readme/v4-migration.md");

  it("no longer calls Gemini CLI deprecated or planned for removal", () => {
    for (const document of [readme, providers, troubleshooting, migration]) {
      expect(document).not.toContain("Gemini CLI (deprecated)");
      expect(document).not.toContain("v5.0.0");
      expect(document).not.toContain("Existing setups only");
    }
  });

  it("lists Gemini CLI only in the Business / Enterprise tables", () => {
    for (const document of [readme, providers]) {
      const personal = section(
        document,
        "<summary><strong>Personal</strong></summary>",
        "</details>",
      );
      const business = section(
        document,
        "<summary><strong>Business / Enterprise</strong></summary>",
        "</details>",
      );
      expect(personal).not.toContain("Gemini CLI");
      expect(business).toMatch(/\| Gemini CLI +\| \[Needs setup\]\([^)]*#gemini-cli\)/);
    }
  });

  it("states organization-only support and points personal users to Google AGY", () => {
    expect(readme).toContain(
      "- Personal Google accounts can no longer use Gemini CLI because Google ended them on 2026-06-18; use Google AGY.",
    );
    expect(readme).toContain(`Gemini CLI works only with ${ORG_ONLY}.`);

    const providerSection = section(providers, '<a id="gemini-cli"></a>', '<a id="deepseek"></a>');
    expect(providerSection).toContain("### Gemini CLI\n");
    expect(providerSection).toContain(`Gemini CLI works only with ${ORG_ONLY}.`);
    expect(providerSection).toContain("on 2026-06-18");
    expect(providerSection).toContain(
      "https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals",
    );
    expect(providerSection).toContain("[Google AGY](#google-agy-quick-setup)");
    expect(providerSection).toContain("opencode-gemini-auth");
    expect(providerSection).toContain("opencode auth login --provider google");
    expect(providerSection).toContain("include `google-gemini-cli` in `enabledProviders`");

    expect(migration).toContain(ORG_ONLY);
    expect(migration).toContain("Google ended personal accounts on 2026-06-18.");
    expect(migration).toContain(
      "OpenCode Quota does not migrate your configuration or authentication and does not silently switch providers.",
    );
  });

  it("keeps repair guidance and keeps Gemini CLI out of new configuration examples", () => {
    expect(configuration).toContain('"enabledProviders": ["copilot", "openai", "google-agy"]');
    expect(configuration).not.toContain(
      '"enabledProviders": ["copilot", "openai", "google-gemini-cli"]',
    );

    const troubleshootingSection = section(
      troubleshooting,
      "<summary><strong>Gemini CLI</strong></summary>",
      "</details>",
    );
    expect(troubleshootingSection).toContain(ORG_ONLY);
    expect(troubleshootingSection).toContain("opencode-gemini-auth");
    expect(troubleshootingSection).toContain("Include `google-gemini-cli` in `enabledProviders`");
    expect(troubleshootingSection).toContain("opencode auth login --provider google");
    for (const projectIdSource of [
      "provider.google.options.projectId",
      "OPENCODE_GEMINI_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
      "GOOGLE_CLOUD_PROJECT_ID",
    ]) {
      expect(troubleshootingSection).toContain(projectIdSource);
    }
  });
});
