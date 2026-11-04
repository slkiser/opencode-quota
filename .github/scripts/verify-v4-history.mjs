import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const V4_BASE_COMMIT = process.env.V4_HISTORY_BASE ?? "0bfd899";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.V4_HISTORY_REPO
  ? path.resolve(process.env.V4_HISTORY_REPO)
  : path.resolve(scriptDir, "../..");

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

const publicImageNames = [
  "opencode-quota-logo-dark.svg",
  "opencode-quota-logo-light.svg",
  "opencode-quota_opencode-quota-sidebar.webp",
  "opencode-quota_opencode-quota-statusbar.webp",
  "opencode-quota_opencode-quota-toast.webp",
  "opencode-quota_opencode-quota-tokens-command.webp",
];
// The checked history holds the public images in `images/` (older commits) and `.github/images/`.
const imageDirectories = ["images", ".github/images"];
const publicImageFiles = new Set(
  imageDirectories.flatMap((directory) => publicImageNames.map((name) => `${directory}/${name}`)),
);

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

  if (imageDirectories.some((directory) => isWithin(file, directory))) {
    return !publicImageFiles.has(file);
  }

  if (isWithin(file, "references")) {
    return !file.startsWith("references/upstream-plugins/");
  }

  return false;
}

git(["cat-file", "-e", `${V4_BASE_COMMIT}^{commit}`]);
git(["merge-base", "--is-ancestor", V4_BASE_COMMIT, "HEAD"]);

// rev-list keeps the same commit order while also supplying each full root tree.
const revisions = git(["rev-list", "--format=%T", `${V4_BASE_COMMIT}..HEAD`])
  .split(/\r?\n/)
  .filter(Boolean);
const commits = [];
for (let i = 0; i < revisions.length; i += 2) {
  commits.push({ commit: revisions[i].slice("commit ".length), tree: revisions[i + 1] });
}
const violations = [];

async function checkHistory() {
  if (commits.length === 0) return;
  const batch = spawn("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const finished = new Promise((resolve) => {
    batch.on("error", (error) => resolve({ error }));
    batch.on("close", (code) => resolve({ code }));
  });
  // A failed Git process can close stdin before a pending request is written.
  batch.stdin.on("error", () => {});
  const chunks = batch.stdout[Symbol.asyncIterator]();
  let buffered = Buffer.alloc(0);

  async function receive() {
    const { value, done } = await chunks.next();
    if (done) {
      const result = await finished;
      if (result.error) throw result.error;
      if (result.code !== 0) process.exit(result.code ?? 1);
      throw new Error("Unexpected end of git cat-file output");
    }
    buffered = Buffer.concat([buffered, value]);
  }

  const trees = new Map();
  async function readTree(tree) {
    if (trees.has(tree)) return trees.get(tree);
    batch.stdin.write(`${tree}\n`);
    let headerEnd = buffered.indexOf(10);
    while (headerEnd < 0) {
      await receive();
      headerEnd = buffered.indexOf(10);
    }
    const [object, type, sizeText] = buffered.subarray(0, headerEnd).toString("ascii").split(" ");
    const size = Number(sizeText);
    if (object !== tree || type !== "tree" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid git cat-file tree header: ${object} ${type} ${sizeText}`);
    }
    buffered = buffered.subarray(headerEnd + 1);
    while (buffered.length < size + 1) await receive();
    const contents = buffered.subarray(0, size);
    buffered = buffered.subarray(size + 1); // Batch bodies end with one LF, outside the size.

    const entries = [];
    const objectIdBytes = tree.length / 2; // Supports both SHA-1 and SHA-256 repositories.
    let offset = 0;
    while (offset < contents.length) {
      const modeEnd = contents.indexOf(32, offset);
      const nameEnd = contents.indexOf(0, modeEnd + 1);
      if (modeEnd < offset || nameEnd < 0 || nameEnd + 1 + objectIdBytes > contents.length) {
        throw new Error(`Invalid git tree contents: ${tree}`);
      }
      const mode = contents.subarray(offset, modeEnd).toString("ascii");
      if (!/^[0-7]+$/.test(mode))
        throw new Error(`Invalid git tree entry mode in ${tree}: ${mode}`);
      const name = contents.subarray(modeEnd + 1, nameEnd).toString("utf8");
      const objectId = contents.subarray(nameEnd + 1, nameEnd + 1 + objectIdBytes).toString("hex");
      entries.push({ mode, name, objectId });
      offset = nameEnd + 1 + objectIdBytes;
    }
    trees.set(tree, entries);
    return entries;
  }

  // The same tree can occur under different paths, where the rules give different answers.
  const checkedTrees = new Map();
  async function forbiddenFiles(tree, prefix) {
    const key = `${tree}:${prefix}`;
    if (checkedTrees.has(key)) return checkedTrees.get(key);
    const files = [];
    for (const entry of await readTree(tree)) {
      const file = `${prefix}${entry.name}`;
      // git reads only the type bits of a mode, so 040000 or 40755 from old tools is a folder too.
      if ((Number.parseInt(entry.mode, 8) & 0o170000) === 0o040000) {
        for (const nestedFile of await forbiddenFiles(entry.objectId, `${file}/`)) {
          files.push(nestedFile);
        }
      } else if (isForbidden(file)) {
        files.push(file);
      }
    }
    checkedTrees.set(key, files);
    return files;
  }

  try {
    for (const { commit, tree } of commits) {
      for (const file of await forbiddenFiles(tree, "")) violations.push(`${commit} ${file}`);
    }
  } catch (error) {
    // Stop git: a reply nobody reads would keep git, and this script, waiting forever.
    batch.stdout.destroy();
    batch.kill();
    throw error;
  } finally {
    batch.stdin.end();
    await finished;
  }
  const result = await finished;
  if (result.error) throw result.error;
  if (result.code !== 0) process.exit(result.code ?? 1);
}

await checkHistory();

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
