import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const V4_BASE_COMMIT = process.env.V4_HISTORY_BASE ?? "0bfd899";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const prettierExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

run("git", ["merge-base", "--is-ancestor", V4_BASE_COMMIT, "HEAD"]);

const candidates = new Set([
  ...run("git", ["diff", "--name-only", "--diff-filter=ACMR", `${V4_BASE_COMMIT}..HEAD`]).split(
    "\n",
  ),
  ...run("git", ["diff", "--name-only", "--diff-filter=ACMR"]).split("\n"),
  ...run("git", ["ls-files", "--others", "--exclude-standard"]).split("\n"),
]);

const files = [...candidates]
  .filter(Boolean)
  .filter((file) => prettierExtensions.has(path.extname(file)))
  .filter((file) => file !== "pnpm-lock.yaml")
  .filter((file) => !file.startsWith("references/upstream-plugins/"))
  .sort();

if (files.length === 0) {
  console.log("No v4 files require formatting verification.");
  process.exit(0);
}

console.log(`Checking formatting for ${files.length} v4 files.`);
run("pnpm", ["exec", "prettier", "--check", ...files], { stdio: "inherit" });
