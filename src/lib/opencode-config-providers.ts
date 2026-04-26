import { readFile } from "fs/promises";

import {
  dedupeNonEmptyStrings,
  extractPluginSpecsFromParsedConfig,
  extractProviderIdsFromParsedConfig,
  getConfigFileCandidatePaths,
} from "./config-file-utils.js";
import { parseJsonOrJsonc } from "./jsonc.js";
import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface LoadConfiguredProviderIdsOptions {
  configRootDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCandidatePaths(configRootDir: string): string[] {
  return dedupeNonEmptyStrings([
    ...getOpencodeRuntimeDirCandidates().configDirs.flatMap((dir) =>
      getConfigFileCandidatePaths(dir, "opencode"),
    ),
    ...getConfigFileCandidatePaths(configRootDir, "opencode"),
  ]);
}

async function readConfig(path: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await readFile(path, "utf8");
    const parsed = parseJsonOrJsonc(content, path.endsWith(".jsonc"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

  for (const path of getCandidatePaths(options.configRootDir)) {
    const parsed = await readConfig(path);
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
