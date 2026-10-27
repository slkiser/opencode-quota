import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const manifestPath = process.argv[2];

function parsePackManifest(raw) {
  const jsonStart = Math.min(
    ...["{", "["].map((token) => {
      const index = raw.indexOf(token);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );

  if (!Number.isFinite(jsonStart)) throw new Error("pnpm pack did not return JSON.");
  const parsed = JSON.parse(raw.slice(jsonStart));
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error("pnpm pack JSON is missing its files list.");
  }

  return manifest;
}

let rawManifest;
if (manifestPath) {
  rawManifest = await readFile(path.resolve(repoRoot, manifestPath), "utf8");
} else {
  const pnpmCliPath = process.env.npm_execpath;
  if (!pnpmCliPath) {
    throw new Error("pnpm CLI path is unavailable; run this script through pnpm.");
  }
  const args = ["--config.ignore-scripts=true", "pack", "--json", "--dry-run"];
  const isJavaScript = /\.(?:c?js|mjs)$/u.test(pnpmCliPath);
  const result = spawnSync(
    isJavaScript ? process.execPath : pnpmCliPath,
    isJavaScript ? [pnpmCliPath, ...args] : args,
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  rawManifest = result.stdout;
}

const manifest = parsePackManifest(rawManifest);
const files = manifest.files.map((entry) => entry.path).sort();
const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
const unexpected = files.filter((file) => !allowedRootFiles.has(file) && !file.startsWith("dist/"));

if (unexpected.length > 0) {
  console.error("npm package contains files outside the strict allowlist:");
  for (const file of unexpected) console.error(`- ${file}`);
  process.exit(1);
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const requiredFiles = new Set([
  "LICENSE",
  "README.md",
  "package.json",
  "dist/data/modelsdev-pricing.min.json",
]);

function addManifestPath(value) {
  if (typeof value === "string" && value.startsWith("./dist/")) {
    requiredFiles.add(value.slice(2));
  }
}

addManifestPath(packageJson.main);
addManifestPath(packageJson.types);
for (const value of Object.values(packageJson.bin ?? {})) addManifestPath(value);
for (const target of Object.values(packageJson.exports ?? {})) {
  if (typeof target === "string") {
    addManifestPath(target);
    continue;
  }
  for (const value of Object.values(target ?? {})) addManifestPath(value);
}

const missing = [...requiredFiles].filter((file) => !files.includes(file)).sort();
if (missing.length > 0) {
  console.error("npm package is missing required release output:");
  for (const file of missing) console.error(`- ${file}`);
  process.exit(1);
}

// The GUI bundle runs in the OpenCode app, which gives it only these modules (the list in
// `@opencode/plugin/gui/vite`), Electron and Node built-ins; anything else must be bundled.
const guiBundle = packageJson.exports?.["./gui-experimental"]?.slice(2);
const guiProvidedModules = new Set([
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
  "electron",
]);
if (guiBundle !== "dist/gui-experimental.cjs") {
  console.error(`package.json ./gui-experimental must be ./dist/gui-experimental.cjs.`);
  process.exit(1);
}
const guiSource = await readFile(path.join(repoRoot, guiBundle), "utf8");
const guiRequires = [...guiSource.matchAll(/\brequire\((["'`])([^"'`]+)\1\)/gu)].map(
  (match) => match[2],
);
const unprovided = guiRequires.filter((id) => !guiProvidedModules.has(id) && !isBuiltin(id));
if (unprovided.length > 0 || guiSource.includes("import(")) {
  console.error(`${guiBundle} needs modules the OpenCode app does not provide:`);
  for (const id of unprovided) console.error(`- ${id}`);
  if (guiSource.includes("import(")) console.error("- a dynamic import()");
  process.exit(1);
}

const distCount = files.filter((file) => file.startsWith("dist/")).length;
console.log(
  `npm contents verified: ${files.length} files (${distCount} dist files plus package.json, README.md, and LICENSE).`,
);
