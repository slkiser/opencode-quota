/**
 * Reads the Codex CLI's own local rollout traces
 * (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, default `~/.codex`),
 * independent of OpenCode, and maps per-response token usage into the same
 * `OpenCodeMessage` shape the aggregation pipeline (`quota-stats.ts`) uses.
 *
 * Rollouts carry usage in two forms, often side by side:
 *
 * - `token_usage_record` lines: one per model response, keyed by
 *   `response_id`, with that response's own `usage`. Summing these equals the
 *   thread's final cumulative `thread_token_usage`, so they are authoritative.
 * - Older `event_msg` / `token_count` lines: `last_token_usage` plus a
 *   cumulative `total_token_usage`. These can repeat with an unchanged total
 *   and can miss responses, so summing `last_token_usage` double counts.
 *
 * A file with any `token_usage_record` uses only those. Otherwise each
 * `token_count` contributes the increase in its cumulative total, so repeated
 * events add nothing and missed events are still covered by the next total.
 *
 * Codex reports cached/cache-write input as part of `input_tokens` and
 * reasoning as part of `output_tokens`. Token buckets are exclusive and priced
 * separately, so those subsets are moved out of input/output here.
 */

import { homedir } from "os";
import { join } from "path";
import { readdir, readFile, stat } from "fs/promises";

import type { OpenCodeMessage } from "./opencode-storage.js";

export function getCodexCliSessionsDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome ? codexHome : join(homedir(), ".codex"), "sessions");
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexRolloutEntry {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    model?: string;
    model_provider?: string;
    turn_id?: string;
    thread_id?: string;
    response_id?: string;
    usage?: CodexUsage;
    info?: {
      last_token_usage?: CodexUsage;
      total_token_usage?: CodexUsage;
    } | null;
  };
}

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function subtractUsage(current: CodexUsage, previous: CodexUsage | undefined): CodexUsage {
  const delta: CodexUsage = {};
  for (const key of USAGE_KEYS) {
    delta[key] = Math.max(0, count(current[key]) - count(previous?.[key]));
  }
  return delta;
}

function toTokens(usage: CodexUsage): OpenCodeMessage["tokens"] {
  const cacheRead = count(usage.cached_input_tokens);
  const cacheWrite = count(usage.cache_write_input_tokens);
  const reasoning = count(usage.reasoning_output_tokens);
  return {
    input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
    output: Math.max(0, count(usage.output_tokens) - reasoning),
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

function totalTokens(tokens: OpenCodeMessage["tokens"]): number {
  return (
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)
  );
}

async function listJsonlFiles(dir: string, strictReads = false): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (strictReads && code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(path, strictReads)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files.sort();
}

function parseRollout(raw: string, strictReads: boolean): CodexRolloutEntry[] {
  const entries: CodexRolloutEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (error) {
      if (strictReads) throw error;
    }
  }
  return entries;
}

function rolloutMessages(entries: CodexRolloutEntry[]): OpenCodeMessage[] {
  const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
  const sessionID = typeof meta?.id === "string" && meta.id ? meta.id : undefined;
  if (!sessionID) return [];
  const providerID = meta?.model_provider || "openai";

  const useRecords = entries.some((entry) => entry.type === "token_usage_record");
  const modelByTurn = new Map<string, string>();
  let currentModel: string | undefined;
  let previousTotal: CodexUsage | undefined;
  const messages: OpenCodeMessage[] = [];

  for (const entry of entries) {
    const payload = entry.payload;
    if (!payload) continue;

    if (entry.type === "turn_context") {
      if (typeof payload.model === "string" && payload.model) {
        currentModel = payload.model;
        if (payload.turn_id) modelByTurn.set(payload.turn_id, payload.model);
      }
      continue;
    }

    let id: string;
    let usage: CodexUsage;
    let modelID = currentModel;
    if (useRecords) {
      if (entry.type !== "token_usage_record" || !payload.usage || !payload.response_id) continue;
      // Records from another thread (if ever interleaved) belong to that thread's own rollout.
      if (payload.thread_id && payload.thread_id !== sessionID) continue;
      id = `codex:${payload.response_id}`;
      usage = payload.usage;
      if (payload.turn_id) modelID = modelByTurn.get(payload.turn_id) ?? modelID;
    } else {
      if (entry.type !== "event_msg" || payload.type !== "token_count") continue;
      const total = payload.info?.total_token_usage;
      if (!total) continue;
      const cumulative = count(total.total_tokens);
      const previous = count(previousTotal?.total_tokens);
      if (cumulative <= previous) {
        // Repeated event (no new usage) or a reset; only a reset carries new usage.
        if (cumulative === previous || !payload.info?.last_token_usage) continue;
        usage = payload.info.last_token_usage;
      } else {
        usage = subtractUsage(total, previousTotal);
      }
      previousTotal = total;
      id = `codex:${sessionID}:${cumulative}`;
    }

    const tokens = toTokens(usage);
    if (totalTokens(tokens) === 0) continue;
    const createdMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    messages.push({
      id,
      sessionID,
      role: "assistant",
      providerID,
      modelID,
      tokens,
      time: Number.isFinite(createdMs) ? { created: createdMs } : undefined,
    });
  }
  return messages;
}

/**
 * Reads per-response token usage from Codex CLI's own local rollouts.
 * Returns `[]` (never throws unless `strictReads`) when Codex has never been
 * run on this machine. Messages are deduplicated by response identity, so a
 * rollout copied into a resumed session is not counted twice.
 */
export async function iterCodexCliMessages(params: {
  sinceMs?: number;
  untilMs?: number;
  sessionsDir?: string;
  strictReads?: boolean;
}): Promise<OpenCodeMessage[]> {
  const sessionsDir = params.sessionsDir ?? getCodexCliSessionsDir();
  const strictReads = params.strictReads ?? false;
  const files = await listJsonlFiles(sessionsDir, strictReads);
  const seen = new Set<string>();
  const messages: OpenCodeMessage[] = [];

  for (const file of files) {
    // An append-only rollout's mtime is its newest entry's time.
    if (params.sinceMs != null) {
      try {
        if ((await stat(file)).mtimeMs < params.sinceMs) continue;
      } catch (error) {
        if (strictReads) throw error;
        continue;
      }
    }

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (strictReads) throw error;
      continue;
    }

    for (const message of rolloutMessages(parseRollout(raw, strictReads))) {
      const createdMs = message.time?.created;
      if (params.sinceMs != null && (createdMs == null || createdMs < params.sinceMs)) continue;
      if (params.untilMs != null && createdMs != null && createdMs > params.untilMs) continue;
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }

  return messages;
}
