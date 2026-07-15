import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { CUSTOM_SOURCE_PRESETS } from "../src/lib/custom-sources.js";

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
  it("keeps requirements, migration link, and supported-version surfaces aligned", () => {
    expect(packageJson.engines?.node).toBe(">=22.0.0");
    expect(packageJson.peerDependencies?.["@opencode-ai/plugin"]).toBe("^1.4.3");
    expect(packageJson.engines).not.toHaveProperty("opencode");

    expect(migration).toContain("OpenCode `>= 1.4.3`");
    expect(migration).toContain("Node.js `>= 22`");
    expect(readme).toContain("[v4 migration guide](docs/readme/v4-migration.md)");
  });

  it("documents only the implemented custom-source and export contracts", () => {
    for (const preset of CUSTOM_SOURCE_PRESETS) {
      expect(migration).toContain(preset);
    }
    expect(migration).toContain('"enabledProviders": ["custom-sources"]');
    expect(migration).toContain("<OpenCode user config dir>/opencode-quota/quota-toast.json");
    expect(migration).toContain("There is no legacy custom-source reader");
    expect(migration).toContain("workspace source definition");
    expect(migration).toContain("compatibility shim");

    expect(exportTypes).toContain("version: 2;");
    expect(migration).toContain("schema `version: 2`");
    expect(configuration).toContain("`customSources` is the exception to ordinary config layering");
  });

  it("records concrete verification and rollback steps without claiming automatic migration", () => {
    expect(migration).toContain("## Verify every surface");
    expect(migration).toContain("## Roll back");
    expect(migration).toContain("Run `/quota`, then `/quota_status`.");
    expect(migration).toContain("There is no legacy custom-source reader, automatic migration");
    expect(migration).not.toContain("automatically migrates");
  });
});
