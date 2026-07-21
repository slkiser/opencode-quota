import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = await readFile(
  new URL("../docs/readme/v4-migration.md", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const exportTypes = await readFile(
  new URL("../src/lib/quota-export-types.ts", import.meta.url),
  "utf8",
);
const configuration = await readFile(
  new URL("../docs/readme/configuration.md", import.meta.url),
  "utf8",
);

describe("v4 migration documentation contract", () => {
  it("keeps requirements and navigation aligned", () => {
    expect(packageJson.engines?.node).toBe(">=22.0.0");
    expect(packageJson.peerDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(packageJson.engines).not.toHaveProperty("opencode");

    expect(migration).toContain("[← Back to README](../../README.md)");
    expect(migration).toContain("OpenCode 1.4.3 or newer");
    expect(migration).toContain("Node.js 22 or newer");
    expect(readme).toContain("[v4 migration guide](docs/readme/v4-migration.md)");
  });

  it("explains the user-visible provider and JSON changes", () => {
    expect(migration).toContain(
      "v4 replaces the old `customSources` setting with `quotaProviders`",
    );
    expect(migration).toContain("npx @slkiser/opencode-quota@latest provider add");
    expect(migration).toContain("[Provider setup guide](providers.md#custom-providers)");
    expect(migration).not.toContain("custom-accounting-sources");

    expect(exportTypes).toContain("version: 2;");
    expect(migration).toContain("schema `version: 2`");
    expect(migration).toContain("[External integration](external-integration.md)");
    expect(configuration).toContain("experimental.quotaToast.quotaProviders");
    expect(configuration).toContain("do not duplicate it in a second file");
  });

  it("gives concrete preview, verification, and rollback steps", () => {
    expect(migration).toContain("npx @slkiser/opencode-quota@latest update --dry-run");
    expect(migration).toContain("## Check the update");
    expect(migration).toContain("## Roll back to v3");
    expect(migration).toContain("Restart OpenCode, then run `/quota` and `/quota_status`.");
    expect(migration).toContain("The old setting is not read or converted automatically.");
    expect(migration).not.toContain("automatically migrates");
  });
});
