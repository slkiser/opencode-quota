/**
 * OpenCode's folders for a test file: the XDG variables point below one temp folder, so the
 * plugin finds them by its own rules (`getOpencodeRuntimeDirs`), never this machine's real
 * ones. Call `useOpencodeFolders()` once per test file, before any test runs.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterAll, afterEach, beforeEach } from "vite-plus/test";

import {
  getOpencodeRuntimeDirs,
  type OpencodeRuntimeDirs,
} from "../../src/lib/opencode-runtime-paths.js";

/**
 * A session folder for which no OpenCode project config counts: the file system root, so only
 * the global config folder (and nothing of this machine's projects) is read.
 */
export const NO_PROJECT_DIRECTORY = parse(tmpdir()).root;

export type OpencodeFolders = OpencodeRuntimeDirs & {
  /** The temp folder that holds them; a test may put other files here too. */
  readonly root: string;
};

const XDG_HOMES = {
  XDG_DATA_HOME: "data",
  XDG_CONFIG_HOME: "config",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
} as const;

function pointAt(root: string): void {
  for (const [name, folder] of Object.entries(XDG_HOMES)) process.env[name] = join(root, folder);
  delete process.env.OPENCODE_CONFIG_DIR;
}

/** OpenCode's folders below one temp folder, empty at the start of each test. */
export function useOpencodeFolders(): OpencodeFolders {
  const root = mkdtempSync(join(tmpdir(), "opencode-quota-folders-"));
  pointAt(root);
  const folders: OpencodeFolders = { root, ...getOpencodeRuntimeDirs() };

  // Again before each test: a test may have changed the variables.
  beforeEach(() => pointAt(root));
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    mkdirSync(root);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

  return folders;
}
