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
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";

export const OPENAI_MULTI_AUTH_ACCOUNTS_FILE = "oc-codex-multi-auth-accounts.json";

export type OpenAIMultiAuthAccount = {
  index: number;
  accountId?: string;
  accountUserId?: string;
  organizationId?: string;
  accountLabel?: string;
  email?: string;
  planType?: string;
  addedAt?: number;
  accessToken?: string;
  expiresAt?: number;
  sourceId: string;
};

export type OpenAIMultiAuthIdentityState =
  | { state: "inactive" }
  | { state: "active"; identity: ResolvedAuthIdentity | null };

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
  planType?: unknown;
  addedAt?: unknown;
  accessToken?: unknown;
  expiresAt?: unknown;
  refreshToken?: unknown;
  enabled?: unknown;
};

const privateRefreshCredentials = new WeakMap<OpenAIMultiAuthAccount, string>();
const KNOWN_PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "team",
  "business",
  "enterprise",
  "edu",
]);

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

function safePlanType(value: unknown): string | undefined {
  const normalized = optionalTrimmedString(value)?.toLowerCase();
  return normalized && KNOWN_PLAN_TYPES.has(normalized) ? normalized : undefined;
}

function buildSourceId(account: RawMultiAuthAccount, index: number): string {
  const identityParts = [
    optionalTrimmedString(account.accountId),
    optionalTrimmedString(account.organizationId),
    optionalTrimmedString(account.accountUserId),
    optionalFiniteNumber(account.addedAt),
  ];
  if (!identityParts.some((part) => part !== undefined)) {
    return `openai-multi-auth:slot-${index}`;
  }

  const identity = JSON.stringify(identityParts);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `openai-multi-auth:${digest}`;
}

function parseAccount(account: unknown, index: number): OpenAIMultiAuthAccount | null {
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;

  const raw = account as RawMultiAuthAccount;
  if (raw.enabled === false) return null;
  const refreshToken = optionalTrimmedString(raw.refreshToken);
  if (!refreshToken) return null;

  const accountId = optionalTrimmedString(raw.accountId);
  const organizationId = optionalTrimmedString(raw.organizationId);
  const accountUserId = optionalTrimmedString(raw.accountUserId);
  const email = optionalTrimmedString(raw.email)?.toLowerCase();
  const planType = safePlanType(raw.planType);
  const addedAt = optionalFiniteNumber(raw.addedAt);
  const parsed: OpenAIMultiAuthAccount = {
    index,
    accountId,
    accountUserId,
    organizationId,
    accountLabel: safeLabel(raw.accountLabel),
    email: email ? safeLabel(email) : undefined,
    planType,
    addedAt,
    accessToken: optionalTrimmedString(raw.accessToken),
    expiresAt: optionalFiniteNumber(raw.expiresAt),
    sourceId: buildSourceId(raw, index),
  };

  privateRefreshCredentials.set(parsed, refreshToken);
  return parsed;
}

function supportedStorage(
  parsed: unknown,
): parsed is RawMultiAuthStorage & { accounts: unknown[] } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const storage = parsed as RawMultiAuthStorage;
  return (storage.version === 1 || storage.version === 3) && Array.isArray(storage.accounts);
}

function parseAccounts(accounts: unknown[]): OpenAIMultiAuthAccount[] {
  const parsed = accounts
    .map((account, index) => parseAccount(account, index))
    .filter((account): account is OpenAIMultiAuthAccount => Boolean(account));
  const sourceCounts = new Map<string, number>();
  for (const account of parsed) {
    sourceCounts.set(account.sourceId, (sourceCounts.get(account.sourceId) ?? 0) + 1);
  }

  for (const account of parsed) {
    if ((sourceCounts.get(account.sourceId) ?? 0) > 1) {
      account.sourceId = `${account.sourceId}:slot-${account.index}`;
    }
  }
  return parsed;
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

    const accounts = parseAccounts(parsed.accounts);
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

function stableAccountIdentity(account: OpenAIMultiAuthAccount): string | undefined {
  if (!account.accountId && !account.organizationId && !account.accountUserId) return undefined;
  return JSON.stringify([
    account.accountId ?? null,
    account.organizationId ?? null,
    account.accountUserId ?? null,
    account.addedAt ?? null,
  ]);
}

async function resolveAccountIdentity(
  account: OpenAIMultiAuthAccount,
): Promise<ResolvedAuthIdentity | null> {
  const stableId = stableAccountIdentity(account);
  if (stableId) {
    return deriveResolvedAuthIdentity({
      providerId: "openai",
      principal: { kind: "stable-id", value: stableId },
    });
  }

  const refreshToken = privateRefreshCredentials.get(account);
  if (!refreshToken) return null;
  return deriveResolvedAuthIdentity({
    providerId: "openai",
    principal: { kind: "credential", value: refreshToken },
  });
}

export async function resolveOpenAIMultiAuthIdentity(): Promise<OpenAIMultiAuthIdentityState> {
  const accounts = await readOpenAIMultiAuthAccounts();
  if (!accounts || accounts.length === 0) return { state: "inactive" };

  const identities = await Promise.all(accounts.map(resolveAccountIdentity));
  if (identities.some((identity) => identity === null)) {
    return { state: "active", identity: null };
  }

  const identity = await composeResolvedAuthIdentities({
    providerId: "openai",
    identities: [...(identities as ResolvedAuthIdentity[])].sort(),
  });
  return { state: "active", identity };
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

    const accounts = parseAccounts(parsed.accounts);
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
