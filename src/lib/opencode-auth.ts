/**
 * OpenCode auth.json reader
 *
 * Shared helper to read auth from ~/.local/share/opencode/auth.json
 * (or platform equivalent). Providers should prefer this to duplicating
 * file/path parsing.
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import type { AuthData } from "./types.js";

/**
 * Get candidate auth.json paths in priority order.
 * Some OpenCode installations use Linux-style paths even on macOS,
 * so we check multiple locations.
 */
export function getAuthPaths(): string[] {
  const home = homedir();

  if (process.platform === "win32") {
    const dataDir = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [join(dataDir, "opencode", "auth.json")];
  }

  if (process.platform === "darwin") {
    // Check both macOS standard and Linux-style paths
    return [
      join(home, "Library", "Application Support", "opencode", "auth.json"),
      join(home, ".local", "share", "opencode", "auth.json"),
    ];
  }

  // Linux
  return [join(home, ".local", "share", "opencode", "auth.json")];
}

/** Returns the first candidate path (for display/logging purposes) */
export function getAuthPath(): string {
  return getAuthPaths()[0];
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
