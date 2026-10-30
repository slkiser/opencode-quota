import crypto from "node:crypto";
import { agyCompanion } from "./google-companion-credentials.js";
import type { GoogleAccount, GoogleQuotaFlavor } from "./google-oauth-quota.js";
import { createGoogleTokenCache } from "./google-token-cache.js";
import { nonEmptyString } from "./json-guards.js";
import type {
  GoogleAgyAuthSourceKey,
  GoogleAgyQuotaBucket,
  GoogleAgyQuotaSummaryBucket,
  GoogleAgyQuotaSummaryResponse,
} from "./types.js";

export const AGY_AUTH_KEYS = [
  "google",
  "google-agy",
  "opencode-agy-auth",
  "google-agy-auth",
] as const satisfies readonly GoogleAgyAuthSourceKey[];

type AgyAccount = GoogleAccount<GoogleAgyAuthSourceKey>;

/** The Google OAuth quota flow of Google AGY. */
export const AGY_FLAVOR: GoogleQuotaFlavor<
  GoogleAgyAuthSourceKey,
  GoogleAgyQuotaSummaryResponse,
  GoogleAgyQuotaBucket
> = {
  providerId: "google-agy",
  name: "Google AGY",
  authKeys: AGY_AUTH_KEYS,
  projectIdEnvVar: "OPENCODE_AGY_PROJECT_ID",
  projectIdConfigProvider: "google-agy",
  failedLoginCountsAsPresent: false,
  companion: agyCompanion,
  quotaUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  quotaHeaders: () => ({
    "User-Agent": "antigravity/cli/1.4.7 darwin/amd64",
    "x-activity-request-id": crypto.randomUUID(),
  }),
  tokenCache: createGoogleTokenCache(),
  toBuckets: toAgyBuckets,
};

function normalizeWindow(
  value: unknown,
): Pick<GoogleAgyQuotaBucket, "window" | "windowLabel"> | undefined {
  const normalized = nonEmptyString(value)
    ?.toUpperCase()
    .replace(/[\s-]+/gu, "_");
  if (normalized === "WEEKLY") return { window: "weekly", windowLabel: "Weekly" };
  if (normalized === "FIVE_HOUR" || normalized === "5H") {
    return { window: "five_hour", windowLabel: "5h" };
  }
  return undefined;
}

function normalizeFamily(value: unknown): string | undefined {
  const displayName = nonEmptyString(value);
  if (!displayName) return undefined;
  // Only the two shared pools get canonical names; a model-specific group such as
  // "Gemini 4 Argon" has its own limits and keeps its own name.
  const normalized = displayName.toLowerCase().replace(/\s+/gu, " ");
  if (normalized === "gemini" || normalized === "gemini models") return "Gemini Models";
  if (normalized.includes("claude") && normalized.includes("gpt")) return "Claude and GPT models";
  return displayName;
}

function familyRank(family: string): number {
  if (family === "Gemini Models") return 0;
  if (family === "Claude and GPT models") return 1;
  return 2;
}

/** Gemini before Claude/GPT before other families, then weekly before 5h. */
export function compareAgyBuckets(left: GoogleAgyQuotaBucket, right: GoogleAgyQuotaBucket): number {
  return (
    familyRank(left.family) - familyRank(right.family) ||
    left.family.localeCompare(right.family) ||
    (left.window === "weekly" ? 0 : 1) - (right.window === "weekly" ? 0 : 1) ||
    (left.bucketLabel ?? "").localeCompare(right.bucketLabel ?? "") ||
    (left.bucketId ?? "").localeCompare(right.bucketId ?? "")
  );
}

function toAgyBucket(
  bucket: GoogleAgyQuotaSummaryBucket,
  family: string,
  account: AgyAccount,
): GoogleAgyQuotaBucket | undefined {
  if (!bucket || typeof bucket !== "object" || bucket.disabled) return undefined;

  const window = normalizeWindow(bucket.window);
  const remainingFraction = bucket.remainingFraction;
  if (!window || typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) {
    return undefined;
  }

  const bucketId = nonEmptyString(bucket.bucketId);
  const bucketLabel = nonEmptyString(bucket.displayName);
  const remainingAmount =
    nonEmptyString(bucket.remainingAmount) ?? nonEmptyString(bucket.remaining);
  const resetTimeMs = Date.parse(nonEmptyString(bucket.resetTime) ?? "");
  return {
    family,
    ...window,
    ...(bucketId ? { bucketId } : {}),
    ...(bucketLabel ? { bucketLabel } : {}),
    remainingFraction,
    percentRemaining: Math.round(Math.min(1, Math.max(0, remainingFraction)) * 100),
    ...(Number.isFinite(resetTimeMs) ? { resetTimeIso: new Date(resetTimeMs).toISOString() } : {}),
    ...(remainingAmount ? { remainingAmount } : {}),
    ...(account.email ? { accountEmail: account.email } : {}),
    sourceKey: account.sourceKey,
  };
}

/**
 * Rows of the grouped summary, or of the top-level buckets when no group has a
 * usable row. Duplicate rows keep the most constrained one.
 */
function toAgyBuckets(
  response: GoogleAgyQuotaSummaryResponse,
  account: AgyAccount,
): GoogleAgyQuotaBucket[] {
  const rows: GoogleAgyQuotaBucket[] = [];
  const addRows = (buckets: unknown, family: string | undefined): void => {
    if (!family || !Array.isArray(buckets)) return;
    for (const bucket of buckets) {
      const row = toAgyBucket(bucket, family, account);
      if (row) rows.push(row);
    }
  };

  if (response && typeof response === "object") {
    for (const group of Array.isArray(response.groups) ? response.groups : []) {
      addRows(group?.buckets, normalizeFamily(group?.displayName));
    }
    if (rows.length === 0) {
      addRows(response.buckets, normalizeFamily(response.description) ?? "Quota Summary");
    }
  }

  const deduplicated = new Map<string, GoogleAgyQuotaBucket>();
  for (const row of rows) {
    const identity = `${row.family}\0${row.window}\0${row.bucketId ?? row.bucketLabel ?? row.window}`;
    const existing = deduplicated.get(identity);
    if (!existing || row.remainingFraction < existing.remainingFraction) {
      deduplicated.set(identity, row);
    }
  }
  // A summary without one usable row fails this account.
  if (deduplicated.size === 0) throw new Error("Quota summary API unavailable");
  return [...deduplicated.values()].sort(compareAgyBuckets);
}
