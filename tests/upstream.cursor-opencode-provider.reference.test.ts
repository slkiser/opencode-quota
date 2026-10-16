import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const CURSOR_REFERENCE_ROOT = new URL(
  "../scripts/upstream-plugins/cursor-opencode-provider/",
  import.meta.url,
);

const UPSTREAM_LOCK_PATH = new URL("../scripts/upstream-plugins/lock.json", import.meta.url);

function readCursorReference(relativePath: string): string {
  return readFileSync(new URL(relativePath, CURSOR_REFERENCE_ROOT), "utf8");
}

describe("synced cursor-opencode-provider reference guards", () => {
  it("tracks the published package and its OpenCode 2 plugin entries", () => {
    const pkg = JSON.parse(readCursorReference("package.json"));

    expect(pkg.name).toBe("cursor-opencode-provider");
    expect(pkg.repository?.url).toContain("oakimov/cursor-opencode-provider");
    // Cursor detection matches these two OpenCode 2 entries.
    expect(pkg.exports?.["./plugin/opencode2"]?.import).toBe("./dist/plugin-opencode2.js");
    expect(pkg.exports?.["./server"]?.import).toBe("./dist/plugin-opencode2.js");
  });

  it("keeps the lock entry aligned with the synced package metadata", () => {
    const lock = JSON.parse(readFileSync(UPSTREAM_LOCK_PATH, "utf8"));
    const pkg = JSON.parse(readCursorReference("package.json"));
    const cursor = lock.plugins?.["cursor-opencode-provider"];

    expect(cursor).toBeTruthy();
    expect(cursor.packageName).toBe(pkg.name);
    expect(cursor.referenceDir).toBe("scripts/upstream-plugins/cursor-opencode-provider");
    expect(cursor.version).toBe(pkg.version);
  });

  it("stores OpenCode 2 Cursor credentials under the cursor integration", () => {
    expect(readCursorReference("dist/opencode2/catalog.d.ts")).toContain(
      'export declare const CURSOR_INTEGRATION_ID = "cursor";',
    );

    const integration = readCursorReference("dist/opencode2/integration.js");
    expect(integration).toContain('export const CURSOR_OAUTH_METHOD_ID = "oauth";');
    expect(integration).toContain('export const CURSOR_ENV_NAMES = ["CURSOR_API_KEY"];');
    expect(integration).toContain('method: { type: "key"');
  });

  it("publishes Cursor model prices in pricing-data.js", () => {
    expect(readCursorReference("dist/pricing-data.js")).toContain(
      "export const CURSOR_MODEL_COSTS = {",
    );
  });
});
