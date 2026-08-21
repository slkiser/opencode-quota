import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";
const EXPECTED_PLUGIN_VERSION = "1.18.1";
const EXPECTED_OPENTUI_SPECIFIER = "^0.5.3";
const EXPECTED_OPENTUI_VERSION = "0.5.4";
const EXPECTED_OPENTUI_PACKAGES = ["@opentui/core", "@opentui/solid"];
const BUN_FFI_STRUCTS_VERSION = "0.3.1";
const BUN_FFI_TYPESCRIPT_PEER = "^5";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const lockfile = parse(await readFile(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"));
const workspace = parse(await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function findPeerSuppressions(value, location, suppressions = []) {
  if (!value || typeof value !== "object") return suppressions;

  for (const [key, nestedValue] of Object.entries(value)) {
    const nestedLocation = `${location}.${key}`;
    if (key === "peerDependencyRules" || key === "allowedVersions" || key === "ignoreMissing") {
      suppressions.push(nestedLocation);
    }
    if (key === "strictPeerDependencies" && nestedValue === false) {
      suppressions.push(nestedLocation);
    }
    findPeerSuppressions(nestedValue, nestedLocation, suppressions);
  }

  return suppressions;
}

function hasTypeScriptPeerOverride(value) {
  if (!value || typeof value !== "object") return false;

  return Object.entries(value).some(([key, nestedValue]) => {
    if (/bun-ffi-structs|typescript/i.test(key)) return true;
    if (typeof nestedValue === "string" && /bun-ffi-structs|typescript/i.test(nestedValue)) {
      return true;
    }
    return hasTypeScriptPeerOverride(nestedValue);
  });
}

const configuredTypeScript = packageJson.devDependencies?.typescript;
const configuredPlugin = packageJson.devDependencies?.["@opencode-ai/plugin"];
if (configuredTypeScript !== EXPECTED_TYPESCRIPT_VERSION) {
  fail(
    `TypeScript must be pinned exactly to ${EXPECTED_TYPESCRIPT_VERSION}; package.json has ${String(configuredTypeScript)}.`,
  );
}
if (configuredPlugin !== EXPECTED_PLUGIN_VERSION) {
  fail(
    `@opencode-ai/plugin must be pinned exactly to ${EXPECTED_PLUGIN_VERSION}; package.json has ${String(configuredPlugin)}.`,
  );
}
for (const name of EXPECTED_OPENTUI_PACKAGES) {
  const configuredVersion = packageJson.dependencies?.[name];
  if (configuredVersion !== EXPECTED_OPENTUI_SPECIFIER) {
    fail(
      `${name} must be pinned to ${EXPECTED_OPENTUI_SPECIFIER}; package.json has ${String(configuredVersion)}.`,
    );
  }
}

const suppressions = [
  ...findPeerSuppressions(packageJson, "package.json"),
  ...findPeerSuppressions(workspace, "pnpm-workspace.yaml"),
];
if (suppressions.length > 0) {
  fail(`TypeScript peer suppression is not allowed: ${suppressions.join(", ")}.`);
}

const overrideSections = [
  packageJson.overrides,
  packageJson.pnpm?.overrides,
  packageJson.pnpm?.packageExtensions,
  workspace?.overrides,
  workspace?.packageExtensions,
];
if (overrideSections.some(hasTypeScriptPeerOverride)) {
  fail("TypeScript or bun-ffi-structs must not be hidden behind an override or package extension.");
}

const rootImporter = lockfile?.importers?.["."];
if (!rootImporter) {
  fail("Unable to find the root importer in pnpm-lock.yaml.");
}

function verifyImporterDependency(name, expectedVersion) {
  const dependency = rootImporter.devDependencies?.[name];
  if (dependency?.specifier !== expectedVersion || dependency?.version !== expectedVersion) {
    fail(
      `${name} lock mismatch: expected specifier and version ${expectedVersion}, found ${String(dependency?.specifier)} and ${String(dependency?.version)}.`,
    );
  }
}

verifyImporterDependency("typescript", EXPECTED_TYPESCRIPT_VERSION);

for (const name of EXPECTED_OPENTUI_PACKAGES) {
  const dependency = rootImporter.dependencies?.[name];
  if (
    dependency?.specifier !== EXPECTED_OPENTUI_SPECIFIER ||
    (dependency?.version !== EXPECTED_OPENTUI_VERSION &&
      !dependency?.version?.startsWith(`${EXPECTED_OPENTUI_VERSION}(`))
  ) {
    fail(
      `${name} lock mismatch: expected ${EXPECTED_OPENTUI_VERSION}, found ${String(dependency?.specifier)} and ${String(dependency?.version)}.`,
    );
  }
}

const lockedPlugin = rootImporter.devDependencies?.["@opencode-ai/plugin"];
if (
  lockedPlugin?.specifier !== EXPECTED_PLUGIN_VERSION ||
  (lockedPlugin?.version !== EXPECTED_PLUGIN_VERSION &&
    !lockedPlugin?.version?.startsWith(`${EXPECTED_PLUGIN_VERSION}(`))
) {
  fail(
    `@opencode-ai/plugin lock mismatch: expected ${EXPECTED_PLUGIN_VERSION}, found ${String(lockedPlugin?.specifier)} and ${String(lockedPlugin?.version)}.`,
  );
}

const packageKeys = Object.keys(lockfile.packages ?? {});
const snapshotKeys = Object.keys(lockfile.snapshots ?? {});
const expectedTypeScriptKey = `typescript@${EXPECTED_TYPESCRIPT_VERSION}`;
const expectedPluginKey = `@opencode-ai/plugin@${EXPECTED_PLUGIN_VERSION}`;

if (!packageKeys.includes(expectedTypeScriptKey) || !snapshotKeys.includes(expectedTypeScriptKey)) {
  fail(`pnpm-lock.yaml must contain package and snapshot entries for ${expectedTypeScriptKey}.`);
}
if (
  !packageKeys.includes(expectedPluginKey) ||
  !snapshotKeys.some((key) => key === expectedPluginKey || key.startsWith(`${expectedPluginKey}(`))
) {
  fail(`pnpm-lock.yaml must contain package and snapshot entries for ${expectedPluginKey}.`);
}

const typeScriptPackageKeys = packageKeys.filter((key) => key.startsWith("typescript@"));
const typeScriptSnapshotKeys = snapshotKeys.filter((key) => key.startsWith("typescript@"));
if (
  typeScriptPackageKeys.some((key) => key !== expectedTypeScriptKey) ||
  typeScriptSnapshotKeys.some((key) => key !== expectedTypeScriptKey)
) {
  fail(
    `Unexpected additional TypeScript lock entries: ${[
      ...typeScriptPackageKeys,
      ...typeScriptSnapshotKeys,
    ].join(", ")}.`,
  );
}

const bunPackageKey = `bun-ffi-structs@${BUN_FFI_STRUCTS_VERSION}`;
const bunPackage = lockfile.packages?.[bunPackageKey];
if (bunPackage?.peerDependencies?.typescript !== BUN_FFI_TYPESCRIPT_PEER) {
  fail(
    `${bunPackageKey} must retain its visible typescript peer ${BUN_FFI_TYPESCRIPT_PEER}; found ${String(bunPackage?.peerDependencies?.typescript)}.`,
  );
}

const bunSnapshots = snapshotKeys.filter(
  (key) => key === bunPackageKey || key.startsWith(`${bunPackageKey}(`),
);
if (
  bunSnapshots.length !== 1 ||
  !bunSnapshots[0].includes(`typescript@${EXPECTED_TYPESCRIPT_VERSION}`)
) {
  fail(
    `${bunPackageKey} must resolve visibly against TypeScript ${EXPECTED_TYPESCRIPT_VERSION}; found ${bunSnapshots.join(", ") || "no snapshot"}.`,
  );
}

console.warn(
  `Known unmet peer: ${bunPackageKey} declares typescript ${BUN_FFI_TYPESCRIPT_PEER}, while the root uses ${EXPECTED_TYPESCRIPT_VERSION}. This mismatch is intentionally not suppressed.`,
);
console.log(
  `TypeScript ${EXPECTED_TYPESCRIPT_VERSION} and @opencode-ai/plugin ${EXPECTED_PLUGIN_VERSION} lock entries verified.`,
);
