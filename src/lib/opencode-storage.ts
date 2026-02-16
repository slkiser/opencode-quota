import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";
import { pickFirstExistingPath } from "./path-pick.js";

/**
 * Error thrown when a session directory is not found.
 *
 * This is thrown by iterAssistantMessagesForSession when the session
 * directory doesn't exist. Callers should catch this to handle gracefully.
 */
export class SessionNotFoundError extends Error {
  constructor(
    public readonly sessionID: string,
    public readonly checkedPath: string,
  ) {
    super(`Session directory not found: ${sessionID}`);
    this.name = "SessionNotFoundError";
  }
}

export interface OpenCodeTokenCache {
  read: number;
  write: number;
}

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache: OpenCodeTokenCache;
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  providerID?: string;
  modelID?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  time?: {
    created?: number;
    completed?: number;
  };
  agent?: string;
  mode?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  parentID?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export function getOpenCodeDataDirCandidates(): string[] {
  // OpenCode stores data under `${Global.Path.data}` which is `join(xdgData, "opencode")`.
  // We return candidate opencode data dirs in priority order.
  return getOpencodeRuntimeDirCandidates().dataDirs;
}

export function getOpenCodeDataDir(): string {
  return pickFirstExistingPath(getOpenCodeDataDirCandidates());
}

export function getOpenCodeStorageDirCandidates(): string[] {
  return getOpenCodeDataDirCandidates().map((d) => join(d, "storage"));
}

export function getOpenCodeStorageDir(): string {
  return pickFirstExistingPath(getOpenCodeStorageDirCandidates());
}

export function getOpenCodeMessageDirCandidates(): string[] {
  return getOpenCodeStorageDirCandidates().map((d) => join(d, "message"));
}

export function getOpenCodeMessageDir(): string {
  return pickFirstExistingPath(getOpenCodeMessageDirCandidates());
}

export function getOpenCodeSessionDirCandidates(): string[] {
  return getOpenCodeStorageDirCandidates().map((d) => join(d, "session"));
}

export function getOpenCodeSessionDir(): string {
  return pickFirstExistingPath(getOpenCodeSessionDirCandidates());
}

async function safeReadJson(path: string): Promise<any | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as any;
  } catch {
    return null;
  }
}

export async function listSessionIDsFromMessageStorage(): Promise<string[]> {
  const base = getOpenCodeMessageDir();
  if (!existsSync(base)) return [];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith("ses_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function iterAssistantMessages(params: {
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const base = getOpenCodeMessageDir();
  if (!existsSync(base)) return [];

  const sessionIDs = await listSessionIDsFromMessageStorage();
  const out: OpenCodeMessage[] = [];

  for (const sessionID of sessionIDs) {
    const dir = join(base, sessionID);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }

    for (const f of files) {
      const p = join(dir, f);
      const msg = (await safeReadJson(p)) as OpenCodeMessage | null;
      if (!msg) continue;
      if (msg.role !== "assistant") continue;
      const created = msg.time?.created;
      if (typeof created !== "number") continue;
      if (typeof params.sinceMs === "number" && created < params.sinceMs) continue;
      if (typeof params.untilMs === "number" && created > params.untilMs) continue;
      out.push(msg);
    }
  }

  out.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return out;
}

/**
 * Read assistant messages for a specific session only.
 *
 * This is more efficient than iterAssistantMessages when you only need
 * messages from a single session, as it only reads that session's directory.
 *
 * @param params.sessionID - Session ID (must start with "ses_")
 * @param params.sinceMs - Optional: only messages created after this timestamp
 * @param params.untilMs - Optional: only messages created before this timestamp
 * @throws SessionNotFoundError if the session directory doesn't exist
 */
export async function iterAssistantMessagesForSession(params: {
  sessionID: string;
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const { sessionID, sinceMs, untilMs } = params;

  // Validate session ID format
  if (!sessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(sessionID, "(invalid session ID format)");
  }

  const base = getOpenCodeMessageDir();
  const sessionDir = join(base, sessionID);

  // Check if session directory exists
  if (!existsSync(sessionDir)) {
    throw new SessionNotFoundError(sessionID, sessionDir);
  }

  // Read messages from this session only
  let files: string[];
  try {
    files = (await readdir(sessionDir)).filter((f) => f.endsWith(".json"));
  } catch {
    throw new SessionNotFoundError(sessionID, sessionDir);
  }

  const out: OpenCodeMessage[] = [];

  for (const f of files) {
    const p = join(sessionDir, f);
    const msg = (await safeReadJson(p)) as OpenCodeMessage | null;
    if (!msg) continue;
    if (msg.role !== "assistant") continue;
    const created = msg.time?.created;
    if (typeof created !== "number") continue;
    if (typeof sinceMs === "number" && created < sinceMs) continue;
    if (typeof untilMs === "number" && created > untilMs) continue;
    out.push(msg);
  }

  out.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
  return out;
}

export async function readAllSessionsIndex(): Promise<Record<string, OpenCodeSessionInfo>> {
  const base = getOpenCodeSessionDir();
  const idx: Record<string, OpenCodeSessionInfo> = {};
  if (!existsSync(base)) return idx;

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await visit(p);
      } else if (e.isFile() && e.name.startsWith("ses_") && e.name.endsWith(".json")) {
        const data = await safeReadJson(p);
        if (!data || typeof data !== "object") continue;
        const id = data.id;
        if (typeof id !== "string" || !id.startsWith("ses_")) continue;
        idx[id] = {
          id,
          title: typeof data.title === "string" ? data.title : undefined,
          parentID: typeof data.parentID === "string" ? data.parentID : undefined,
          time: {
            created: typeof data.time?.created === "number" ? data.time.created : undefined,
            updated: typeof data.time?.updated === "number" ? data.time.updated : undefined,
          },
        };
      }
    }
  }

  await visit(base);
  return idx;
}
