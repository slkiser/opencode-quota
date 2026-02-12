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

export function getAuthPath(): string {
  const home = homedir();
  const dataDir =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(home, "AppData", "Local")
      : process.platform === "darwin"
        ? join(home, "Library", "Application Support")
        : join(home, ".local", "share");
  return join(dataDir, "opencode", "auth.json");
}

export async function readAuthFile(): Promise<AuthData | null> {
  try {
    const content = await readFile(getAuthPath(), "utf-8");
    return JSON.parse(content) as AuthData;
  } catch {
    return null;
  }
}
