import type { DebugDetail } from "../core/types.js";
import type {
  QuotaProvider,
  QuotaProviderCachePolicy,
  QuotaProviderContext,
} from "../lib/entries.js";
import { mapWithConcurrency } from "../lib/map-with-concurrency.js";
import {
  collectLocalQuotaProviderEstimate,
  inspectLocalQuotaProviderState,
  type LocalQuotaProviderStateDiagnostics,
} from "../lib/quota-providers-local.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  type QuotaProviderAuthSource,
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

/** One definition's account, and its check for /quota_status. */
type DefinitionResult = { account: AccountResult; check: DebugDetail };

/**
 * A definition's rows and errors as its own account: the definition id is the login, and each
 * row id is `custom.<definition id>.<key>`.
 */
export function customAccount(
  definition: QuotaProviderDefinition,
  rows: readonly ProviderRow[],
  errors: readonly string[],
): AccountResult {
  return {
    name: definition.label,
    login: definition.id,
    rows: rows.map((row) => ({ ...row, key: `custom.${definition.id}.${row.key}` })),
    errors: errors.map((message) => ({ message })),
  };
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

function stateParts(state: LocalQuotaProviderStateDiagnostics | undefined): string[] {
  const lastUpdate = state?.lastUpdatedAt;
  return [
    `state_health=${state?.health ?? "missing"}`,
    `state_version=${state?.version ?? "(none)"}`,
    `state_last_update=${lastUpdate ? new Date(lastUpdate).toISOString() : "(none)"}`,
  ];
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

/** The outcome of a failed request, for example "outcome=http_error http_status=503". */
function failedRequestParts(error: string): string[] {
  if (error === "Redirect rejected") return ["outcome=redirect_error"];
  if (error.startsWith("Request timeout after ")) return ["outcome=timeout"];
  if (error === "Response exceeded 262144 bytes") return ["outcome=body_too_large"];
  if (error === "Expected a JSON response") return ["outcome=invalid_content_type"];
  if (error === "Invalid JSON response") return ["outcome=invalid_json"];
  if (error.startsWith("Invalid ")) return ["outcome=invalid_response"];
  const status = /^HTTP (\d+)$/.exec(error);
  if (status) return ["outcome=http_error", `http_status=${status[1]}`];
  return ["outcome=network_error"];
}

async function executeRemote(
  definition: RemoteApiQuotaProviderDefinition,
  requestTimeoutMs?: number,
): Promise<DefinitionResult> {
  const auth = await resolveQuotaProviderApiKey(definition);
  if (!auth.key) {
    return {
      account: customAccount(definition, [], ["API key not configured"]),
      check: checkDetail(definition, ["outcome=missing_credential", ...credentialParts(auth)]),
    };
  }

  const result = await fetchRemoteQuotaProvider(definition, auth.key, requestTimeoutMs);
  if (!result.success) {
    return {
      account: customAccount(definition, [], [result.error]),
      check: checkDetail(definition, [
        ...failedRequestParts(result.error),
        ...credentialParts(auth),
      ]),
    };
  }
  return {
    account: customAccount(definition, result.rows, result.rowErrors ?? []),
    check: checkDetail(definition, ["outcome=success", ...credentialParts(auth)]),
  };
}

async function executeLocal(
  definition: LocalEstimateQuotaProviderDefinition,
): Promise<DefinitionResult> {
  let rows: ProviderRow[] | null;
  try {
    rows = (await collectLocalQuotaProviderEstimate(definition)).rows;
  } catch {
    rows = null;
  }
  const state = await inspectLocalQuotaProviderState(definition);
  if (!rows) {
    return {
      account: customAccount(definition, [], ["Failed to update local accounting state"]),
      check: checkDetail(definition, ["outcome=local_state_error", ...stateParts(state)]),
    };
  }
  return {
    account: customAccount(definition, rows, []),
    check: checkDetail(definition, ["outcome=success", ...stateParts(state)]),
  };
}

/** A definition whose check threw: its error, and a check that knows nothing more. */
function failedDefinition(definition: QuotaProviderDefinition): DefinitionResult {
  return {
    account: customAccount(definition, [], ["Provider execution failed"]),
    check: checkDetail(definition, [
      "outcome=network_error",
      ...(definition.mode === "remote-api" ? credentialParts(undefined) : stateParts(undefined)),
    ]),
  };
}

async function resolveQuotaProviderDefinitionAuthIdentity(
  definition: QuotaProviderDefinition,
): Promise<ResolvedAuthIdentity | null> {
  if (definition.mode === "local-estimate") {
    return deriveResolvedAuthIdentity({
      providerId: `quota-providers:${definition.id}`,
      principal: { kind: "stable-id", value: "local-estimate" },
    });
  }

  const resolved = await resolveQuotaProviderApiKey(definition as RemoteApiQuotaProviderDefinition);
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
  async resolveIdentity(_ctx, cacheContext) {
    const definitions = cacheContext.runtimeEligibleQuotaProviders;
    if (!definitions || definitions.length === 0) return null;

    const identities = await Promise.all(
      definitions.map(resolveQuotaProviderDefinitionAuthIdentity),
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

    const results = await mapWithConcurrency(
      selected,
      DEFINITION_CONCURRENCY,
      async (definition): Promise<DefinitionResult> => {
        try {
          return definition.mode === "remote-api"
            ? await executeRemote(definition, ctx.config.requestTimeoutMs)
            : await executeLocal(definition);
        } catch {
          return failedDefinition(definition);
        }
      },
    );

    return {
      attempted: true,
      accounts: results.map((result) => result.account),
      debug: results.map((result) => result.check),
    };
  },
};
