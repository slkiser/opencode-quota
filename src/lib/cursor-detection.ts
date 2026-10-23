import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { getPluginSpecFromEntry } from "./config-file-utils.js";
import { asRecord, isRecord } from "./json-guards.js";
import { getCredentialDatabasePaths, readCredentialRows } from "./opencode-auth.js";
import { existingOpenCodeConfigFiles, readOpenCodeConfigs } from "./opencode-config-files.js";
import { getQuotaProviderRuntimeIds } from "./provider-metadata.js";

interface CursorAuthPresence {
  state: "missing" | "present" | "invalid";
  selectedPath?: string;
  presentPaths: string[];
  candidatePaths: string[];
  error?: string;
}

interface CursorOpenCodeIntegration {
  pluginEnabled: boolean;
  providerConfigured: boolean;
  matchedPaths: string[];
  checkedPaths: string[];
}

export const CURSOR_CANONICAL_PLUGIN_PACKAGE = "cursor-opencode-provider";
/**
 * `cursor-opencode-provider` specs: the bare package (OpenCode 2 resolves its `./server`
 * export), its OpenCode 2 entry `/plugin/opencode2`, or `/server`, each optionally
 * version-pinned on the package or the entry, e.g. `cursor-opencode-provider@0.7.3/plugin/opencode2`.
 */
const CURSOR_PLUGIN_SPEC_PATTERN =
  /^cursor-opencode-provider(@[^/]+)?(\/plugin\/opencode2|\/server)?(@[^/]+)?$/;
const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

function dedupe(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function getCursorAuthCandidatePaths(): string[] {
  const home = process.env.CURSOR_ACP_HOME_DIR?.trim() || homedir();
  const dirs: string[] = [];
  if (platform() === "darwin") {
    dirs.push(join(home, ".cursor"), join(home, ".config", "cursor"));
  } else {
    dirs.push(join(home, ".config", "cursor"));
    const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
    if (xdgConfigHome && xdgConfigHome !== join(home, ".config")) {
      dirs.push(join(xdgConfigHome, "cursor"));
    }
    dirs.push(join(home, ".cursor"));
  }
  return dedupe(dirs.flatMap((dir) => [join(dir, "cli-config.json"), join(dir, "auth.json")]));
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** OpenCode 2 stores Cursor OAuth tokens as `oauth`, and an API key `key` credential that our reader maps to `api`. */
function isValidCursorCredential(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "oauth") {
    return hasNonEmptyString(value.refresh) || hasNonEmptyString(value.access);
  }
  return value.type === "api" && hasNonEmptyString(value.key);
}

export async function inspectCursorAuthPresence(): Promise<CursorAuthPresence> {
  const credentialDatabasePaths = getCredentialDatabasePaths();
  const legacyCandidatePaths = getCursorAuthCandidatePaths();
  const candidatePaths = dedupe([...credentialDatabasePaths, ...legacyCandidatePaths]);
  const presentPaths = candidatePaths.filter((path) => existsSync(path));
  const credentialDatabasePath = credentialDatabasePaths.find((path) => existsSync(path));
  const present = (selectedPath: string | undefined): CursorAuthPresence => ({
    state: "present",
    selectedPath,
    presentPaths,
    candidatePaths,
  });
  let invalidPath: string | undefined;
  let invalidError: string | undefined;

  const [cursorLogin] = await readCredentialRows(["cursor"], { firstOnly: true });
  if (cursorLogin) {
    if (cursorLogin.resolveError === undefined && isValidCursorCredential(cursorLogin.value)) {
      return present(credentialDatabasePath);
    }

    invalidPath = credentialDatabasePath;
    invalidError =
      cursorLogin.resolveError !== undefined
        ? `OpenCode could not read this login: ${cursorLogin.resolveError}`
        : "Cursor credential in the OpenCode database is missing a valid OAuth token or API key";
  }

  if (hasNonEmptyString(process.env[CURSOR_API_KEY_ENV])) {
    return present(`env:${CURSOR_API_KEY_ENV}`);
  }

  for (const path of legacyCandidatePaths) {
    if (!existsSync(path)) continue;

    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      if (parsed && typeof parsed === "object") return present(path);
    } catch (error) {
      invalidPath ??= path;
      invalidError ??= error instanceof Error ? error.message : String(error);
    }
  }

  if (invalidPath) {
    return {
      state: "invalid",
      selectedPath: invalidPath,
      presentPaths,
      candidatePaths,
      error: invalidError,
    };
  }

  return { state: "missing", presentPaths, candidatePaths };
}

/** OpenCode 2 reads both the legacy `plugin`/`provider` keys and the native `plugins`/`providers` keys. */
function inspectOpenCodeConfig(parsed: Record<string, unknown>): {
  matchedPlugin: boolean;
  matchedProvider: boolean;
} {
  const pluginSpecs: unknown[] = [
    ...(Array.isArray(parsed.plugin) ? parsed.plugin : []),
    ...(Array.isArray(parsed.plugins) ? parsed.plugins.map(getPluginSpecFromEntry) : []),
  ];
  const cursorRuntimeIds = getQuotaProviderRuntimeIds("cursor");
  return {
    matchedPlugin: pluginSpecs.some(
      (spec) =>
        typeof spec === "string" && CURSOR_PLUGIN_SPEC_PATTERN.test(spec.trim().toLowerCase()),
    ),
    matchedProvider: [parsed.provider, parsed.providers].some((value) => {
      const providers = asRecord(value);
      return providers !== null && cursorRuntimeIds.some((id) => Object.hasOwn(providers, id));
    }),
  };
}

/**
 * Whether an OpenCode config file that counts for a session in `directory` loads Cursor's
 * plugin or declares its provider. Files that do not parse are left out.
 */
export async function inspectCursorOpenCodeIntegration(
  directory: string,
): Promise<CursorOpenCodeIntegration> {
  const checkedPaths = existingOpenCodeConfigFiles(directory);
  const matchedPaths: string[] = [];
  let pluginEnabled = false;
  let providerConfigured = false;

  for (const { path, config } of await readOpenCodeConfigs(directory)) {
    const { matchedPlugin, matchedProvider } = inspectOpenCodeConfig(config);
    if (matchedPlugin || matchedProvider) {
      matchedPaths.push(path);
    }
    pluginEnabled ||= matchedPlugin;
    providerConfigured ||= matchedProvider;
  }

  return { pluginEnabled, providerConfigured, matchedPaths, checkedPaths };
}
