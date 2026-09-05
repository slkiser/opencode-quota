import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import {
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  getOpenCodeGoAuthDiagnostics,
  type OpenCodeGoAuthDiagnostics,
  resolveOpenCodeGoAuth,
  resolveOpenCodeGoAuthCached,
} from "../lib/opencode-go-auth.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS: Record<OpenCodeGoWindowKey, { name: string; label: string }> = {
  rolling: { name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`, label: "5h:" },
  weekly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`, label: "Weekly:" },
  monthly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`, label: "Monthly:" },
};

function authStatusDetails(diagnostics: OpenCodeGoAuthDiagnostics): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    auth_source: diagnostics.source ?? "(none)",
    auth_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.state === "invalid" ? diagnostics.error : undefined,
  });
}

function buildOpenCodeGoEntries(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: OpenCodeGoWindowKey[],
  group = OPENCODE_GO_PROVIDER_LABEL,
  sourceId?: string,
): QuotaToastEntry[] {
  const selected = new Set(selectedWindows);
  const entries: QuotaToastEntry[] = [];

  for (const window of OPENCODE_GO_WINDOW_ORDER) {
    if (!selected.has(window)) continue;

    const usage = result[window];
    const labels = OPENCODE_GO_WINDOW_LABELS[window];
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        ...(sourceId ? { sourceId } : {}),
      },
      name: `${group} ${labels.label.slice(0, -1)}`,
      group,
      label: labels.label,
      percentRemaining: usage.percentRemaining,
      resetTimeIso: usage.resetTimeIso,
    });
  }

  return entries;
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const auth = await resolveOpenCodeGoAuthCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
    return auth.state === "configured";
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getOpenCodeGoAuthDiagnostics({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
    const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
    const statusDetails = [
      ...authStatusDetails(diagnostics),
      { key: "selected_windows", value: windows.join(",") },
    ];
    const auth = await resolveOpenCodeGoAuthCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });

    if (auth.state === "none") {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (diagnostics.source === "opencode.db") {
      const credentialRows = (await readCredentialRows()).filter((row) =>
        ["opencode-go", "opencode"].includes(row.integrationId),
      );
      const rowNames = formatCredentialDisplayNames(
        OPENCODE_GO_PROVIDER_LABEL,
        credentialRows.map((row) => ({ row, fallbackName: OPENCODE_GO_PROVIDER_LABEL })),
      );
      const displayNamesByRowId = new Map(
        credentialRows.map((row, index) => [row.id, rowNames[index] ?? OPENCODE_GO_PROVIDER_LABEL]),
      );
      const invalidErrors: QuotaProviderResult["errors"] = [];
      const credentials = credentialRows.flatMap((row) => {
        const rowAuth = resolveOpenCodeGoAuth({ [row.integrationId]: row.value });
        if (rowAuth.state === "invalid") {
          invalidErrors.push({ label: displayNamesByRowId.get(row.id) ?? OPENCODE_GO_PROVIDER_LABEL, message: rowAuth.error });
        }
        return rowAuth.state === "configured" ? [{ row, auth: rowAuth }] : [];
      });
      if (credentials.length > 0 || invalidErrors.length > 0) {
        const results = await Promise.all(
          credentials.map(async ({ row, auth }) => ({
            row,
            result: await queryOpenCodeGoQuota(auth.apiKey, {
              requestTimeoutMs: ctx.config.requestTimeoutMs,
            }),
          })),
        );
        const entries: QuotaToastEntry[] = [];
        const errors: QuotaProviderResult["errors"] = [...invalidErrors];
        for (const { row, result } of results) {
          const group = displayNamesByRowId.get(row.id) ?? OPENCODE_GO_PROVIDER_LABEL;
          if (result.success)
            entries.push(...buildOpenCodeGoEntries(result, windows, group, row.id));
          else errors.push({ label: group, message: result.error, retryable: result.retryable });
        }
        return withStatusDetails(attemptedResult(entries, errors), statusDetails);
      }
    }

    if (auth.state === "invalid") {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, auth.error),
        statusDetails,
      );
    }

    const result = await queryOpenCodeGoQuota(auth.apiKey, {
      requestTimeoutMs: ctx.config.requestTimeoutMs,
    });

    if (!result.success) {
      return withStatusDetails(
        attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error, {
          retryable: result.retryable,
        }),
        [...statusDetails, { key: "live_fetch_error", value: result.error }],
      );
    }

    const liveDetails = OPENCODE_GO_WINDOW_ORDER.map((window) => {
      const usage = result[window];
      return {
        key: `${window}_usage`,
        value: `status=${usage.status} percent_used=${usage.usagePercent} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso}`,
      };
    });

    return withStatusDetails(attemptedResult(buildOpenCodeGoEntries(result, windows)), [
      ...statusDetails,
      ...liveDetails,
    ]);
  },
};
