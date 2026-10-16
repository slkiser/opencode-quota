import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/** Every dist file that `entry` loads through relative `import` and `export ... from`. */
function reachableFrom(entry: string): string[] {
  const reached = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) continue;
    reached.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /\b(?:import|export)\b[^"';]*?["'](\.{1,2}\/[^"']+)["']/g,
    )) {
      pending.push(resolve(dirname(file), match[1]));
    }
  }
  return [...reached].map((file) => relative(distDir, file)).sort();
}

/** The reached files whose source queries OpenCode's credential table. */
function filesQueryingCredentials(reached: string[]): string[] {
  return reached.filter((file) =>
    readFileSync(resolve(distDir, file), "utf8").includes("FROM credential"),
  );
}

describe("tui dist import graph", () => {
  // Run after `pnpm build`. The TUI asks the server plugin for quota over the RPC, so it
  // must load no login reader and no provider code.
  it("reaches no credential or provider module from dist/tui.js", () => {
    const entry = resolve(distDir, "tui.js");
    expect(existsSync(entry)).toBe(true);

    const reached = reachableFrom(entry);

    expect(reached).toContain("rpc.js");
    expect(reached).not.toContain("lib/opencode-auth.js");
    expect(reached).not.toContain("lib/opencode-auth-sqlite.js");
    expect(reached.filter((file) => file.startsWith("providers/"))).toEqual([]);
    // It reads no settings files and no logins: no reachable module may query OpenCode's
    // credential table (only the terminal command's reader does).
    expect(reached).not.toContain("lib/config.js");
    expect(filesQueryingCredentials(reached)).toEqual([]);
  });

  // Inside OpenCode, logins come only through the plugin API. The terminal command's
  // read-only database reader must stay out of the server plugin.
  it("keeps the terminal command's database login reader out of the server plugin", () => {
    const entry = resolve(distDir, "index.js");
    expect(existsSync(entry)).toBe(true);

    const reached = reachableFrom(entry);

    expect(reached).toContain("plugin.js");
    expect(reached).not.toContain("lib/opencode-auth-sqlite.js");
    expect(reached).not.toContain("lib/cli-show.js");
    expect(filesQueryingCredentials(reached)).toEqual([]);
  });
});
