import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { writeTextAtomic } from "./atomic-json.js";
import {
  type ConfigFileFormat,
  findGitWorktreeRoot,
  resolveExistingConfigPath,
} from "./config-file-utils.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { editConfigDocumentPaths, parseConfigDocument } from "./opencode-config-editor.js";
import {
  getOpencodeRuntimeDirCandidates,
  getOpencodeRuntimeDirs,
} from "./opencode-runtime-paths.js";
import {
  auditObsoleteUpdateSources,
  discoverExistingScopedUpdateMigrationCandidates,
  inspectLegacyDisplayDocument,
  resolveScopedUpdateMigrationBoundary,
  type ScopedUpdateManualFinding,
  type ScopedUpdateMigrationBoundary,
  type ScopedUpdateSafeAction,
  sortScopedUpdateManualFindings,
  sortScopedUpdateSafeActions,
} from "./scoped-update-migration.js";

export const QUOTA_PACKAGE_NAME = "@slkiser/opencode-quota";
export const QUOTA_LATEST_SPEC = `${QUOTA_PACKAGE_NAME}@latest`;
const GITHUB_REPO_URL = "https://github.com/slkiser/opencode-quota";

const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type ScopedUpdateConfigRole = "package-authority" | "package-edit" | "display-migration";

export interface ScopedUpdateConfigEdit {
  path: string;
  original: string;
  originalBytes: Buffer;
  updated: string;
  replacements: number;
  displayMigrations: number;
}

export interface ScopedUpdateConfigSnapshot {
  path: string;
  originalBytes: Buffer;
  expectedBytes: Buffer;
  updated: string;
  changed: boolean;
  roles: ScopedUpdateConfigRole[];
  migrationBoundary?: ScopedUpdateMigrationBoundary;
}

export interface ScopedUpdatePlan {
  configEdits: ScopedUpdateConfigEdit[];
  configSnapshots: ScopedUpdateConfigSnapshot[];
  configPaths: string[];
  foundSpecs: string[];
  cacheCandidates: string[];
  authoritativeLatest: boolean;
  safeActions: ScopedUpdateSafeAction[];
  manualFindings: ScopedUpdateManualFinding[];
}

export interface ScopedUpdateResult {
  writtenPaths: string[];
  removedCachePaths: string[];
  skippedCachePaths: string[];
}

export class ScopedUpdateError extends Error {
  constructor(
    message: string,
    readonly details?: { writtenPaths?: string[]; path?: string },
  ) {
    super(message);
    this.name = "ScopedUpdateError";
  }
}

export function isCanonicalQuotaUpdateSpec(spec: string): boolean {
  if (spec === QUOTA_PACKAGE_NAME || spec === QUOTA_LATEST_SPEC) return true;
  const prefix = `${QUOTA_PACKAGE_NAME}@`;
  return spec.startsWith(prefix) && EXACT_SEMVER.test(spec.slice(prefix.length));
}

export function sanitizeOpenCodePackageSpec(
  spec: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return spec;
  return Array.from(spec, (char) =>
    new Set(["<", ">", ":", '"', "|", "?", "*"]).has(char) || char.charCodeAt(0) < 32 ? "_" : char,
  ).join("");
}

function selectedConfigPaths(root: string): string[] {
  return (["opencode", "tui"] as const).flatMap((kind) => {
    const path = resolveExistingConfigPath(root, kind);
    return path ? [path] : [];
  });
}

async function dedupeByRealPath(paths: string[]): Promise<string[]> {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const resolved = await realpath(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push(path);
  }
  return output;
}

function pluginArrays(config: unknown): Array<{ path: (string | number)[]; entries: unknown[] }> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const root = config as Record<string, unknown>;
  const arrays: Array<{ path: (string | number)[]; entries: unknown[] }> = [];
  if (Array.isArray(root.plugin)) arrays.push({ path: ["plugin"], entries: root.plugin });
  if (root.tui && typeof root.tui === "object" && !Array.isArray(root.tui)) {
    const tui = root.tui as Record<string, unknown>;
    if (Array.isArray(tui.plugin)) arrays.push({ path: ["tui", "plugin"], entries: tui.plugin });
  }
  return arrays;
}

function updateConfig(
  raw: string,
  path: string,
): {
  updated: string;
  replacements: number;
  specs: string[];
} {
  const format: ConfigFileFormat = path.endsWith(".jsonc") ? "jsonc" : "json";
  let parsed: Record<string, unknown>;
  try {
    parsed = parseConfigDocument(raw, format, path);
  } catch {
    throw new ScopedUpdateError(`Cannot update unparseable config: ${path}`, { path });
  }

  const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
  let replacements = 0;
  const specs: string[] = [];
  for (const array of pluginArrays(parsed)) {
    for (let index = array.entries.length - 1; index >= 0; index--) {
      const entry = array.entries[index];
      const spec =
        typeof entry === "string"
          ? entry
          : Array.isArray(entry) && typeof entry[0] === "string"
            ? entry[0]
            : null;
      if (spec === null || !isCanonicalQuotaUpdateSpec(spec)) continue;
      specs.push(spec);
      if (spec === QUOTA_LATEST_SPEC) continue;
      const targetPath =
        typeof entry === "string" ? [...array.path, index] : [...array.path, index, 0];
      edits.push({ path: targetPath, value: QUOTA_LATEST_SPEC });
      replacements++;
    }
  }
  const updated = editConfigDocumentPaths({ raw, format, path, edits });
  return { updated, replacements, specs };
}

interface ScopedUpdateWorkingDocument {
  path: string;
  original: string;
  originalBytes: Buffer;
  updated: string;
  replacements: number;
  displayMigrations: number;
  roles: Set<ScopedUpdateConfigRole>;
  migrationBoundary?: ScopedUpdateMigrationBoundary;
}

const CONFIG_ROLE_ORDER: ScopedUpdateConfigRole[] = [
  "package-authority",
  "package-edit",
  "display-migration",
];

export async function planScopedUpdate(
  params: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<ScopedUpdatePlan> {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const projectRoot = findGitWorktreeRoot(cwd) ?? cwd;
  const primaryRuntime = getOpencodeRuntimeDirs({ env, homeDir: params.homeDir });
  const runtime = getOpencodeRuntimeDirCandidates({
    platform: params.platform,
    env,
    homeDir: params.homeDir,
    primary: primaryRuntime,
  });
  const configPaths = await dedupeByRealPath([
    ...selectedConfigPaths(projectRoot),
    ...selectedConfigPaths(primaryRuntime.configDir),
  ]);

  const workingDocuments = new Map<string, ScopedUpdateWorkingDocument>();
  const foundSpecs: string[] = [];
  const safeActions: ScopedUpdateSafeAction[] = [];
  const manualFindings: ScopedUpdateManualFinding[] = [];

  for (const path of configPaths) {
    const canonicalPath = await realpath(path);
    const originalBytes = await readFile(path);
    const original = originalBytes.toString("utf8");
    const planned = updateConfig(original, path);
    foundSpecs.push(...planned.specs);
    const roles = new Set<ScopedUpdateConfigRole>(["package-authority"]);
    if (planned.replacements > 0) {
      roles.add("package-edit");
      safeActions.push({
        kind: "package-spec",
        path,
        replacements: planned.replacements,
      });
    }
    workingDocuments.set(canonicalPath, {
      path,
      original,
      originalBytes,
      updated: planned.updated,
      replacements: planned.replacements,
      displayMigrations: 0,
      roles,
    });
  }

  const migrationDiscovery = await discoverExistingScopedUpdateMigrationCandidates({
    globalRoots: runtime.configDirs,
    workspaceRoot: projectRoot,
    selectedPackagePaths: configPaths,
  });
  manualFindings.push(...migrationDiscovery.manualFindings);

  for (const candidate of migrationDiscovery.candidates) {
    const existingDocument = workingDocuments.get(candidate.realPath);
    if (existingDocument) {
      existingDocument.roles.add("display-migration");
      existingDocument.migrationBoundary = candidate;
      const inspection = inspectLegacyDisplayDocument({
        path: existingDocument.path,
        format: existingDocument.path.endsWith(".jsonc") ? "jsonc" : "json",
        raw: existingDocument.updated,
        container: candidate.container,
      });
      existingDocument.updated = inspection.updated;
      existingDocument.displayMigrations += inspection.safeActions.length;
      safeActions.push(...inspection.safeActions);
      manualFindings.push(...inspection.manualFindings);
      continue;
    }

    let originalBytes: Buffer;
    try {
      originalBytes = await readFile(candidate.path);
    } catch {
      throw new ScopedUpdateError(`Failed reading update migration config: ${candidate.path}`, {
        path: candidate.path,
      });
    }
    const original = originalBytes.toString("utf8");
    const inspection = inspectLegacyDisplayDocument({
      path: candidate.path,
      format: candidate.format,
      raw: original,
      container: candidate.container,
    });
    safeActions.push(...inspection.safeActions);
    manualFindings.push(...inspection.manualFindings);
    if (
      inspection.manualFindings.some((finding) => finding.kind === "migration-file-uninspectable")
    ) {
      continue;
    }

    workingDocuments.set(candidate.realPath, {
      path: candidate.path,
      original,
      originalBytes,
      updated: inspection.updated,
      replacements: 0,
      displayMigrations: inspection.safeActions.length,
      roles: new Set(["display-migration"]),
      migrationBoundary: candidate,
    });
  }

  manualFindings.push(
    ...(await auditObsoleteUpdateSources({
      env,
      configDirs: runtime.configDirs,
      primaryConfigDir: primaryRuntime.configDir,
    })),
  );

  const configEdits: ScopedUpdateConfigEdit[] = [];
  const configSnapshots: ScopedUpdateConfigSnapshot[] = [];
  for (const document of workingDocuments.values()) {
    const changed = document.updated !== document.original;
    configSnapshots.push({
      path: document.path,
      originalBytes: document.originalBytes,
      expectedBytes: changed ? Buffer.from(document.updated, "utf8") : document.originalBytes,
      updated: document.updated,
      changed,
      roles: CONFIG_ROLE_ORDER.filter((role) => document.roles.has(role)),
      ...(document.migrationBoundary ? { migrationBoundary: document.migrationBoundary } : {}),
    });
    if (changed) {
      configEdits.push({
        path: document.path,
        original: document.original,
        originalBytes: document.originalBytes,
        updated: document.updated,
        replacements: document.replacements,
        displayMigrations: document.displayMigrations,
      });
    }
  }

  const uniqueSpecs = [...new Set(foundSpecs)];
  const cacheSpecs = [...new Set([...uniqueSpecs, QUOTA_LATEST_SPEC])];
  const cacheCandidates = runtime.cacheDirs.flatMap((cacheDir) =>
    cacheSpecs.map((spec) =>
      join(cacheDir, "packages", sanitizeOpenCodePackageSpec(spec, params.platform)),
    ),
  );

  return {
    configEdits,
    configSnapshots,
    configPaths,
    foundSpecs: uniqueSpecs,
    cacheCandidates: [...new Set(cacheCandidates)],
    authoritativeLatest: uniqueSpecs.length > 0,
    safeActions: sortScopedUpdateSafeActions(safeActions),
    manualFindings: sortScopedUpdateManualFindings(manualFindings),
  };
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function removeVerifiedCacheCandidate(path: string): Promise<"removed" | "skipped"> {
  const packagesPath = dirname(dirname(path));
  try {
    const packagesStat = await lstat(packagesPath);
    const ownerStat = await lstat(dirname(path));
    if (packagesStat.isSymbolicLink() || ownerStat.isSymbolicLink()) return "skipped";
    const packagesReal = await realpath(packagesPath);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "skipped";
    const candidateReal = await realpath(path);
    if (!containedBy(packagesReal, candidateReal) || candidateReal === packagesReal)
      return "skipped";

    const manifestPath = join(
      candidateReal,
      "node_modules",
      "@slkiser",
      "opencode-quota",
      "package.json",
    );
    const manifestStat = await lstat(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return "skipped";
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown };
    if (manifest.name !== QUOTA_PACKAGE_NAME) return "skipped";

    await rm(candidateReal, { recursive: true, force: false });
    return "removed";
  } catch {
    return "skipped";
  }
}

function displayUpdatePath(path: string): string {
  return sanitizeSingleLineDisplayText(path);
}

function formatSafeAction(action: ScopedUpdateSafeAction): string {
  const path = displayUpdatePath(action.path);
  if (action.kind === "package-spec") {
    const noun = action.replacements === 1 ? "replacement" : "replacements";
    return `  edit ${path} (${action.replacements} package ${noun})`;
  }

  switch (action.outcome) {
    case "set-and-remove-old":
      return `  edit ${path}: map opencodeZenDisplay: ${action.from} to accountingDetail: ${action.to}`;
    case "remove-redundant-old":
      return `  edit ${path}: remove redundant opencodeZenDisplay: ${action.from}; keep accountingDetail: ${action.to}`;
    case "keep-current-and-remove-old":
      return `  edit ${path}: keep current accountingDetail; remove obsolete ignored opencodeZenDisplay: ${action.from}`;
  }
}

const OBSOLETE_GO_GUIDANCE =
  "OpenCode Go no longer uses this workspace/cookie source, and it cannot be converted into the official API key. Configure OPENCODE_API_KEY, trusted global provider.opencode-go.options.apiKey, fallback provider.opencode.options.apiKey, or run opencode auth login -p opencode-go. This updater will not read, copy, or delete credentials; remove the old variable/file manually after the supported key works.";

function formatManualFinding(finding: ScopedUpdateManualFinding): string {
  switch (finding.kind) {
    case "obsolete-go-env":
      return `  ${finding.name}: ${OBSOLETE_GO_GUIDANCE}`;
    case "obsolete-go-file":
      return `  ${displayUpdatePath(finding.path)}: ${OBSOLETE_GO_GUIDANCE}`;
    case "ambiguous-zen-env": {
      const names = finding.names.join(" and ");
      const suggestedPath = displayUpdatePath(finding.suggestedPath);
      return `  ${names}: These environment names may be from an older OpenCode Zen setup, but they may also belong to OpenCode's workspace feature. Current quota code ignores them, and no supported global opencode-quota/opencode.json was found. Review the variables, then create and protect the supported file manually only if they are Zen credentials. Suggested path: ${suggestedPath}. This updater will not read, print, or move their values.`;
    }
    case "display-migration-manual": {
      const path = displayUpdatePath(finding.path);
      switch (finding.reason) {
        case "unsupported-legacy-value":
          return `  ${path}: opencodeZenDisplay has no supported equivalent; review it manually without exposing its value.`;
        case "invalid-accounting-detail":
          return `  ${path}: accountingDetail is invalid; fix it, then remove opencodeZenDisplay manually.`;
        case "duplicate-key":
          return `  ${path}: duplicate display keys require manual review.`;
        case "unsupported-structure":
          return `  ${path}: experimental.quotaToast is structurally ambiguous and requires manual review.`;
      }
      throw new Error("Unknown display migration finding");
    }
    case "migration-file-uninspectable": {
      const path = displayUpdatePath(finding.path);
      switch (finding.reason) {
        case "invalid-json":
          return `  ${path}: the migration file contains invalid JSON/JSONC and could not be inspected.`;
        case "unsupported-root":
          return `  ${path}: the migration file root is not an object and requires manual review.`;
        case "symlink":
          return `  ${path}: the migration path is a symlink and will not be changed automatically.`;
      }
      throw new Error("Unknown migration file finding");
    }
  }
}

export function formatScopedUpdatePreview(plan: ScopedUpdatePlan): string[] {
  const lines = ["Responsible OpenCode Quota update preview"];

  if (plan.safeActions.length > 0) {
    lines.push("", "Safe changes this command can make:");
    lines.push(...plan.safeActions.map(formatSafeAction));
  }

  if (plan.manualFindings.length > 0) {
    lines.push("", "Manual actions — this command will not change these sources:");
    lines.push(...plan.manualFindings.map(formatManualFinding));
  }

  if (plan.authoritativeLatest && plan.cacheCandidates.length > 0) {
    lines.push("", "Package-cache candidates (removed only after verification):");
    lines.push(...plan.cacheCandidates.map((path) => `  ${displayUpdatePath(path)}`));
  }

  lines.push("", "No configuration or package-cache changes have been made yet.");
  return lines;
}

export async function applyScopedUpdatePlan(
  plan: ScopedUpdatePlan,
  options: {
    dryRun?: boolean;
    readBytes?: (path: string) => Promise<Buffer>;
    writeText?: (path: string, content: string) => Promise<void>;
    beforeCacheDeletion?: () => Promise<void>;
  } = {},
): Promise<ScopedUpdateResult> {
  if (options.dryRun) {
    return { writtenPaths: [], removedCachePaths: [], skippedCachePaths: [] };
  }

  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const writeText = options.writeText ?? writeTextAtomic;
  const writtenPaths: string[] = [];
  const failure = (action: string, path: string): ScopedUpdateError => {
    const changed =
      writtenPaths.length > 0
        ? ` Changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}.`
        : "";
    return new ScopedUpdateError(
      `${action} ${displayUpdatePath(path)}; no cache was deleted.${changed}`,
      {
        path,
        writtenPaths: [...writtenPaths],
      },
    );
  };

  for (const snapshot of plan.configSnapshots) {
    let current: Buffer;
    try {
      current = await readBytes(snapshot.path);
    } catch {
      throw failure("Failed reading", snapshot.path);
    }
    if (!current.equals(snapshot.originalBytes)) {
      throw failure("Config changed since preview:", snapshot.path);
    }
  }

  for (const snapshot of plan.configSnapshots) {
    if (!snapshot.changed) continue;
    let current: Buffer;
    try {
      current = await readBytes(snapshot.path);
    } catch {
      throw failure("Failed re-reading before write", snapshot.path);
    }
    if (!current.equals(snapshot.originalBytes)) {
      throw failure("Config changed since preview:", snapshot.path);
    }
    if (snapshot.migrationBoundary) {
      let boundary: ScopedUpdateMigrationBoundary | null;
      try {
        boundary = await resolveScopedUpdateMigrationBoundary({
          path: snapshot.migrationBoundary.path,
          rootDir: snapshot.migrationBoundary.rootDir,
          expectedRealPath: snapshot.migrationBoundary.realPath,
          expectedRealRoot: snapshot.migrationBoundary.realRoot,
          writePath: snapshot.path,
        });
      } catch {
        throw failure("Failed revalidating migration boundary for", snapshot.path);
      }
      if (boundary === null) {
        throw failure("Migration boundary changed before writing", snapshot.path);
      }
    }
    try {
      await writeText(snapshot.path, snapshot.updated);
      writtenPaths.push(snapshot.path);
    } catch {
      throw failure("Failed writing", snapshot.path);
    }
  }

  try {
    await options.beforeCacheDeletion?.();
  } catch {
    const changed =
      writtenPaths.length > 0
        ? ` Changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}.`
        : "";
    throw new ScopedUpdateError(`Failed before cache deletion; no cache was deleted.${changed}`, {
      writtenPaths: [...writtenPaths],
    });
  }

  let authoritativeLatest = false;
  for (const snapshot of plan.configSnapshots) {
    let current: Buffer;
    try {
      current = await readBytes(snapshot.path);
    } catch {
      throw failure("Failed re-reading", snapshot.path);
    }
    if (!current.equals(snapshot.expectedBytes)) {
      throw failure("Config changed before cache deletion:", snapshot.path);
    }
    if (!snapshot.roles.includes("package-authority")) continue;
    const currentPlan = updateConfig(current.toString("utf8"), snapshot.path);
    if (currentPlan.specs.includes(QUOTA_LATEST_SPEC)) authoritativeLatest = true;
  }

  const removedCachePaths: string[] = [];
  const skippedCachePaths: string[] = [];
  if (authoritativeLatest) {
    for (const candidate of plan.cacheCandidates) {
      const result = await removeVerifiedCacheCandidate(candidate);
      (result === "removed" ? removedCachePaths : skippedCachePaths).push(candidate);
    }
  }
  return { writtenPaths, removedCachePaths, skippedCachePaths };
}

export async function runScopedUpdateCommand(
  params: {
    argv?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
    confirm?: (message: string) => Promise<boolean>;
    log?: (message: string) => void;
  } = {},
): Promise<number> {
  const argv = params.argv ?? [];
  const unknown = argv.filter((arg) => arg !== "--dry-run" && arg !== "--yes");
  if (unknown.length > 0) return 1;

  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const log = params.log ?? console.log;
  try {
    const plan = await planScopedUpdate(params);
    for (const line of formatScopedUpdatePreview(plan)) log(line);

    const hasConfigChanges = plan.configSnapshots.some((snapshot) => snapshot.changed);
    const hasAutomaticWork = hasConfigChanges || plan.authoritativeLatest;

    if (dryRun) {
      log(
        "Responsible update preview complete — no configuration or package-cache changes were made.",
      );
      return 0;
    }

    if (!hasAutomaticWork) {
      if (plan.manualFindings.length > 0) {
        log(
          "No automatic changes are available. Complete the manual actions above, then rerun update.",
        );
      } else {
        log("OpenCode Quota update is already current. No files changed.");
        log(`If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`);
      }
      return 0;
    }

    if (!yes) {
      const confirm =
        params.confirm ??
        (async (message: string) => {
          const prompts = await import("@clack/prompts");
          const answer = await prompts.confirm({ message });
          return !prompts.isCancel(answer) && answer === true;
        });
      if (
        !(await confirm(
          "Apply the safe config changes above and remove only manifest-verified package-cache directories?",
        ))
      ) {
        log("OpenCode Quota update cancelled — no files changed.");
        return 0;
      }
    }

    const result = await applyScopedUpdatePlan(plan);
    for (const path of result.writtenPaths) log(`Updated ${displayUpdatePath(path)}`);
    for (const path of result.removedCachePaths) log(`Removed ${displayUpdatePath(path)}`);
    for (const path of result.skippedCachePaths) {
      log(`Skipped unverified cache candidate ${displayUpdatePath(path)}`);
    }
    log("OpenCode Quota update complete.");
    if (plan.configPaths.length > 0) {
      log(`Configured paths: ${plan.configPaths.map(displayUpdatePath).join(", ")}`);
    }
    log("Restart OpenCode and run /quota.");
    log(`If OpenCode Quota helps, please consider a star: ${GITHUB_REPO_URL}`);
    return 0;
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    const reason = sanitizeSingleLineDisplayText(rawReason) || "Unknown update failure";
    log(`OpenCode Quota update failed: ${reason}`);
    const writtenPaths =
      error instanceof ScopedUpdateError ? (error.details?.writtenPaths ?? []) : [];
    log(
      writtenPaths.length > 0
        ? `Files changed before failure: ${writtenPaths.map(displayUpdatePath).join(", ")}. Fix the reason above, then rerun update.`
        : "No files changed. Fix the reason above, then rerun update.",
    );
    return 1;
  }
}
