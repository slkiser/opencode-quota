/**
 * Read-only adapter for opencode-claude-code-plugin's version 1 account-usage store
 * (producer v0.73.7). These are observations from Claude turns, not live quota requests.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isIsoTime } from "../core/validate.js";
import {
  FIVE_HOUR,
  type ProviderFetchResult,
  WEEKLY,
  type WindowValue,
  windowRows,
} from "../providers/contract.js";
import { asRecord, finiteNumber, isRecord } from "./json-guards.js";
import { claudeCodePluginAccountLabel } from "./provider-metadata.js";

const MAX_AGE_MS = 8 * 24 * 60 * 60_000;
const UNTIMED_TTL_MS = 5 * 60 * 60_000;

export function claudeCodePluginUsagePath(): string {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "opencode-claude-code-plugin",
    "account-usage.json",
  );
}

function isoTime(value: unknown): string | undefined {
  const ms = finiteNumber(value);
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return undefined;
  const iso = date.toISOString();
  return isIsoTime(iso) ? iso : undefined;
}

function windowValue(raw: unknown, nowMs: number): WindowValue | undefined {
  if (!isRecord(raw)) return undefined;
  const observedAt = isoTime(raw.observedAt);
  const observedMs = observedAt === undefined ? undefined : Date.parse(observedAt);
  const resetsAt = isoTime(raw.resetsAt);
  const utilization = finiteNumber(raw.utilization);
  if (
    observedMs === undefined ||
    observedMs > nowMs ||
    typeof raw.status !== "string" ||
    !/^[a-z_]{1,32}$/u.test(raw.status) ||
    (raw.resetsAt !== undefined && !resetsAt) ||
    (raw.utilization !== null && utilization === undefined)
  )
    return undefined;
  const expiresMs = Math.min(
    observedMs + MAX_AGE_MS,
    resetsAt ? Date.parse(resetsAt) : observedMs + UNTIMED_TTL_MS,
  );
  if (expiresMs <= nowMs) return undefined;
  if (utilization === undefined && raw.status !== "rejected") return undefined;
  // The plugin records a refused turn as `rejected` with no number: the limit is reached.
  const percentRemaining =
    utilization === undefined ? 0 : Math.round((1 - utilization) * 1000) / 10;
  return { percentRemaining, ...(resetsAt ? { resetTimeIso: resetsAt } : {}) };
}

async function storedAccounts(): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(claudeCodePluginUsagePath(), "utf8");
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT" ? {} : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && parsed.version === 1 && isRecord(parsed.accounts)
      ? parsed.accounts
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readClaudeCodePluginUsage(
  accounts: readonly string[],
): Promise<ProviderFetchResult> {
  const stored = await storedAccounts();
  const nowMs = Date.now();
  const results = accounts.map((account) => {
    const windows = asRecord(stored?.[account]);
    return {
      name: `Claude ${claudeCodePluginAccountLabel(account)}`,
      rows: windowRows(
        [
          { slot: FIVE_HOUR, value: windowValue(windows?.five_hour, nowMs) },
          { slot: WEEKLY, value: windowValue(windows?.seven_day, nowMs) },
        ],
        "local_cli",
      ),
      errors: [],
    };
  });
  const empty = stored !== undefined && results.every((account) => account.rows.length === 0);
  return {
    attempted: true,
    accounts: results,
    debug: [{ key: "quota_source", value: "claude-code-plugin-account-usage" }],
    ...(empty ? { empty: true as const } : {}),
  };
}
