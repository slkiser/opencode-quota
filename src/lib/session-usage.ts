/**
 * Per-session usage report across Claude Code, OpenCode and Codex (UA-TW-03).
 *
 * Reads each source's native store, folds subagent responses into the root
 * session that spawned them, and summarises sessions, weekly trends and
 * session-length buckets. Everything is local and deterministic: no network,
 * no model calls, and no conversation text or session titles in the output.
 *
 * Missing values stay `null` (never zero): a session with no input-side
 * tokens has no cache-read share, an unpriced model has no cost, and a source
 * whose store could not be read is reported as unavailable rather than empty.
 */

import { existsSync } from "fs";

import {
  getOpenCodeDbPath,
  iterAssistantMessages,
  readAllSessionsIndex,
  type OpenCodeMessage,
  type OpenCodeSessionInfo,
} from "./opencode-storage.js";
import {
  getClaudeCodeCliProjectsDir,
  iterClaudeCodeCliMessages,
} from "./claude-code-cli-storage.js";
import { getCodexCliSessionsDir, iterCodexCliMessages } from "./codex-cli-storage.js";
import { priceTokensUsd } from "./quota-stats.js";
import {
  addTokenBuckets,
  emptyTokenBuckets,
  tokenBucketsFromMessage,
  totalTokenBuckets,
  type TokenBuckets,
} from "./token-buckets.js";

export type SessionUsageSource = "claude-code" | "opencode" | "codex";

export const SESSION_USAGE_SOURCES: readonly SessionUsageSource[] = [
  "claude-code",
  "opencode",
  "codex",
];

export type SourceCoverage = {
  source: SessionUsageSource;
  /** `read`: store found and read; `not-found`: no store on this machine; `unavailable`: read failed. */
  status: "read" | "not-found" | "unavailable";
  reason?: string;
  sessions: number;
  responses: number;
  /** Responses with no timestamp; counted in sessions but not in weekly trends. */
  undatedResponses: number;
  /** Whether this source marks subagent responses at all. */
  marksSubagents: boolean;
};

export type ModelShare = { model: string; responses: number; totalTokens: number };

export type SessionUsageRow = {
  source: SessionUsageSource;
  sessionID: string;
  /** Working directory, when the source records it. */
  directory: string | null;
  startMs: number | null;
  endMs: number | null;
  /** Minutes between the first and last response in the window; null without two timestamps. */
  activeMinutes: number | null;
  responses: number;
  subagentResponses: number;
  models: ModelShare[];
  tokens: TokenBuckets;
  totalTokens: number;
  subagentTokens: number;
  /** cache_read / (input + cache_read + cache_write); null when that is 0. */
  cacheReadShare: number | null;
  tokensPerResponse: number | null;
  /** Cost of the priced responses; null when none could be priced. */
  costUsd: number | null;
  /** Tokens from responses with no known price. */
  unpricedTokens: number;
  /** Share of tokens with a known price; cost covers only this share. Null with no tokens. */
  pricedShare: number | null;
};

export type UsageSummary = {
  sessions: number;
  responses: number;
  totalTokens: number;
  cacheReadShare: number | null;
  tokensPerResponse: number | null;
  /** Subagent share of tokens; null when no included source marks subagents. */
  subagentShare: number | null;
  costUsd: number | null;
  unpricedTokens: number;
  /** Share of tokens with a known price; cost covers only this share. Null with no tokens. */
  pricedShare: number | null;
};

export type WeeklyUsageRow = UsageSummary & {
  /** Monday 00:00 UTC, as YYYY-MM-DD. */
  weekStart: string;
  source: SessionUsageSource | "all";
};

export type LengthBucketRow = UsageSummary & {
  bucket: string;
  source: SessionUsageSource | "all";
};

export type SessionUsageReport = {
  generatedAtMs: number;
  sinceMs: number | null;
  untilMs: number | null;
  coverage: SourceCoverage[];
  notes: string[];
  totals: UsageSummary;
  weekly: WeeklyUsageRow[];
  lengthBuckets: LengthBucketRow[];
  sessions: SessionUsageRow[];
};

export type SessionUsageDeps = {
  readOpenCode: (p: { sinceMs?: number; untilMs?: number }) => Promise<OpenCodeMessage[]>;
  readOpenCodeIndex: () => Promise<Record<string, OpenCodeSessionInfo>>;
  readClaude: (p: { sinceMs?: number; untilMs?: number }) => Promise<OpenCodeMessage[]>;
  readCodex: (p: { sinceMs?: number; untilMs?: number }) => Promise<OpenCodeMessage[]>;
  storeExists: (source: SessionUsageSource) => boolean;
  price: (p: { providerID?: string; modelID?: string; tokens: TokenBuckets }) => number | null;
};

const defaultDeps: SessionUsageDeps = {
  readOpenCode: (p) => iterAssistantMessages(p),
  readOpenCodeIndex: () => readAllSessionsIndex(),
  readClaude: (p) => iterClaudeCodeCliMessages(p),
  readCodex: (p) => iterCodexCliMessages(p),
  storeExists: (source) => {
    if (source === "opencode") {
      const dbPath = getOpenCodeDbPath();
      return Boolean(dbPath) && existsSync(dbPath);
    }
    return existsSync(
      source === "claude-code" ? getClaudeCodeCliProjectsDir() : getCodexCliSessionsDir(),
    );
  },
  price: priceTokensUsd,
};

export const SESSION_USAGE_NOTES = [
  "Counts are what each source reported on this machine, not billed or quota usage.",
  "Cost is estimated from the bundled or user pricing snapshot and covers only the priced share of tokens.",
  "Other machines are not included yet (UA-TW-06).",
  "GitHub Copilot and Zcode record no token counts and are not included (UA-TW-04).",
  "Sessions crossing the window edge only count responses inside the window.",
];

export const LENGTH_BUCKETS: readonly { label: string; min: number; max: number }[] = [
  { label: "1-10", min: 1, max: 10 },
  { label: "11-50", min: 11, max: 50 },
  { label: "51-200", min: 51, max: 200 },
  { label: "201+", min: 201, max: Number.POSITIVE_INFINITY },
];

type Accumulator = {
  sessions: Set<string>;
  responses: number;
  tokens: TokenBuckets;
  subagentTokens: number;
  marksSubagents: boolean;
  costUsd: number;
  pricedResponses: number;
  unpricedTokens: number;
};

function newAccumulator(): Accumulator {
  return {
    sessions: new Set(),
    responses: 0,
    tokens: emptyTokenBuckets(),
    subagentTokens: 0,
    marksSubagents: false,
    costUsd: 0,
    pricedResponses: 0,
    unpricedTokens: 0,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function cacheReadShare(tokens: TokenBuckets): number | null {
  return ratio(tokens.cache_read, tokens.input + tokens.cache_read + tokens.cache_write);
}

function summarise(acc: Accumulator): UsageSummary {
  const totalTokens = totalTokenBuckets(acc.tokens);
  return {
    sessions: acc.sessions.size,
    responses: acc.responses,
    totalTokens,
    cacheReadShare: cacheReadShare(acc.tokens),
    tokensPerResponse: ratio(totalTokens, acc.responses),
    subagentShare: acc.marksSubagents ? ratio(acc.subagentTokens, totalTokens) : null,
    costUsd: acc.pricedResponses > 0 ? acc.costUsd : null,
    unpricedTokens: acc.unpricedTokens,
    pricedShare: ratio(totalTokens - acc.unpricedTokens, totalTokens),
  };
}

/** Monday 00:00 UTC of the week containing `ms`, as YYYY-MM-DD. */
export function utcWeekStart(ms: number): string {
  const date = new Date(ms);
  const day = date.getUTCDay();
  const monday = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - ((day + 6) % 7),
  );
  return new Date(monday).toISOString().slice(0, 10);
}

/** Walks OpenCode's parent links to the root session (cycle-safe). */
function openCodeRoot(sessionID: string, index: Record<string, OpenCodeSessionInfo>): string {
  let current = sessionID;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = index[current]?.parentID;
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

type TaggedMessage = {
  source: SessionUsageSource;
  rootID: string;
  subagent: boolean;
  message: OpenCodeMessage;
};

function errorReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Keep reasons short and free of anything but the error's own first line.
  return text.split("\n")[0]!.slice(0, 200);
}

type SessionAccumulator = {
  source: SessionUsageSource;
  sessionID: string;
  directory: string | null;
  startMs: number | null;
  endMs: number | null;
  responses: number;
  subagentResponses: number;
  models: Map<string, ModelShare>;
  tokens: TokenBuckets;
  subagentTokens: number;
  costUsd: number;
  pricedResponses: number;
  unpricedTokens: number;
};

export async function buildSessionUsageReport(
  params: {
    sinceMs?: number;
    untilMs?: number;
    nowMs?: number;
  } = {},
  deps: Partial<SessionUsageDeps> = {},
): Promise<SessionUsageReport> {
  const d: SessionUsageDeps = { ...defaultDeps, ...deps };
  const window = { sinceMs: params.sinceMs, untilMs: params.untilMs };

  const coverage = new Map<SessionUsageSource, SourceCoverage>();
  const tagged: TaggedMessage[] = [];

  async function load(
    source: SessionUsageSource,
    read: () => Promise<TaggedMessage[]>,
  ): Promise<void> {
    const entry: SourceCoverage = {
      source,
      status: "read",
      sessions: 0,
      responses: 0,
      undatedResponses: 0,
      marksSubagents: false,
    };
    coverage.set(source, entry);
    if (!d.storeExists(source)) {
      entry.status = "not-found";
      return;
    }
    try {
      tagged.push(...(await read()));
    } catch (error) {
      entry.status = "unavailable";
      entry.reason = errorReason(error);
    }
  }

  await load("claude-code", async () =>
    (await d.readClaude(window)).map((message) => ({
      source: "claude-code" as const,
      rootID: message.parentSessionID ?? message.sessionID,
      subagent: message.subagent === true,
      message,
    })),
  );
  await load("opencode", async () => {
    const [messages, index] = await Promise.all([d.readOpenCode(window), d.readOpenCodeIndex()]);
    return messages.map((message) => {
      const rootID = openCodeRoot(message.sessionID, index);
      return {
        source: "opencode" as const,
        rootID,
        subagent: rootID !== message.sessionID,
        message,
      };
    });
  });
  await load("codex", async () =>
    (await d.readCodex(window)).map((message) => ({
      source: "codex" as const,
      rootID: message.parentSessionID ?? message.sessionID,
      subagent: message.subagent === true,
      message,
    })),
  );

  // OpenCode's subagent marking comes from the session index, Claude's and
  // Codex's from per-message fields; a source "marks" subagents when it can.
  const opencodeCoverage = coverage.get("opencode")!;
  opencodeCoverage.marksSubagents = opencodeCoverage.status === "read";
  for (const t of tagged) {
    if (t.message.subagent !== undefined) coverage.get(t.source)!.marksSubagents = true;
  }

  const sessions = new Map<string, SessionAccumulator>();
  const weekly = new Map<string, Accumulator>();

  for (const t of tagged) {
    const { message } = t;
    const tokens = tokenBucketsFromMessage(message);
    const total = totalTokenBuckets(tokens);
    const created = message.time?.created;
    const createdMs = typeof created === "number" && Number.isFinite(created) ? created : null;
    const key = `${t.source}\u0000${t.rootID}`;
    const cov = coverage.get(t.source)!;
    cov.responses += 1;
    if (createdMs === null) cov.undatedResponses += 1;

    let row = sessions.get(key);
    if (!row) {
      row = {
        source: t.source,
        sessionID: t.rootID,
        directory: null,
        startMs: null,
        endMs: null,
        responses: 0,
        subagentResponses: 0,
        models: new Map(),
        tokens: emptyTokenBuckets(),
        subagentTokens: 0,
        costUsd: 0,
        pricedResponses: 0,
        unpricedTokens: 0,
      };
      sessions.set(key, row);
    }
    // Prefer the root session's own directory over a subagent's.
    if (message.directory && (!t.subagent || !row.directory)) row.directory = message.directory;
    if (createdMs !== null) {
      row.startMs = row.startMs === null ? createdMs : Math.min(row.startMs, createdMs);
      row.endMs = row.endMs === null ? createdMs : Math.max(row.endMs, createdMs);
    }
    row.responses += 1;
    row.tokens = addTokenBuckets(row.tokens, tokens);
    if (t.subagent) {
      row.subagentResponses += 1;
      row.subagentTokens += total;
    }
    const model = message.modelID ?? "unknown";
    const share = row.models.get(model) ?? { model, responses: 0, totalTokens: 0 };
    share.responses += 1;
    share.totalTokens += total;
    row.models.set(model, share);

    const cost = d.price({ providerID: message.providerID, modelID: message.modelID, tokens });
    if (cost === null) {
      row.unpricedTokens += total;
    } else {
      row.costUsd += cost;
      row.pricedResponses += 1;
    }

    if (createdMs !== null) {
      const week = utcWeekStart(createdMs);
      for (const scope of [t.source, "all"] as const) {
        const wkey = `${week}\u0000${scope}`;
        const acc = weekly.get(wkey) ?? newAccumulator();
        acc.sessions.add(key);
        acc.responses += 1;
        acc.tokens = addTokenBuckets(acc.tokens, tokens);
        if (t.subagent) acc.subagentTokens += total;
        if (cov.marksSubagents) acc.marksSubagents = true;
        if (cost === null) acc.unpricedTokens += total;
        else {
          acc.costUsd += cost;
          acc.pricedResponses += 1;
        }
        weekly.set(wkey, acc);
      }
    }
  }

  const rows: SessionUsageRow[] = [...sessions.values()].map((s) => {
    const totalTokens = totalTokenBuckets(s.tokens);
    return {
      source: s.source,
      sessionID: s.sessionID,
      directory: s.directory,
      startMs: s.startMs,
      endMs: s.endMs,
      activeMinutes:
        s.startMs !== null && s.endMs !== null && s.endMs > s.startMs
          ? (s.endMs - s.startMs) / 60_000
          : null,
      responses: s.responses,
      subagentResponses: s.subagentResponses,
      models: [...s.models.values()].sort(
        (a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model),
      ),
      tokens: s.tokens,
      totalTokens,
      subagentTokens: s.subagentTokens,
      cacheReadShare: cacheReadShare(s.tokens),
      tokensPerResponse: ratio(totalTokens, s.responses),
      costUsd: s.pricedResponses > 0 ? s.costUsd : null,
      unpricedTokens: s.unpricedTokens,
      pricedShare: ratio(totalTokens - s.unpricedTokens, totalTokens),
    };
  });
  rows.sort(
    (a, b) =>
      b.totalTokens - a.totalTokens ||
      a.source.localeCompare(b.source) ||
      a.sessionID.localeCompare(b.sessionID),
  );

  for (const row of rows) coverage.get(row.source)!.sessions += 1;

  const totals = newAccumulator();
  const buckets = new Map<string, Accumulator>();
  for (const row of rows) {
    const key = `${row.source}\u0000${row.sessionID}`;
    const marks = coverage.get(row.source)!.marksSubagents;
    const bucket = LENGTH_BUCKETS.find((b) => row.responses >= b.min && row.responses <= b.max)!;
    const targets = [totals];
    for (const scope of [row.source, "all"]) {
      const bkey = `${bucket.label}\u0000${scope}`;
      const acc = buckets.get(bkey) ?? newAccumulator();
      buckets.set(bkey, acc);
      targets.push(acc);
    }
    for (const acc of targets) {
      acc.sessions.add(key);
      acc.responses += row.responses;
      acc.tokens = addTokenBuckets(acc.tokens, row.tokens);
      acc.subagentTokens += row.subagentTokens;
      if (marks) acc.marksSubagents = true;
      acc.unpricedTokens += row.unpricedTokens;
      if (row.costUsd !== null) {
        acc.costUsd += row.costUsd;
        acc.pricedResponses += 1;
      }
    }
  }

  const scopeOrder = (scope: string) =>
    scope === "all" ? 0 : 1 + SESSION_USAGE_SOURCES.indexOf(scope as SessionUsageSource);

  const weeklyRows: WeeklyUsageRow[] = [...weekly.entries()]
    .map(([wkey, acc]) => {
      const [weekStart, source] = wkey.split("\u0000") as [string, WeeklyUsageRow["source"]];
      return { weekStart, source, ...summarise(acc) };
    })
    .sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) || scopeOrder(a.source) - scopeOrder(b.source),
    );

  const bucketRows: LengthBucketRow[] = [...buckets.entries()]
    .map(([bkey, acc]) => {
      const [bucket, source] = bkey.split("\u0000") as [string, LengthBucketRow["source"]];
      return { bucket, source, ...summarise(acc) };
    })
    .sort(
      (a, b) =>
        LENGTH_BUCKETS.findIndex((x) => x.label === a.bucket) -
          LENGTH_BUCKETS.findIndex((x) => x.label === b.bucket) ||
        scopeOrder(a.source) - scopeOrder(b.source),
    );

  return {
    generatedAtMs: params.nowMs ?? Date.now(),
    sinceMs: params.sinceMs ?? null,
    untilMs: params.untilMs ?? null,
    coverage: SESSION_USAGE_SOURCES.map((source) => coverage.get(source)!),
    notes: [...SESSION_USAGE_NOTES],
    totals: summarise(totals),
    weekly: weeklyRows,
    lengthBuckets: bucketRows,
    sessions: rows,
  };
}
