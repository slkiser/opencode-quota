import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

describe("Gemini CLI deprecation documentation", () => {
  const readme = read("README.md");
  const configuration = read("docs/readme/configuration.md");
  const providers = read("docs/readme/providers.md");
  const troubleshooting = read("docs/readme/troubleshooting.md");
  const migration = read("docs/readme/v4-migration.md");

  it("marks Gemini CLI as deprecated without removing existing setup instructions", () => {
    expect(readme).toContain("Gemini CLI (deprecated)");
    expect(readme).toContain("[Existing setups only]");
    expect(readme).toContain("Existing v4 configurations still work");
    expect(readme).toContain("removal planned for v5.0.0");

    const providerSection = section(providers, '<a id="gemini-cli"></a>', '<a id="deepseek"></a>');
    expect(providerSection).toContain("### Gemini CLI (deprecated)");
    expect(providerSection).toContain(
      "Existing configurations, aliases, companion detection, authentication, and quota fetching continue to work unchanged.",
    );
    expect(providerSection).toContain("Do not use this provider for a new install.");
    expect(providerSection).toContain("Removal is planned for v5.0.0");
    expect(providerSection).toContain("opencode-gemini-auth");
    expect(providerSection).toContain("opencode auth login --provider google");
    expect(providerSection).toContain("include `google-gemini-cli` in `enabledProviders`");
  });

  it("keeps repair guidance and removes Gemini CLI from new configuration examples", () => {
    expect(configuration).toContain('"enabledProviders": ["copilot", "openai", "google-agy"]');
    expect(configuration).not.toContain(
      '"enabledProviders": ["copilot", "openai", "google-gemini-cli"]',
    );

    const troubleshootingSection = section(
      troubleshooting,
      "<summary><strong>Gemini CLI (deprecated)</strong></summary>",
      "</details>",
    );
    expect(troubleshootingSection).toContain("only for repairing an existing setup");
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

  it("separates Google's supported choices from independent OpenCode Quota integrations", () => {
    for (const document of [providers, migration]) {
      expect(document).toContain(
        "Google's official Antigravity CLI replaces the individual Gemini CLI experience.",
      );
      expect(document).toContain(
        "Google AI Studio or Vertex AI are the supported choices for third-party access.",
      );
      expect(document).toContain("not endorsed by Google");
    }

    expect(migration).toContain(
      "Existing `google-gemini-cli` configurations continue to work unchanged in v4.1.",
    );
    expect(migration).toContain(
      "OpenCode Quota does not migrate your configuration or authentication and does not silently switch providers.",
    );
    expect(migration).toContain(
      "configure and verify it separately before removing your existing Gemini CLI setup",
    );
  });
});
