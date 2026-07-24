import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderDiagnostic,
  QuotaProviderMatchContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import type {
  QuotaProviderDefinition,
  RemoteApiQuotaProviderDefinition,
} from "../lib/quota-providers.js";
import {
  QUOTA_PROVIDERS_AGGREGATE_ID,
  customQuotaProviderDefinitions,
  resolveQuotaProviderSessionModelIdentity,
  selectEligibleQuotaProviderDefinitions,
} from "../lib/quota-providers.js";
import { fetchQuotaProviderResult } from "../lib/quota-state.js";
import {
  QUOTA_PROVIDER_CONCURRENCY,
  fetchRemoteQuotaProvider,
  mapWithConcurrency,
  resolveQuotaProviderApiKey,
} from "../lib/quota-providers-remote.js";
import {
  collectLocalQuotaProviderEstimate,
  inspectLocalQuotaProviderState,
} from "../lib/quota-providers-local.js";

export const QUOTA_PROVIDERS_PROVIDER_ID = QUOTA_PROVIDERS_AGGREGATE_ID;
export const selectEligibleQuotaProviders = selectEligibleQuotaProviderDefinitions;

function matchesConfiguredCurrentSelection(
  model: string,
  context?: QuotaProviderMatchContext,
): boolean {
  const identity = resolveQuotaProviderSessionModelIdentity({
    currentModel: model,
    currentProviderID: context?.currentProviderID,
  });
  if (!identity) return false;
  return Boolean(
    customQuotaProviderDefinitions(context?.quotaProviders ?? []).some(
      (definition) =>
        definition.providerId === identity.providerId &&
        (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
    ),
  );
}

async function getAvailableProviderIds(ctx: QuotaProviderContext): Promise<ReadonlySet<string>> {
  return ctx.resolveRuntimeProviderIds();
}

type InstanceResult = {
  entries: QuotaProviderResult["entries"];
  errors: QuotaProviderResult["errors"];
  diagnostic: QuotaProviderDiagnostic;
};

function buildDiagnosticIdentity(
  definition: QuotaProviderDefinition,
): Pick<
  QuotaProviderDiagnostic,
  "sourceId" | "providerId" | "mode" | "format" | "modelIds" | "apiKeyEnv" | "selected"
> {
  return {
    sourceId: definition.id,
    providerId: definition.providerId,
    mode: definition.mode,
    ...(definition.mode === "remote-api" ? { format: definition.format } : {}),
    modelIds: definition.modelIds ? [...definition.modelIds] : null,
    apiKeyEnv: definition.mode === "remote-api" ? (definition.apiKeyEnv ?? null) : null,
    selected: true,
  };
}

function mapCredentialSource(
  source: "env" | "opencode.json" | "opencode.jsonc" | "auth.json" | null,
): QuotaProviderDiagnostic["credentialSource"] {
  switch (source) {
    case "env":
      return "explicit_env";
    case "opencode.json":
      return "global_opencode_json";
    case "opencode.jsonc":
      return "global_opencode_jsonc";
    case "auth.json":
      return "auth_json";
    default:
      return null;
  }
}

function classifyRuntimeError(
  error: string,
): Pick<QuotaProviderDiagnostic, "outcome" | "httpStatus"> {
  if (error === "Redirect rejected") return { outcome: "redirect_error" };
  if (error.startsWith("Request timeout after ")) return { outcome: "timeout" };
  if (error === "Response exceeded 262144 bytes") return { outcome: "body_too_large" };
  if (error === "Expected a JSON response") return { outcome: "invalid_content_type" };
  if (error === "Invalid JSON response") return { outcome: "invalid_json" };
  if (error.startsWith("Invalid ")) return { outcome: "invalid_response" };
  const status = /^HTTP (\d+)$/.exec(error);
  if (status) return { outcome: "http_error", httpStatus: Number(status[1]) };
  return { outcome: "network_error" };
}

async function executeRemote(
  definition: RemoteApiQuotaProviderDefinition,
  requestTimeoutMs?: number,
): Promise<InstanceResult> {
  const auth = await resolveQuotaProviderApiKey(definition);
  if (!auth.key) {
    return {
      entries: [],
      errors: [{ label: definition.label, message: "API key not configured" }],
      diagnostic: {
        ...buildDiagnosticIdentity(definition),
        attempted: false,
        credentialSource: null,
        outcome: "missing_credential",
        entryCount: 0,
        checkedPaths: [...auth.checkedPaths],
        authPaths: [...auth.authPaths],
      },
    };
  }

  const result = await fetchRemoteQuotaProvider(definition, auth.key, requestTimeoutMs);
  if (!result.success) {
    return {
      entries: [],
      errors: [{ label: definition.label, message: result.error }],
      diagnostic: {
        ...buildDiagnosticIdentity(definition),
        attempted: true,
        credentialSource: mapCredentialSource(auth.source),
        ...classifyRuntimeError(result.error),
        entryCount: 0,
        checkedPaths: [...auth.checkedPaths],
        authPaths: [...auth.authPaths],
      },
    };
  }

  return {
    entries: result.entries.map((entry) => ({
      ...entry,
      accounting: { ...entry.accounting, sourceId: definition.id },
    })),
    errors: (result.rowErrors ?? []).map((message) => ({
      label: definition.label,
      message,
    })),
    diagnostic: {
      ...buildDiagnosticIdentity(definition),
      attempted: true,
      credentialSource: mapCredentialSource(auth.source),
      outcome: "success",
      entryCount: result.entries.length,
      checkedPaths: [...auth.checkedPaths],
      authPaths: [...auth.authPaths],
    },
  };
}

async function executeRemoteWithCache(
  definition: RemoteApiQuotaProviderDefinition,
  ctx: QuotaProviderContext,
): Promise<InstanceResult> {
  const remoteProvider: QuotaProvider = {
    id: `${QUOTA_PROVIDERS_PROVIDER_ID}:${definition.id}`,
    isAvailable: async () => true,
    fetch: async () => {
      const result = await executeRemote(definition, ctx.config.requestTimeoutMs);
      return {
        attempted: result.diagnostic.attempted,
        entries: result.entries,
        errors: result.errors,
        diagnostics: [result.diagnostic],
      };
    },
  };
  const result = await fetchQuotaProviderResult({
    provider: remoteProvider,
    ctx: {
      ...ctx,
      config: {
        ...ctx.config,
        quotaProviders: [definition],
      },
    },
    ttlMs: ctx.config.providerCacheTtlMs ?? 0,
  });
  return {
    entries: result.entries,
    errors: result.errors,
    diagnostic: result.diagnostics?.[0] ?? {
      ...buildDiagnosticIdentity(definition),
      attempted: true,
      credentialSource: null,
      outcome: "network_error",
      entryCount: 0,
      checkedPaths: [],
      authPaths: [],
    },
  };
}

async function executeDefinition(
  definition: QuotaProviderDefinition,
  ctx: QuotaProviderContext,
): Promise<InstanceResult> {
  if (definition.mode === "remote-api") {
    return executeRemoteWithCache(definition, ctx);
  }

  try {
    const result = await collectLocalQuotaProviderEstimate(definition);
    const state = await inspectLocalQuotaProviderState(definition);
    return {
      entries: result.entries,
      errors: [],
      diagnostic: {
        ...buildDiagnosticIdentity(definition),
        attempted: true,
        credentialSource: null,
        outcome: "success",
        entryCount: result.entries.length,
        checkedPaths: [],
        authPaths: [],
        statePath: state.path,
        stateHealth: state.health,
        stateVersion: state.version,
        stateLastUpdatedAt: state.lastUpdatedAt,
      },
    };
  } catch {
    const state = await inspectLocalQuotaProviderState(definition);
    return {
      entries: [],
      errors: [{ label: definition.label, message: "Failed to update local accounting state" }],
      diagnostic: {
        ...buildDiagnosticIdentity(definition),
        attempted: true,
        credentialSource: null,
        outcome: "local_state_error",
        entryCount: 0,
        checkedPaths: [],
        authPaths: [],
        statePath: state.path,
        stateHealth: state.health,
        stateVersion: state.version,
        stateLastUpdatedAt: state.lastUpdatedAt,
      },
    };
  }
}

export const quotaProvidersProvider: QuotaProvider = {
  id: QUOTA_PROVIDERS_PROVIDER_ID,

  async isAvailable(ctx): Promise<boolean> {
    const definitions = ctx.config.quotaProviders ?? [];
    if (customQuotaProviderDefinitions(definitions).length === 0) return false;
    const availableProviderIds = await getAvailableProviderIds(ctx);
    return (
      selectEligibleQuotaProviders({
        definitions,
        availableProviderIds,
        onlyCurrentModel: ctx.config.onlyCurrentModel,
        currentModel: ctx.config.currentModel,
        currentProviderID: ctx.config.currentProviderID,
      }).length > 0
    );
  },

  matchesCurrentModel(model, context): boolean {
    return matchesConfiguredCurrentSelection(model, context);
  },

  async fetch(ctx): Promise<QuotaProviderResult> {
    const definitions = ctx.config.quotaProviders ?? [];
    if (customQuotaProviderDefinitions(definitions).length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    let availableProviderIds: ReadonlySet<string>;
    try {
      availableProviderIds = await getAvailableProviderIds(ctx);
    } catch {
      return {
        attempted: true,
        entries: [],
        errors: [
          {
            label: "Quota providers",
            message: "Failed to read exact runtime provider identities",
          },
        ],
      };
    }

    const selected = selectEligibleQuotaProviders({
      definitions,
      availableProviderIds,
      onlyCurrentModel: ctx.config.onlyCurrentModel,
      currentModel: ctx.config.currentModel,
      currentProviderID: ctx.config.currentProviderID,
    });
    if (selected.length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    const results = await mapWithConcurrency(
      selected,
      QUOTA_PROVIDER_CONCURRENCY,
      async (definition) => {
        try {
          return await executeDefinition(definition, ctx);
        } catch {
          return {
            entries: [],
            errors: [{ label: definition.label, message: "Provider execution failed" }],
            diagnostic: {
              ...buildDiagnosticIdentity(definition),
              attempted: true,
              credentialSource: null,
              outcome: "network_error",
              entryCount: 0,
              checkedPaths: [],
              authPaths: [],
            },
          } satisfies InstanceResult;
        }
      },
    );

    return {
      attempted: true,
      entries: results.flatMap((result) => result.entries),
      errors: results.flatMap((result) => result.errors),
      diagnostics: results.map((result) => result.diagnostic),
    };
  },
};
