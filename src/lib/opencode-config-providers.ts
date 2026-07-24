import { readFile } from "fs/promises";

import {
  dedupeNonEmptyStrings,
  extractPluginSpecsFromParsedConfig,
  extractProviderIdsFromParsedConfig,
  resolveEditableConfigPath,
  resolveExistingConfigPath,
  type ConfigFileFormat,
} from "./config-file-utils.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import {
  buildOpenCodeConfigCandidates,
  readOpenCodeConfigCandidate,
  selectFirstExistingOpenCodeConfigCandidate,
  type OpenCodeConfigCandidate,
} from "./opencode-config-read.js";
import {
  applyConfigDocumentEdit,
  ConfigDocumentError,
  parseConfigDocument,
  planConfigDocumentEdit,
} from "./opencode-config-editor.js";
import {
  getQuotaProviderRuntimeIds,
  getQuotaProviderShape,
  normalizeQuotaProviderId,
} from "./provider-metadata.js";

export interface LoadConfiguredProviderIdsOptions {
  configRootDir: string;
}

export interface ReconcileDetectedProviderConfigOptions {
  configRootDir: string;
  detectedProviderIds: readonly string[];
  preferredFormat?: ConfigFileFormat;
  writeText?: (path: string, content: string) => Promise<void>;
}

export interface ReconcileDetectedProviderConfigResult {
  path: string | null;
  format: ConfigFileFormat | null;
  addedProviderIds: string[];
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCandidates(configRootDir: string): OpenCodeConfigCandidate[] {
  return dedupeNonEmptyStrings([
    ...getOpencodeRuntimeDirCandidates().configDirs,
    configRootDir,
  ]).flatMap((directory) => {
    const selected = selectFirstExistingOpenCodeConfigCandidate(
      buildOpenCodeConfigCandidates({
        directories: [directory],
        formatOrder: ["jsonc", "json"],
      }),
    );
    return selected ? [selected] : [];
  });
}

async function readConfig(
  candidate: OpenCodeConfigCandidate,
): Promise<Record<string, unknown> | null> {
  const result = await readOpenCodeConfigCandidate(candidate);
  return result.state === "parsed" && isRecord(result.value) ? result.value : null;
}

const COMPANION_PLUGIN_PROVIDER_IDS: ReadonlyArray<{
  providerId: string;
  matches: readonly string[];
}> = [
  { providerId: "qwen-code", matches: ["opencode-qwencode-auth"] },
  { providerId: "google-antigravity", matches: ["opencode-antigravity-auth"] },
  { providerId: "google-gemini-cli", matches: ["opencode-gemini-auth"] },
  {
    providerId: "cursor",
    matches: [
      "@playwo/opencode-cursor-oauth",
      "opencode-cursor-oauth",
      "opencode-cursor",
      "open-cursor",
      "@rama_nigg/open-cursor",
    ],
  },
];

function mergeOpenCodeConfig(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base, ...next };

  if (isRecord(base.provider) || isRecord(next.provider)) {
    merged.provider = {
      ...(isRecord(base.provider) ? base.provider : {}),
      ...(isRecord(next.provider) ? next.provider : {}),
    };
  }

  if (Array.isArray(base.plugin) || Array.isArray(next.plugin)) {
    merged.plugin = [
      ...(Array.isArray(base.plugin) ? base.plugin : []),
      ...(Array.isArray(next.plugin) ? next.plugin : []),
    ];
  }

  return merged;
}

function inferProviderIdsFromPluginSpecs(specs: string[]): string[] {
  const normalizedSpecs = specs.map((spec) => spec.replace(/\\/g, "/").toLowerCase());
  return COMPANION_PLUGIN_PROVIDER_IDS.flatMap(({ providerId, matches }) =>
    normalizedSpecs.some((spec) => matches.some((match) => spec.includes(match)))
      ? [providerId]
      : [],
  );
}

export async function loadConfiguredOpenCodeConfig(
  options: LoadConfiguredProviderIdsOptions,
): Promise<Record<string, unknown>> {
  let config: Record<string, unknown> = {};

  for (const candidate of getCandidates(options.configRootDir)) {
    const parsed = await readConfig(candidate);
    if (!parsed) {
      continue;
    }
    config = mergeOpenCodeConfig(config, parsed);
  }

  return config;
}

export async function loadConfiguredProviderIds(
  options: LoadConfiguredProviderIdsOptions,
): Promise<string[]> {
  const config = await loadConfiguredOpenCodeConfig(options);
  return dedupeNonEmptyStrings([
    ...extractProviderIdsFromParsedConfig(config),
    ...inferProviderIdsFromPluginSpecs(extractPluginSpecsFromParsedConfig(config)),
  ]);
}

function isDetectedProviderDeclared(
  providerId: string,
  configuredProviderIds: Set<string>,
): boolean {
  const runtimeIds = getQuotaProviderRuntimeIds(providerId);
  return [providerId, ...runtimeIds].some((id) => configuredProviderIds.has(id));
}

/**
 * Adds providers proven available at runtime to the global OpenCode config only.
 * Project declarations participate in the read/precedence check but are never written.
 */
export async function reconcileDetectedProvidersInGlobalConfig(
  options: ReconcileDetectedProviderConfigOptions,
): Promise<ReconcileDetectedProviderConfigResult> {
  const detectedProviderIds = dedupeNonEmptyStrings(
    options.detectedProviderIds
      .map((providerId) => normalizeQuotaProviderId(providerId))
      .filter((providerId) => {
        const shape = getQuotaProviderShape(providerId);
        return Boolean(shape && shape.id !== "quota-providers");
      }),
  );
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  const globalConfigDir = configDirs[0];
  if (!globalConfigDir || detectedProviderIds.length === 0) {
    return { path: null, format: null, addedProviderIds: [], changed: false };
  }

  const effectiveConfig = await loadConfiguredOpenCodeConfig({
    configRootDir: options.configRootDir,
  });
  const configuredProviderIds = new Set(extractProviderIdsFromParsedConfig(effectiveConfig));
  const addedProviderIds = detectedProviderIds.filter(
    (providerId) => !isDetectedProviderDeclared(providerId, configuredProviderIds),
  );

  const projectPath = resolveExistingConfigPath(options.configRootDir, "opencode");
  const projectFormat: ConfigFileFormat | undefined = projectPath
    ? projectPath.endsWith(".jsonc")
      ? "jsonc"
      : "json"
    : undefined;
  const target = resolveEditableConfigPath({
    dir: globalConfigDir,
    kind: "opencode",
    preferredFormat: options.preferredFormat ?? projectFormat,
    convertJsonToJsonc: false,
  });

  if (addedProviderIds.length === 0) {
    return { path: target.path, format: target.format, addedProviderIds, changed: false };
  }

  const raw = target.existed ? await readFile(target.sourcePath, "utf8") : "{}\n";
  const sourceFormat: ConfigFileFormat = target.sourcePath.endsWith(".jsonc") ? "jsonc" : "json";
  const root = parseConfigDocument(raw, sourceFormat, target.sourcePath);
  if (root.provider !== undefined && !isRecord(root.provider)) {
    throw new ConfigDocumentError(
      `Cannot add detected providers because provider is not an object: ${target.sourcePath}`,
      target.sourcePath,
    );
  }
  const provider = isRecord(root.provider) ? { ...root.provider } : {};
  for (const providerId of addedProviderIds) {
    provider[providerId] = {};
  }

  const edit = await planConfigDocumentEdit({
    target,
    desiredData: { ...root, provider },
    managedComments: addedProviderIds.map((providerId) => ({
      path: ["provider", providerId],
      text: `// Detected ${providerId} authentication; opencode-quota added this global provider declaration.`,
    })),
  });
  await applyConfigDocumentEdit(edit, { writeText: options.writeText });

  return {
    path: target.path,
    format: target.format,
    addedProviderIds,
    changed: edit.changed,
  };
}
