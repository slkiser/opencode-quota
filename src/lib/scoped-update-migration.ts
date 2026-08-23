import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { type Node as JsonNode, type ParseError, parseTree } from "jsonc-parser";

import { buildConfigLayerCandidates, type ConfigLayerScope } from "./config.js";
import type { ConfigFileFormat } from "./config-file-utils.js";
import { editConfigDocumentPaths } from "./opencode-config-editor.js";

export type ScopedUpdateSafeAction =
  | {
      kind: "package-spec";
      path: string;
      replacements: number;
    }
  | {
      kind: "accounting-detail-migration";
      path: string;
      container: "quota-root" | "experimental.quotaToast";
      from: "default" | "detailed";
      to: "summary" | "detailed";
      outcome: "set-and-remove-old" | "remove-redundant-old" | "keep-current-and-remove-old";
    };

export type ScopedUpdateManualFinding =
  | {
      kind: "obsolete-go-env";
      name: "OPENCODE_GO_WORKSPACE_ID" | "OPENCODE_GO_AUTH_COOKIE";
    }
  | {
      kind: "obsolete-go-file";
      path: string;
    }
  | {
      kind: "ambiguous-zen-env";
      names: Array<"OPENCODE_WORKSPACE_ID" | "OPENCODE_AUTH_COOKIE">;
      suggestedPath: string;
    }
  | {
      kind: "display-migration-manual";
      path: string;
      container: "quota-root" | "experimental.quotaToast";
      reason:
        | "unsupported-legacy-value"
        | "invalid-accounting-detail"
        | "duplicate-key"
        | "unsupported-structure";
    }
  | {
      kind: "migration-file-uninspectable";
      path: string;
      reason: "invalid-json" | "unsupported-root" | "symlink";
    };

/**
 * The last release supporting this setting accepted only these two values.
 * Historical evidence: commit b2e2dd913.
 */
export const LEGACY_DISPLAY_MAPPINGS = {
  default: "summary",
  detailed: "detailed",
} as const;

/** Historical OpenCode Go workspace/cookie sources from commit 6d20f208f. */
export const OBSOLETE_GO_ENV_NAMES = [
  "OPENCODE_GO_WORKSPACE_ID",
  "OPENCODE_GO_AUTH_COOKIE",
] as const;

export const AMBIGUOUS_ZEN_ENV_NAMES = ["OPENCODE_WORKSPACE_ID", "OPENCODE_AUTH_COOKIE"] as const;

export const OBSOLETE_GO_FILE = "opencode-quota/opencode-go.json";
export const SUPPORTED_ZEN_FILE = "opencode-quota/opencode.json";

export interface ScopedUpdateMigrationCandidate {
  path: string;
  rootDir: string;
  scope: ConfigLayerScope;
  format: ConfigFileFormat;
  container: "quota-root" | "experimental.quotaToast";
}

export interface ScopedUpdateMigrationBoundary {
  path: string;
  rootDir: string;
  realPath: string;
  realRoot: string;
}

export interface DiscoveredScopedUpdateMigrationCandidate
  extends ScopedUpdateMigrationCandidate,
    ScopedUpdateMigrationBoundary {}

interface ObjectProperty {
  value: JsonNode;
}

function objectProperties(node: JsonNode, key: string): ObjectProperty[] {
  if (node.type !== "object") {
    return [];
  }

  const matches: ObjectProperty[] = [];
  for (const child of node.children ?? []) {
    const name = child.children?.[0];
    const value = child.children?.[1];
    if (child.type === "property" && name?.value === key && value) {
      matches.push({ value });
    }
  }
  return matches;
}

function emptyInspection(raw: string): ReturnType<typeof inspectLegacyDisplayDocument> {
  return {
    updated: raw,
    changed: false,
    safeActions: [],
    manualFindings: [],
  };
}

function manualDisplayInspection(
  raw: string,
  params: Pick<Parameters<typeof inspectLegacyDisplayDocument>[0], "path" | "container">,
  reason: Extract<ScopedUpdateManualFinding, { kind: "display-migration-manual" }>["reason"],
): ReturnType<typeof inspectLegacyDisplayDocument> {
  return {
    ...emptyInspection(raw),
    manualFindings: [
      {
        kind: "display-migration-manual",
        path: params.path,
        container: params.container,
        reason,
      },
    ],
  };
}

export function inspectLegacyDisplayDocument(params: {
  path: string;
  format: ConfigFileFormat;
  raw: string;
  container: "quota-root" | "experimental.quotaToast";
}): {
  updated: string;
  changed: boolean;
  safeActions: ScopedUpdateSafeAction[];
  manualFindings: ScopedUpdateManualFinding[];
} {
  const errors: ParseError[] = [];
  const root = parseTree(params.raw, errors, {
    allowTrailingComma: params.format === "jsonc",
    disallowComments: params.format === "json",
  });

  if (!root || errors.length > 0) {
    return {
      ...emptyInspection(params.raw),
      manualFindings: [
        {
          kind: "migration-file-uninspectable",
          path: params.path,
          reason: "invalid-json",
        },
      ],
    };
  }

  if (root.type !== "object") {
    return {
      ...emptyInspection(params.raw),
      manualFindings: [
        {
          kind: "migration-file-uninspectable",
          path: params.path,
          reason: "unsupported-root",
        },
      ],
    };
  }

  let target = root;
  const targetPath: string[] = [];
  if (params.container === "experimental.quotaToast") {
    const experimental = objectProperties(root, "experimental");
    if (experimental.length === 0) {
      return emptyInspection(params.raw);
    }
    const experimentalValue = experimental[0]?.value;
    if (experimental.length !== 1 || experimentalValue?.type !== "object") {
      return manualDisplayInspection(params.raw, params, "unsupported-structure");
    }

    const quotaToast = objectProperties(experimentalValue, "quotaToast");
    if (quotaToast.length === 0) {
      return emptyInspection(params.raw);
    }
    const quotaToastValue = quotaToast[0]?.value;
    if (quotaToast.length !== 1 || quotaToastValue?.type !== "object") {
      return manualDisplayInspection(params.raw, params, "unsupported-structure");
    }

    target = quotaToastValue;
    targetPath.push("experimental", "quotaToast");
  }

  const legacyProperties = objectProperties(target, "opencodeZenDisplay");
  if (legacyProperties.length === 0) {
    return emptyInspection(params.raw);
  }
  if (legacyProperties.length !== 1) {
    return manualDisplayInspection(params.raw, params, "duplicate-key");
  }

  const accountingProperties = objectProperties(target, "accountingDetail");
  if (accountingProperties.length > 1) {
    return manualDisplayInspection(params.raw, params, "duplicate-key");
  }

  const rawLegacyValue: unknown = legacyProperties[0]?.value.value;
  if (rawLegacyValue !== "default" && rawLegacyValue !== "detailed") {
    return manualDisplayInspection(params.raw, params, "unsupported-legacy-value");
  }

  const legacyValue = rawLegacyValue;
  const mappedValue = LEGACY_DISPLAY_MAPPINGS[legacyValue];
  const currentAccounting = accountingProperties[0]?.value.value;
  if (
    accountingProperties.length === 1 &&
    currentAccounting !== "summary" &&
    currentAccounting !== "detailed"
  ) {
    return manualDisplayInspection(params.raw, params, "invalid-accounting-detail");
  }

  const accountingPath = [...targetPath, "accountingDetail"];
  const legacyPath = [...targetPath, "opencodeZenDisplay"];
  const edits: Array<{ path: string[]; value: unknown }> = [];
  let outcome: Extract<ScopedUpdateSafeAction, { kind: "accounting-detail-migration" }>["outcome"];

  if (accountingProperties.length === 0) {
    edits.push({ path: accountingPath, value: mappedValue });
    outcome = "set-and-remove-old";
  } else if (currentAccounting === mappedValue) {
    outcome = "remove-redundant-old";
  } else {
    outcome = "keep-current-and-remove-old";
  }
  edits.push({ path: legacyPath, value: undefined });

  const updated = editConfigDocumentPaths({
    raw: params.raw,
    format: params.format,
    path: params.path,
    edits,
  });

  return {
    updated,
    changed: updated !== params.raw,
    safeActions: [
      {
        kind: "accounting-detail-migration",
        path: params.path,
        container: params.container,
        from: legacyValue,
        to: mappedValue,
        outcome,
      },
    ],
    manualFindings: [],
  };
}

export function buildScopedUpdateMigrationCandidates(params: {
  globalRoots: readonly string[];
  workspaceRoot: string;
}): ScopedUpdateMigrationCandidate[] {
  return buildConfigLayerCandidates([...params.globalRoots], params.workspaceRoot).map(
    (candidate) => ({
      path: candidate.path,
      rootDir: candidate.rootDir,
      scope: candidate.scope,
      format: candidate.path.endsWith(".jsonc") ? "jsonc" : "json",
      container: candidate.kind === "plugin" ? "quota-root" : "experimental.quotaToast",
    }),
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolveScopedUpdateMigrationBoundary(params: {
  path: string;
  rootDir: string;
  expectedRealPath?: string;
  expectedRealRoot?: string;
  resolvedRealPath?: string;
  writePath?: string;
}): Promise<ScopedUpdateMigrationBoundary | null> {
  const relativeParent = relative(params.rootDir, dirname(params.path));
  if (relativeParent !== "" && !containedBy(params.rootDir, dirname(params.path))) {
    return null;
  }

  let currentParent = params.rootDir;
  for (const component of relativeParent === "" ? [] : relativeParent.split(sep)) {
    currentParent = join(currentParent, component);
    if ((await lstat(currentParent)).isSymbolicLink()) {
      return null;
    }
  }

  const [realRoot, realPath] = await Promise.all([
    realpath(params.rootDir),
    params.resolvedRealPath ?? realpath(params.path),
  ]);
  if (
    (params.expectedRealRoot !== undefined && realRoot !== params.expectedRealRoot) ||
    (params.expectedRealPath !== undefined && realPath !== params.expectedRealPath) ||
    !containedBy(realRoot, realPath) ||
    realPath === realRoot
  ) {
    return null;
  }

  if (params.writePath !== undefined && (await realpath(params.writePath)) !== realPath) {
    return null;
  }

  return { path: params.path, rootDir: params.rootDir, realPath, realRoot };
}

export async function discoverExistingScopedUpdateMigrationCandidates(params: {
  globalRoots: readonly string[];
  workspaceRoot: string;
  selectedPackagePaths?: readonly string[];
}): Promise<{
  candidates: DiscoveredScopedUpdateMigrationCandidate[];
  manualFindings: ScopedUpdateManualFinding[];
}> {
  const selectedPackagePaths = new Set(params.selectedPackagePaths ?? []);
  const candidates: DiscoveredScopedUpdateMigrationCandidate[] = [];
  const manualFindings: ScopedUpdateManualFinding[] = [];
  const seenRealPaths = new Set<string>();

  for (const candidate of buildScopedUpdateMigrationCandidates(params)) {
    let stats: Stats;
    try {
      stats = await lstat(candidate.path);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      throw new Error(`Unable to inspect update migration path: ${candidate.path}`);
    }

    if (stats.isSymbolicLink() && !selectedPackagePaths.has(candidate.path)) {
      manualFindings.push({
        kind: "migration-file-uninspectable",
        path: candidate.path,
        reason: "symlink",
      });
      continue;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) {
      throw new Error(`Unable to inspect update migration path: ${candidate.path}`);
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(candidate.path);
    } catch {
      throw new Error(`Unable to resolve update migration path: ${candidate.path}`);
    }
    if (seenRealPaths.has(canonicalPath)) {
      continue;
    }

    let boundary: ScopedUpdateMigrationBoundary | null;
    try {
      boundary = await resolveScopedUpdateMigrationBoundary({
        ...candidate,
        resolvedRealPath: canonicalPath,
      });
    } catch {
      throw new Error(`Unable to resolve update migration path: ${candidate.path}`);
    }
    if (boundary === null) {
      manualFindings.push({
        kind: "migration-file-uninspectable",
        path: candidate.path,
        reason: "symlink",
      });
      continue;
    }

    seenRealPaths.add(canonicalPath);
    candidates.push({ ...candidate, ...boundary });
  }

  return { candidates, manualFindings };
}

async function knownPathExists(path: string, action: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw new Error(`Unable to ${action}: ${path}`);
  }
}

export async function auditObsoleteUpdateSources(params: {
  env: NodeJS.ProcessEnv;
  configDirs: string[];
  primaryConfigDir: string;
}): Promise<ScopedUpdateManualFinding[]> {
  const findings: ScopedUpdateManualFinding[] = [];

  for (const name of OBSOLETE_GO_ENV_NAMES) {
    if (Object.hasOwn(params.env, name)) {
      findings.push({ kind: "obsolete-go-env", name });
    }
  }

  const configDirs = [...new Set(params.configDirs)];
  const goPaths = configDirs.map((dir) => join(dir, OBSOLETE_GO_FILE));
  const zenPaths = configDirs.map((dir) => join(dir, SUPPORTED_ZEN_FILE));
  const [goPresence, zenPresence] = await Promise.all([
    Promise.all(
      goPaths.map((path) => knownPathExists(path, "inspect obsolete OpenCode Go source")),
    ),
    Promise.all(
      zenPaths.map((path) => knownPathExists(path, "inspect supported OpenCode Zen source")),
    ),
  ]);

  for (let index = 0; index < goPaths.length; index++) {
    const path = goPaths[index];
    if (goPresence[index] && path) {
      findings.push({ kind: "obsolete-go-file", path });
    }
  }

  if (!zenPresence.some(Boolean)) {
    const names = AMBIGUOUS_ZEN_ENV_NAMES.filter((name) => Object.hasOwn(params.env, name));
    if (names.length > 0) {
      findings.push({
        kind: "ambiguous-zen-env",
        names: [...names],
        suggestedPath: join(params.primaryConfigDir, SUPPORTED_ZEN_FILE),
      });
    }
  }

  return findings;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeActionSortKey(action: ScopedUpdateSafeAction): string {
  if (action.kind === "package-spec") {
    return `${action.path}\u0000${action.kind}\u0000${action.replacements}`;
  }
  return `${action.path}\u0000${action.kind}\u0000${action.container}\u0000${action.from}\u0000${action.to}\u0000${action.outcome}`;
}

function manualFindingSortKey(finding: ScopedUpdateManualFinding): string {
  switch (finding.kind) {
    case "obsolete-go-env":
      return `${finding.kind}\u0000${finding.name}`;
    case "obsolete-go-file":
      return `${finding.kind}\u0000${finding.path}`;
    case "ambiguous-zen-env":
      return `${finding.kind}\u0000${finding.suggestedPath}\u0000${finding.names.join("\u0000")}`;
    case "display-migration-manual":
      return `${finding.kind}\u0000${finding.path}\u0000${finding.container}\u0000${finding.reason}`;
    case "migration-file-uninspectable":
      return `${finding.kind}\u0000${finding.path}\u0000${finding.reason}`;
  }
}

export function sortScopedUpdateSafeActions(
  actions: readonly ScopedUpdateSafeAction[],
): ScopedUpdateSafeAction[] {
  return [...actions].sort((left, right) =>
    compareText(safeActionSortKey(left), safeActionSortKey(right)),
  );
}

export function sortScopedUpdateManualFindings(
  findings: readonly ScopedUpdateManualFinding[],
): ScopedUpdateManualFinding[] {
  return [...findings].sort((left, right) =>
    compareText(manualFindingSortKey(left), manualFindingSortKey(right)),
  );
}
