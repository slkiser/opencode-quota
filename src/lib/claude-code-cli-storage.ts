/**
 * Reads the standalone Claude Code CLI's own local session transcripts
 * (`~/.claude/projects/<project>/<session>.jsonl`), independent of OpenCode.
 *
 * OpenCode's own usage tracking (`opencode-storage.ts`) only sees messages
 * sent through OpenCode's own chat sessions. A user running the `claude` CLI
 * directly (outside OpenCode) leaves no trace there, so the token/usage tab
 * never shows Claude Code's own models or token counts. This module fills
 * that gap by parsing the CLI's own transcripts, which already carry
 * `message.model` and `message.usage` per assistant turn, and mapping them
 * into the same `OpenCodeMessage` shape the rest of the aggregation pipeline
 * (`quota-stats.ts`) already understands.
 *
 * Subagent work is written to `<project>/<session>/subagents/*.jsonl`, with
 * `isSidechain: true` and the parent's `sessionId`; those files are read too.
 *
 * A response with several content blocks is written as several lines that
 * share `message.id`, each repeating the response's usage. Legacy (non-event)
 * reads keep one message per `message.id`, using the last line, which carries
 * the final usage; summing every line would count the response repeatedly.
 */

import { homedir } from "os";
import { join, basename } from "path";
import { readdir, readFile, stat } from "fs/promises";

import type { OpenCodeMessage } from "./opencode-storage.js";

export function getClaudeCodeCliProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

interface ClaudeCliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeCliTranscriptEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    stop_reason?: string | null;
    model?: string;
    usage?: ClaudeCliUsage;
  };
}

async function listJsonlFiles(projectsDir: string, strictReads = false): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch (error) {
    if (strictReads && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }

  const files: string[] = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
      if (strictReads) throw error;
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(join(projectPath, entry.name));
      } else if (entry.isDirectory()) {
        files.push(...(await listSubagentFiles(join(projectPath, entry.name), strictReads)));
      }
    }
  }
  return files;
}

async function listSubagentFiles(sessionDir: string, strictReads: boolean): Promise<string[]> {
  const dir = join(sessionDir, "subagents");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (strictReads && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(dir, entry.name));
}

function toOpenCodeMessage(
  entry: ClaudeCliTranscriptEntry,
  fallbackSessionID: string,
  lineIndex: number,
  completionEvents = false,
): OpenCodeMessage | null {
  if (entry.type !== "assistant" || !entry.message?.usage) return null;

  const usage = entry.message.usage;

  // Claude Code CLI injects synthetic notices (e.g. rate-limit/session-limit
  // banners) as assistant turns with model "<synthetic>" and all-zero usage -
  // not a real model call, so skip rather than showing a phantom model row.
  const totalTokens =
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  if (completionEvents ? entry.message.model === "<synthetic>" : totalTokens === 0) return null;

  const createdMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const terminal = [
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ].includes(entry.message.stop_reason ?? "");
  const providerIdentity =
    typeof entry.message.id === "string" &&
    entry.message.id.length > 0 &&
    entry.message.id.length <= 512
      ? entry.message.id
      : undefined;
  const uuid =
    typeof entry.uuid === "string" && entry.uuid.length > 0 && entry.uuid.length <= 512
      ? entry.uuid
      : undefined;
  if (
    completionEvents &&
    (!Number.isFinite(createdMs) || (!providerIdentity && !(terminal && uuid)))
  )
    throw new Error("Claude usage completion identity/time unavailable");
  const sessionID = entry.sessionId ?? fallbackSessionID;
  const subagent = entry.isSidechain === true;
  return {
    id: completionEvents
      ? (providerIdentity ?? uuid!)
      : (entry.uuid ?? `claude-cli:${fallbackSessionID}:${lineIndex}`),
    ...(completionEvents
      ? {
          usageComplete:
            Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens) && terminal,
        }
      : {}),
    sessionID,
    role: "assistant",
    providerID: "anthropic",
    modelID: entry.message.model,
    tokens: {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cache: {
        read: usage.cache_read_input_tokens ?? 0,
        write: usage.cache_creation_input_tokens ?? 0,
      },
    },
    time: Number.isFinite(createdMs) ? { created: createdMs } : undefined,
    ...(typeof entry.cwd === "string" && entry.cwd ? { directory: entry.cwd } : {}),
    subagent,
    ...(subagent ? { parentSessionID: sessionID } : {}),
  };
}

function completionKey(entry: ClaudeCliTranscriptEntry, message: OpenCodeMessage): string {
  const id = entry.message?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 512 ? `id:${id}` : message.id;
}

/**
 * Reads assistant-turn token usage from Claude Code CLI's own local
 * transcripts. Returns `[]` (never throws) when the CLI has never been run
 * on this machine - the directory simply won't exist.
 */
export async function iterClaudeCodeCliMessages(params: {
  sinceMs?: number;
  untilMs?: number;
  projectsDir?: string;
  strictReads?: boolean;
  completionEvents?: boolean;
}): Promise<OpenCodeMessage[]> {
  const projectsDir = params.projectsDir ?? getClaudeCodeCliProjectsDir();
  const files = await listJsonlFiles(projectsDir, params.strictReads);
  const messages: OpenCodeMessage[] = [];
  // Legacy reads: one message per response, the last line winning (see file comment).
  const responses = new Map<string, OpenCodeMessage>();

  for (const file of files) {
    // Cheap prune: an append-only transcript's mtime is its newest entry's
    // time, so a file untouched since before the window can't contain any
    // entry within it.
    if (params.sinceMs != null) {
      try {
        const stats = await stat(file);
        if (stats.mtimeMs < params.sinceMs) continue;
      } catch (error) {
        if (params.strictReads) throw error;
        continue;
      }
    }

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (params.strictReads) throw error;
      continue;
    }

    const fallbackSessionID = basename(file, ".jsonl");
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;

      let entry: ClaudeCliTranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        if (params.strictReads) throw error;
        continue;
      }

      if (params.completionEvents && entry.type === "assistant") {
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (
          Number.isFinite(at) &&
          ((params.sinceMs !== undefined && at < params.sinceMs) ||
            (params.untilMs !== undefined && at > params.untilMs))
        )
          continue;
      }
      const message = toOpenCodeMessage(entry, fallbackSessionID, i, params.completionEvents);
      if (!message) continue;

      const createdMs = message.time?.created;
      if (params.sinceMs != null && (createdMs == null || createdMs < params.sinceMs)) continue;
      if (params.untilMs != null && createdMs != null && createdMs > params.untilMs) continue;

      if (params.completionEvents) {
        messages.push(message);
      } else {
        const key = completionKey(entry, message);
        // Re-insert so a response sorts where its final line was written.
        responses.delete(key);
        responses.set(key, message);
      }
    }
  }

  return params.completionEvents ? messages : [...responses.values()];
}
