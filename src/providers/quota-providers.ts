import { rowsFromProviderResult } from "../core/rows.js";
import type { DebugDetail, QuotaRow } from "../core/types.js";
import type {
  QuotaProvider,
  QuotaProviderCachePolicy,
  QuotaProviderContext,
} from "../lib/entries.js";
import { mapWithConcurrency } from "../lib/map-with-concurrency.js";
import { collectLocalQuotaProviderEstimate } from "../lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  type QuotaProviderAuthSource,
  type RemoteQuotaProviderResult,
  resolveQuotaProviderApiKey,
} from "../lib/quota-providers-remote.js";
import type {
  LocalEstimateQuotaProviderDefinition,
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import {
  customQuotaProviderDefinitions,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  resolveQuotaProviderSessionModelIdentity,
  selectEligibleQuotaProviderDefinitions,
} from "../lib/quota-providers.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import {
  type AccountResult,
  failedAccount,
  type FetchError,
  fetchError,
  type ProviderFetchResult,
  type ProviderRow,
} from "./contract.js";

const DEFINITION_CONCURRENCY = 4;

const CREDENTIAL_SOURCES: Record<QuotaProviderAuthSource, string> = {
  env: "explicit_env",
  "opencode.json": "global_opencode_json",
  "opencode.jsonc": "global_opencode_jsonc",
  "opencode.db": "opencode_db",
};

/**
 * One definition's account and its check for /quota_status. `failure` is why the whole check
 * failed (no rows); `missingKey` is set when that is a missing API key.
 */
export type DefinitionResult = {
  account: AccountResult;
  check: DebugDetail;
  failure?: string;
  missingKey?: true;
};

/**
 * A definition's rows and errors as its own account: the definition id is the login, and each
 * row id is `custom.<definition id>.<key>`.
 */
export function customAccount(
  definition: QuotaProviderDefinition,
  rows: readonly ProviderRow[],
  errors: readonly FetchError[],
): AccountResult {
  return {
    name: definition.label,
    login: definition.id,
    rows: rows.map((row) => ({ ...row, key: `custom.${definition.id}.${row.key}` })),
    errors: [...errors],
  };
}

/**
 * A definition's rows as the screen shows them: through the row gate, with a note for each row
 * the gate dropped.
 */
export function customRows(
  definition: QuotaProviderDefinition,
  rows: readonly ProviderRow[],
): { rows: QuotaRow[]; problems: string[] } {
  const shown = rowsFromProviderResult(QUOTA_PROVIDERS_AGGREGATE_ID, {
    attempted: true,
    accounts: [customAccount(definition, rows, [])],
    debug: [],
  });
  return { rows: shown.rows, problems: shown.debug.map((detail) => detail.value) };
}

/** One definition's check, never its URL or key: the outcome, the login source, files read. */
function checkDetail(definition: QuotaProviderDefinition, parts: readonly string[]): DebugDetail {
  return { key: `custom_${definition.id}_check`, value: parts.join(" ") };
}

function credentialParts(auth: QuotaProviderAuthResolution | undefined): string[] {
  const source = auth?.key && auth.source ? CREDENTIAL_SOURCES[auth.source] : "(none)";
  const paths = new Set([...(auth?.checkedPaths ?? []), ...(auth?.credentialDatabasePaths ?? [])]);
  return [`credential_source=${source}`, `checked_paths=${[...paths].join(" | ") || "(none)"}`];
}

function selectDefinitions(
  ctx: QuotaProviderContext,
  availableProviderIds: ReadonlySet<string>,
): QuotaProviderDefinition[] {
  return selectEligibleQuotaProviderDefinitions({
    definitions: ctx.config.quotaProviders ?? [],
    availableProviderIds,
    onlyCurrentModel: ctx.config.onlyCurrentModel,
    currentModel: ctx.config.currentModel,
    currentProviderID: ctx.config.currentProviderID,
  });
}

/** The check's words for a failed request, for example "outcome=http_error http_status=503". */
function failedRequestParts(
  result: Extract<RemoteQuotaProviderResult, { success: false }>,
): string[] {
  return result.outcome === "http_error" && result.facts?.status !== undefined
    ? ["outcome=http_error", `http_status=${result.facts.status}`]
    : [`outcome=${result.outcome}`];
}

async function executeRemote(
  definition: RemoteApiQuotaProviderDefinition,
  directory: string,
  requestTimeoutMs?: number,
): Promise<DefinitionResult> {
  const auth = await resolveQuotaProviderApiKey(definition, directory);
  if (!auth.key) {
    return {
      account: customAccount(definition, [], [fetchError("API key not configured")]),
      check: checkDetail(definition, ["outcome=missing_credential", ...credentialParts(auth)]),
      failure: "API key not configured",
      missingKey: true,
    };
  }

  const result = await fetchRemoteQuotaProvider(definition, auth.key, requestTimeoutMs);
  if (!result.success) {
    return {
      account: customAccount(definition, [], [fetchError(result.error, result.facts)]),
      check: checkDetail(definition, [...failedRequestParts(result), ...credentialParts(auth)]),
      failure: result.error,
    };
  }
  return {
    account: customAccount(
      definition,
      result.rows,
      (result.rowErrors ?? []).map((message) => ({ message })),
    ),
    check: checkDetail(definition, ["outcome=success", ...credentialParts(auth)]),
  };
}

async function executeLocal(
  definition: LocalEstimateQuotaProviderDefinition,
): Promise<DefinitionResult> {
  let rows: ProviderRow[];
  try {
    rows = (await collectLocalQuotaProviderEstimate(definition)).rows;
  } catch {
    const failure = "Failed to read OpenCode's messages";
    return {
      account: customAccount(definition, [], [fetchError(failure)]),
      check: checkDetail(definition, ["outcome=local_read_error"]),
      failure,
    };
  }
  return {
    account: customAccount(definition, rows, []),
    check: checkDetail(definition, ["outcome=success"]),
  };
}

/** A definition whose check threw: its error, and a check that knows nothing more. */
function failedDefinition(definition: QuotaProviderDefinition): DefinitionResult {
  return {
    account: customAccount(definition, [], [fetchError("Provider execution failed")]),
    check: checkDetail(definition, [
      "outcome=network_error",
      ...(definition.mode === "remote-api" ? credentialParts(undefined) : []),
    ]),
    failure: "Provider execution failed",
  };
}

/**
 * One check of one definition now: its rows or errors as its own account, and its check for
 * /quota_status. The provider and the agent's `quota_provider_test` both use it.
 */
export async function checkDefinition(
  definition: QuotaProviderDefinition,
  directory: string,
  requestTimeoutMs?: number,
): Promise<DefinitionResult> {
  try {
    return definition.mode === "remote-api"
      ? await executeRemote(definition, directory, requestTimeoutMs)
      : await executeLocal(definition);
  } catch {
    return failedDefinition(definition);
  }
}

async function resolveQuotaProviderDefinitionAuthIdentity(
  definition: QuotaProviderDefinition,
  directory: string,
): Promise<ResolvedAuthIdentity | null> {
  if (definition.mode === "local-estimate") {
    return deriveResolvedAuthIdentity({
      providerId: `quota-providers:${definition.id}`,
      principal: { kind: "stable-id", value: "local-estimate" },
    });
  }

  const resolved = await resolveQuotaProviderApiKey(
    definition as RemoteApiQuotaProviderDefinition,
    directory,
  );
  return deriveResolvedAuthIdentity({
    providerId: `quota-providers:${definition.id}`,
    principal: resolved.key
      ? { kind: "credential", value: resolved.key }
      : { kind: "stable-id", value: "missing-credential" },
    qualifiers: [definition.providerId],
  });
}

const quotaProvidersCachePolicy: QuotaProviderCachePolicy = {
  kind: "resolved-auth",
  async resolveIdentity(ctx, cacheContext) {
    const definitions = cacheContext.runtimeEligibleQuotaProviders;
    if (!definitions || definitions.length === 0) return null;

    const identities = await Promise.all(
      definitions.map((definition) =>
        resolveQuotaProviderDefinitionAuthIdentity(definition, ctx.locationDirectory),
      ),
    );
    if (identities.some((identity) => identity === null)) return null;

    return composeResolvedAuthIdentities({
      providerId: "quota-providers",
      identities: identities as ResolvedAuthIdentity[],
    });
  },
};

export const quotaProvidersProvider: QuotaProvider = {
  id: QUOTA_PROVIDERS_AGGREGATE_ID,
  cachePolicy: quotaProvidersCachePolicy,

  async isAvailable(ctx): Promise<boolean> {
    if (customQuotaProviderDefinitions(ctx.config.quotaProviders ?? []).length === 0) return false;
    return selectDefinitions(ctx, await ctx.resolveRuntimeProviderIds()).length > 0;
  },

  matchesCurrentModel(model, context): boolean {
    const identity = resolveQuotaProviderSessionModelIdentity({
      currentModel: model,
      currentProviderID: context?.currentProviderID,
    });
    if (!identity) return false;
    return customQuotaProviderDefinitions(context?.quotaProviders ?? []).some(
      (definition) =>
        definition.providerId === identity.providerId &&
        (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
    );
  },

  async fetch(ctx, cacheContext): Promise<ProviderFetchResult> {
    if (customQuotaProviderDefinitions(ctx.config.quotaProviders ?? []).length === 0) {
      return { attempted: false, accounts: [], debug: [] };
    }

    let selected = cacheContext?.runtimeEligibleQuotaProviders;
    if (!selected) {
      let availableProviderIds: ReadonlySet<string>;
      try {
        availableProviderIds = await ctx.resolveRuntimeProviderIds();
      } catch {
        return {
          attempted: true,
          accounts: [
            failedAccount("Custom providers", "Failed to read exact runtime provider identities"),
          ],
          debug: [],
        };
      }
      selected = selectDefinitions(ctx, availableProviderIds);
    }
    if (selected.length === 0) {
      return { attempted: false, accounts: [], debug: [] };
    }

    const results = await mapWithConcurrency(selected, DEFINITION_CONCURRENCY, (definition) =>
      checkDefinition(definition, ctx.locationDirectory, ctx.config.requestTimeoutMs),
    );

    return {
      attempted: true,
      accounts: results.map((result) => result.account),
      debug: results.map((result) => result.check),
    };
  },
};
