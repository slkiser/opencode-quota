import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const V4_BASE_COMMIT = process.env.V4_HISTORY_BASE ?? "0bfd899";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function git(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout.trim();
}

function isForbidden(file) {
  return (
    file === "AGENTS.md" ||
    file.startsWith("docs/adr/") ||
    file === "docs/readme/v4-release-readiness.md" ||
    file.startsWith("references/local/")
  );
}

git(["cat-file", "-e", `${V4_BASE_COMMIT}^{commit}`]);
git(["merge-base", "--is-ancestor", V4_BASE_COMMIT, "HEAD"]);

const commits = git(["rev-list", `${V4_BASE_COMMIT}..HEAD`])
  .split("\n")
  .filter(Boolean);
const violations = [];

for (const commit of commits) {
  const files = git(["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean);
  for (const file of files) {
    if (isForbidden(file)) violations.push(`${commit} ${file}`);
  }
}

const indexedFiles = git(["ls-files"]).split("\n").filter(Boolean);
for (const file of indexedFiles) {
  if (isForbidden(file)) violations.push(`index ${file}`);
}

if (violations.length > 0) {
  console.error("Forbidden local-only files are tracked in the v4 history or current index:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `V4 history privacy verified across ${commits.length} commit trees and the current index (base ${V4_BASE_COMMIT}).`,
);
