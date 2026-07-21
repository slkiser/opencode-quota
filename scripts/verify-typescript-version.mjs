import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const lockfile = await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");
const configuredVersion = packageJson.devDependencies?.typescript;

if (typeof configuredVersion !== "string" || !/^\^5\.9\.\d+$/.test(configuredVersion)) {
  console.error(
    `TypeScript must remain on ^5.9.x during v4; package.json has ${String(configuredVersion)}.`,
  );
  process.exit(1);
}

const lockSpecifier = lockfile.match(
  /\n      typescript:\n        specifier: ([^\n]+)\n        version: ([^\n]+)/,
);
if (!lockSpecifier) {
  console.error("Unable to find the root TypeScript dependency in pnpm-lock.yaml.");
  process.exit(1);
}

const [, lockedSpecifier, lockedVersion] = lockSpecifier;
if (lockedSpecifier !== configuredVersion || !/^5\.9\.\d+$/.test(lockedVersion)) {
  console.error(
    `TypeScript lock mismatch: package.json=${configuredVersion}, lock specifier=${lockedSpecifier}, lock version=${lockedVersion}.`,
  );
  process.exit(1);
}

if (/^  typescript@[67]\./m.test(lockfile)) {
  console.error("An optional TypeScript 6/7 package entered the v4 lockfile.");
  process.exit(1);
}

console.log(`TypeScript v4 freeze verified: ${configuredVersion} resolves to ${lockedVersion}.`);
