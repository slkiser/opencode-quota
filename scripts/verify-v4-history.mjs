import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const V4_BASE_COMMIT = process.env.V4_HISTORY_BASE ?? "0bfd899";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.V4_HISTORY_REPO
  ? path.resolve(process.env.V4_HISTORY_REPO)
  : path.resolve(scriptDir, "..");

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

  return result.stdout;
}

function isWithin(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

const publicImageFiles = new Set([
  "images/opencode-quota-logo-dark.svg",
  "images/opencode-quota-logo-light.svg",
  "images/opencode-quota_opencode-quota-sidebar.webp",
  "images/opencode-quota_opencode-quota-statusbar.webp",
  "images/opencode-quota_opencode-quota-toast.webp",
  "images/opencode-quota_opencode-quota-tokens-command.webp",
]);

function isForbidden(file) {
  const basename = path.posix.basename(file);
  if (
    basename === "AGENTS.md" ||
    basename === ".npmrc" ||
    basename === "opencode.json" ||
    basename === "tui.json" ||
    basename === ".env" ||
    basename.startsWith(".env.")
  ) {
    return true;
  }

  if (
    isWithin(file, ".agents") ||
    isWithin(file, ".codex") ||
    isWithin(file, "prompt-exports") ||
    isWithin(file, "opencode-quota") ||
    isWithin(file, "local-live-tests")
  ) {
    return true;
  }

  if (isWithin(file, "docs")) {
    return !file.startsWith("docs/readme/") || file === "docs/readme/v4-release-readiness.md";
  }

  if (isWithin(file, "images")) {
    return !publicImageFiles.has(file);
  }

  if (isWithin(file, "references")) {
    return !file.startsWith("references/upstream-plugins/");
  }

  return false;
}

git(["cat-file", "-e", `${V4_BASE_COMMIT}^{commit}`]);
git(["merge-base", "--is-ancestor", V4_BASE_COMMIT, "HEAD"]);

const commits = git(["rev-list", "--format=%H %T", "--no-commit-header", `${V4_BASE_COMMIT}..HEAD`])
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split(" "));
const violations = [];

const batch = spawn("git", ["cat-file", "--batch"], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "inherit"],
});
let batchError;
batch.on("error", (error) => {
  batchError = error;
});
batch.stdin.on("error", (error) => {
  batchError = error;
});
const batchClosed = new Promise((resolve) => batch.on("close", resolve));
const output = batch.stdout[Symbol.asyncIterator]();
let pending = Buffer.alloc(0);

async function readMore() {
  const next = await output.next();
  if (next.done) throw new Error("Unexpected end of git cat-file output");
  pending = Buffer.concat([pending, next.value]);
}

const trees = new Map();
async function readTree(treeId) {
  if (trees.has(treeId)) return trees.get(treeId);

  batch.stdin.write(`${treeId}\n`);
  while (!pending.includes(10)) await readMore();
  const headerEnd = pending.indexOf(10);
  const header = pending.toString("ascii", 0, headerEnd);
  const [objectId, type, sizeText] = header.split(" ");
  if (objectId !== treeId || type !== "tree" || !/^\d+$/.test(sizeText)) {
    throw new Error(`Unexpected git cat-file header for tree ${treeId}: ${header}`);
  }
  const size = Number(sizeText);
  pending = pending.subarray(headerEnd + 1);
  while (pending.length < size + 1) await readMore();
  const body = pending.subarray(0, size);
  pending = pending.subarray(size + 1);

  const entries = [];
  const hashBytes = treeId.length / 2;
  let offset = 0;
  while (offset < body.length) {
    const modeEnd = body.indexOf(32, offset);
    const nameEnd = body.indexOf(0, modeEnd + 1);
    entries.push({
      mode: body.toString("ascii", offset, modeEnd),
      name: body.toString("utf8", modeEnd + 1, nameEnd),
      id: body.subarray(nameEnd + 1, nameEnd + 1 + hashBytes).toString("hex"),
    });
    offset = nameEnd + 1 + hashBytes;
  }
  trees.set(treeId, entries);
  return entries;
}

const checkedTrees = new Map();
async function forbiddenPaths(treeId, prefix) {
  // The same tree can be allowed under src/ and forbidden under docs/.
  const key = `${treeId} ${prefix}`;
  if (checkedTrees.has(key)) return checkedTrees.get(key);

  const forbidden = [];
  for (const entry of await readTree(treeId)) {
    const file = `${prefix}${entry.name}`;
    // git reads only the type bits of a mode, so 040000 or 40755 from old tools is a folder too.
    if ((Number.parseInt(entry.mode, 8) & 0o170000) === 0o040000) {
      for (const nested of await forbiddenPaths(entry.id, `${file}/`)) {
        forbidden.push(nested);
      }
    } else if (isForbidden(file)) {
      forbidden.push(file);
    }
  }
  checkedTrees.set(key, forbidden);
  return forbidden;
}

let batchStatus;
try {
  for (const [commit, treeId] of commits) {
    for (const file of await forbiddenPaths(treeId, "")) {
      violations.push(`${commit} ${file}`);
    }
  }
} catch (error) {
  // Stop git: a reply nobody reads would keep git, and this script, waiting forever.
  batch.stdout.destroy();
  batch.kill();
  throw error;
} finally {
  batch.stdin.end();
  batchStatus = await batchClosed;
}
if (batchError) throw batchError;
if (batchStatus !== 0) process.exit(batchStatus ?? 1);

const indexedFiles = git(["ls-files", "-z"]).split("\0").filter(Boolean);
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
