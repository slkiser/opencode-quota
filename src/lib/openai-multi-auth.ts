/**
 * Read-only integration with oc-codex-multi-auth account storage.
 *
 * The companion plugin owns refresh-token rotation and persistence. This
 * module only reads the account file and exposes cached access tokens.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";

export const OPENAI_MULTI_AUTH_ACCOUNTS_FILE = "oc-codex-multi-auth-accounts.json";

export type OpenAIMultiAuthAccount = {
  index: number;
  accountId?: string;
  accountUserId?: string;
  organizationId?: string;
  accountLabel?: string;
  email?: string;
  accessToken?: string;
  expiresAt?: number;
  sourceId: string;
};

export type OpenAIMultiAuthPresence = {
  state: "missing" | "present" | "invalid";
  accountCount: number;
  enabledAccountCount: number;
  cachedAccessTokenCount: number;
  error?: string;
};

type RawMultiAuthStorage = {
  version?: unknown;
  accounts?: unknown;
};

type RawMultiAuthAccount = {
  accountId?: unknown;
  accountUserId?: unknown;
  organizationId?: unknown;
  accountLabel?: unknown;
  email?: unknown;
  accessToken?: unknown;
  expiresAt?: unknown;
  refreshToken?: unknown;
  enabled?: unknown;
};

function optionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeLabel(value: unknown): string | undefined {
  const label = optionalTrimmedString(value);
  if (!label) return undefined;
  return sanitizeSingleLineDisplayText(label).slice(0, 80) || undefined;
}

function buildSourceId(account: RawMultiAuthAccount): string {
  const identityParts = [
    optionalTrimmedString(account.accountId) ?? "",
    optionalTrimmedString(account.organizationId) ?? "",
    optionalTrimmedString(account.accountUserId) ?? "",
    optionalTrimmedString(account.email)?.toLowerCase() ?? "",
  ];
  const identity = identityParts.some(Boolean)
    ? identityParts.join("\u0000")
    : `credential:${optionalTrimmedString(account.accessToken) ?? optionalTrimmedString(account.refreshToken) ?? "unknown"}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `openai-multi-auth:${digest}`;
}

function parseAccount(account: unknown, index: number): OpenAIMultiAuthAccount | null {
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;

  const raw = account as RawMultiAuthAccount;
  if (raw.enabled === false) return null;
  if (!optionalTrimmedString(raw.refreshToken)) return null;

  const accountId = optionalTrimmedString(raw.accountId);
  const organizationId = optionalTrimmedString(raw.organizationId);
  const accountUserId = optionalTrimmedString(raw.accountUserId);
  const email = optionalTrimmedString(raw.email)?.toLowerCase();

  return {
    index,
    accountId,
    accountUserId,
    organizationId,
    accountLabel: safeLabel(raw.accountLabel),
    email: email ? safeLabel(email) : undefined,
    accessToken: optionalTrimmedString(raw.accessToken),
    expiresAt: optionalFiniteNumber(raw.expiresAt),
    sourceId: buildSourceId(raw),
  };
}

function supportedStorage(
  parsed: unknown,
): parsed is RawMultiAuthStorage & { accounts: unknown[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const storage = parsed as RawMultiAuthStorage;
  return (storage.version === 1 || storage.version === 3) && Array.isArray(storage.accounts);
}

function uniqueAccounts(accounts: OpenAIMultiAuthAccount[]): OpenAIMultiAuthAccount[] {
  const bySource = new Map<string, OpenAIMultiAuthAccount>();
  for (const account of accounts) {
    if (!bySource.has(account.sourceId)) bySource.set(account.sourceId, account);
  }
  return [...bySource.values()];
}

export function getOpenAIMultiAuthAccountsPath(): string {
  return join(homedir(), ".opencode", OPENAI_MULTI_AUTH_ACCOUNTS_FILE);
}

export async function readOpenAIMultiAuthAccountsFromPath(
  path: string,
): Promise<OpenAIMultiAuthAccount[] | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!supportedStorage(parsed)) return null;

    const accounts = uniqueAccounts(
      parsed.accounts
        .map((account, index) => parseAccount(account, index))
        .filter((account): account is OpenAIMultiAuthAccount => Boolean(account)),
    );
    return accounts.length > 0 ? accounts : null;
  } catch {
    return null;
  }
}

export async function readOpenAIMultiAuthAccounts(): Promise<OpenAIMultiAuthAccount[] | null> {
  return readOpenAIMultiAuthAccountsFromPath(getOpenAIMultiAuthAccountsPath());
}

export async function hasOpenAIMultiAuthAccountsConfigured(): Promise<boolean> {
  return Boolean(await readOpenAIMultiAuthAccounts());
}

export async function inspectOpenAIMultiAuthPresence(): Promise<OpenAIMultiAuthPresence> {
  try {
    const parsed = JSON.parse(await readFile(getOpenAIMultiAuthAccountsPath(), "utf8")) as unknown;
    if (!supportedStorage(parsed)) {
      return {
        state: "invalid",
        accountCount: 0,
        enabledAccountCount: 0,
        cachedAccessTokenCount: 0,
        error: "unsupported or malformed account storage",
      };
    }

    const accounts = uniqueAccounts(
      parsed.accounts
        .map((account, index) => parseAccount(account, index))
        .filter((account): account is OpenAIMultiAuthAccount => Boolean(account)),
    );
    return {
      state: accounts.length > 0 ? "present" : "invalid",
      accountCount: parsed.accounts.length,
      enabledAccountCount: accounts.length,
      cachedAccessTokenCount: accounts.filter((account) => Boolean(account.accessToken)).length,
      ...(accounts.length === 0 ? { error: "no enabled accounts with refresh credentials" } : {}),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        state: "missing",
        accountCount: 0,
        enabledAccountCount: 0,
        cachedAccessTokenCount: 0,
      };
    }
    return {
      state: "invalid",
      accountCount: 0,
      enabledAccountCount: 0,
      cachedAccessTokenCount: 0,
      error: "failed to read account storage",
    };
  }
}
