import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const coreDir = path.join(repoRoot, "node_modules", "@opentui", "core");

describe("@opentui/core runtime stubs (postinstall shim)", () => {
  it("has a .js sibling for every .d.ts file in @opentui/core", async () => {
    if (!(await exists(coreDir))) return;

    const entries = await readdir(coreDir, { withFileTypes: true });
    const missing: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".d.ts")) continue;
      if (entry.name.endsWith(".d.ts.map")) continue;
      const base = entry.name.slice(0, -".d.ts".length);
      const jsPath = path.join(coreDir, `${base}.js`);
      const tsxPath = path.join(coreDir, `${base}.tsx`);
      if (!(await exists(jsPath)) && !(await exists(tsxPath))) {
        missing.push(entry.name);
      }
    }

    expect(missing).toEqual([]);
  });
});
