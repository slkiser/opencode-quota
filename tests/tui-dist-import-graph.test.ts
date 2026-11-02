import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const distDir = fileURLToPath(new URL("../dist/", import.meta.url));

/**
 * Every dist file that `entry` loads through relative `import` and `export ... from`, as a
 * dist-relative path with forward slashes on every platform.
 */
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
  return [...reached].map((file) => relative(distDir, file).split(sep).join("/")).sort();
}

/** The reached files whose source queries OpenCode's credential table. */
function filesQueryingCredentials(reached: string[]): string[] {
  return reached.filter((file) =>
    readFileSync(resolve(distDir, file), "utf8").includes("FROM credential"),
  );
}

/** The TUI's own files: its views and the quota window. */
const TUI_FILE = /^(?:tui|view)\//u;

/**
 * The other dist files dist/tui.js loads, exactly, so a new one is added here on purpose: no
 * login reader and no provider. settings/schema.js checks custom provider definitions with
 * lib/quota-providers.js, which brings the price list (lib/modelsdev-pricing.js with
 * lib/http.js, lib/atomic-json.js and the runtime folders).
 */
const TUI_MAY_REACH = [
  "core/errors.js",
  "core/pace.js",
  "core/redact.js",
  "core/usage-ranges.js",
  "core/validate.js",
  "core/windows.js",
  "lib/accounting-format.js",
  "lib/atomic-json.js",
  "lib/calendar-date.js",
  "lib/cursor-pricing.js",
  "lib/display-sanitize.js",
  "lib/home-dir-display.js",
  "lib/http.js",
  "lib/json-guards.js",
  "lib/modelsdev-pricing.js",
  "lib/opencode-runtime-paths.js",
  "lib/pricing-key.js",
  "lib/provider-metadata.js",
  "lib/provider-registration.js",
  "lib/quota-providers.js",
  "lib/quota-report-message.js",
  "lib/token-buckets.js",
  "lib/version.js",
  "rpc.js",
  "settings/schema.js",
  "settings/shared.js",
  "tui.js",
];

describe("tui dist import graph", () => {
  // Run after `pnpm build`. The TUI asks the server plugin for quota over the RPC, so it
  // must load no login reader and no provider code.
  it("reaches only its own files and the allowed ones from dist/tui.js", () => {
    const entry = resolve(distDir, "tui.js");
    expect(existsSync(entry)).toBe(true);

    const reached = reachableFrom(entry);

    expect(reached).toContain("rpc.js");
    expect(reached.filter((file) => !TUI_FILE.test(file))).toEqual(TUI_MAY_REACH);
    // No reachable module may query OpenCode's credential table (only the terminal
    // command's reader does).
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
