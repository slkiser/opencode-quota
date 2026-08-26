import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  hasAgyQuotaRuntimeAvailable,
  inspectAgyAuthPresence,
  queryGoogleAgyQuota,
} from "../lib/google-agy.js";
import { inspectAgyCompanionPresence } from "../lib/google-agy-companion.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import type { AuthData, GoogleAgyQuotaBucket } from "../lib/types.js";
import {
  createGoogleAccountLabelMap,
  formatGoogleAccountErrors,
  formatGoogleAccountLabel,
} from "./google-account-format.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

function isAgyModel(model: string): boolean {
  const { providerId } = parseProviderModelRef(model);
  return ["google-agy", "opencode-agy-auth", "google-agy-auth"].includes(providerId);
}

function formatAgyAccountLabel(
  bucket: { accountEmail?: string; accountKey?: string },
  accountLabels: ReadonlyMap<string, string>,
): string {
  if (bucket.accountEmail) {
    return (
      accountLabels.get(bucket.accountEmail) ??
      formatGoogleAccountLabel(bucket.accountEmail, "domainHint")
    );
  }
  return bucket.accountKey ? `Account ${bucket.accountKey.slice(0, 8)}` : "Unknown";
}

function familyRank(family: string): number {
  if (family === "Gemini Models") return 0;
  if (family === "Claude and GPT models") return 1;
  return 2;
}

function windowRank(window: GoogleAgyQuotaBucket["window"]): number {
  return window === "weekly" ? 0 : 1;
}

function formatAgyFamilyLabel(family: string): string {
  if (family === "Gemini Models") return "Gemini";
  if (family === "Claude and GPT models") return "Claude/GPT";
  return family;
}

function compareBuckets(left: GoogleAgyQuotaBucket, right: GoogleAgyQuotaBucket): number {
  if (left.accountIndex !== right.accountIndex) {
    return left.accountIndex - right.accountIndex;
  }

  const rankedFamily = familyRank(left.family) - familyRank(right.family);
  if (rankedFamily !== 0) {
    return rankedFamily;
  }

  const familyName = left.family.localeCompare(right.family);
  if (familyName !== 0) {
    return familyName;
  }

  const rankedWindow = windowRank(left.window) - windowRank(right.window);
  if (rankedWindow !== 0) {
    return rankedWindow;
  }

  const bucketLabel = (left.bucketLabel ?? "").localeCompare(right.bucketLabel ?? "");
  if (bucketLabel !== 0) {
    return bucketLabel;
  }
  return (left.bucketId ?? "").localeCompare(right.bucketId ?? "");
}

function formatRemainingAmount(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  const display = Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US")
    : sanitizeDisplayText(normalized);
  return `${display} left`;
}

async function isAgyConfigured(ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await hasAgyQuotaRuntimeAvailable(ctx.client);
  } catch {
    return false;
  }
}

export const googleAgyProvider: QuotaProvider = {
  id: "google-agy",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    return await isAgyConfigured(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    return isAgyModel(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const [auth, companion] = await Promise.all([
      inspectAgyAuthPresence(ctx.client),
      inspectAgyCompanionPresence(),
    ]);
    const statusDetails = statusDetailsFromRecord({
      auth_state: auth.state,
      auth_source: auth.sourceKey ?? "(none)",
      account_count: String(auth.accountCount),
      valid_account_count: String(auth.validAccountCount),
      companion_package_state: companion.state,
      companion_package_path:
        companion.state === "present" || companion.state === "invalid"
          ? (companion.resolvedPath ?? "(none)")
          : "(none)",
      auth_error: auth.state === "invalid" ? sanitizeDisplayText(auth.error) : undefined,
      companion_error:
        companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
    });
    const credentialRows = (await readCredentialRows()).filter((row) =>
      ["google-agy", "opencode-agy-auth", "google-agy-auth"].includes(row.integrationId),
    );
    if (credentialRows.length > 0) {
      const results = await Promise.all(
        credentialRows.map(async (row) => ({
          row,
          result: await queryGoogleAgyQuota(ctx.client, {
            requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
              ? ctx.config.requestTimeoutMs
              : undefined,
            authData: { [row.integrationId]: row.value } as AuthData,
          }),
        })),
      );
      const names = formatCredentialDisplayNames(
        "Google AGY",
        results.map(({ row }) => ({ row, fallbackName: "Google AGY" })),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [];
      for (const [index, { row, result }] of results.entries()) {
        const group = names[index] ?? "Google AGY";
        if (!result) continue;
        if (!result.success) {
          errors.push({ label: group, message: result.error });
          continue;
        }
        for (const bucket of [...result.buckets].sort(compareBuckets)) {
          const right = formatRemainingAmount(bucket.remainingAmount);
          entries.push({
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: row.id,
            },
            name: `${group} ${formatAgyFamilyLabel(bucket.family)} ${bucket.windowLabel}`,
            group,
            label: `${bucket.windowLabel}:`,
            sortPriority: windowRank(bucket.window),
            ...(right ? { right } : {}),
            percentRemaining: bucket.percentRemaining,
            resetTimeIso: bucket.resetTimeIso,
          });
        }
        errors.push(
          ...(result.errors ?? []).map((error) => ({
            label: group,
            message: error.error,
          })),
        );
      }
      return withStatusDetails(
        attemptedResult(entries, errors, { singleWindowShowRight: true }),
        statusDetails,
      );
    }
    const result = await queryGoogleAgyQuota(ctx.client, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Google AGY", result.error), statusDetails);
    }

    const sortedBuckets = [...result.buckets].sort(compareBuckets);
    const accountLabels = createGoogleAccountLabelMap(
      [
        ...sortedBuckets.map((bucket) => bucket.accountEmail),
        ...(result.errors ?? []).map((error) => error.email),
      ],
      "domainHint",
    );
    const entries: QuotaToastEntry[] = sortedBuckets.map((bucket) => {
      const accountLabel = formatAgyAccountLabel(bucket, accountLabels);
      const right = formatRemainingAmount(bucket.remainingAmount);

      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          sourceId: bucket.accountKey ?? bucket.accountEmail ?? `account-${bucket.accountIndex}`,
        },
        name: `${bucket.family} (${accountLabel})`,
        group: `AGY (${accountLabel}): ${formatAgyFamilyLabel(bucket.family)}`,
        label: `${bucket.windowLabel}:`,
        sortPriority: windowRank(bucket.window),
        ...(right ? { right } : {}),
        percentRemaining: bucket.percentRemaining,
        resetTimeIso: bucket.resetTimeIso,
      };
    });

    return withStatusDetails(
      attemptedResult(
        entries,
        formatGoogleAccountErrors(result.errors, "domainHint", accountLabels),
        {
          singleWindowShowRight: true,
        },
      ),
      statusDetails,
    );
  },
};
