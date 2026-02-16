/**
 * OpenCode auth.json reader
 *
 * Shared helper to read auth from ~/.local/share/opencode/auth.json
 * (or platform equivalent). Providers should prefer this to duplicating
 * file/path parsing.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates, getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";

import type { AuthData } from "./types.js";

/**
 * Get candidate auth.json paths in priority order.
 * Some OpenCode installations use Linux-style paths even on macOS,
 * so we check multiple locations.
 */
export function getAuthPaths(): string[] {
  // OpenCode stores auth at `${Global.Path.data}/auth.json`.
  // We generate candidates based on OpenCode runtime dir semantics (xdg-basedir)
  // plus platform fallbacks for alternate/legacy installs.
  const { dataDirs } = getOpencodeRuntimeDirCandidates();
  return dataDirs.map((d) => join(d, "auth.json"));
}

/** Returns OpenCode's primary auth.json path (for display/logging) */
export function getAuthPath(): string {
  return join(getOpencodeRuntimeDirs().dataDir, "auth.json");
}

export async function readAuthFile(): Promise<AuthData | null> {
  const paths = getAuthPaths();

  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as AuthData;
    } catch {
      // Try next path
    }
  }

  return null;
}
