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
  MAINTAINED_LOCAL_ESTIMATE_IDS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
} from "../lib/quota-providers.js";
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

function isMaintainedTuning(definition: QuotaProviderDefinition): boolean {
  return (MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(definition.id);
}

function customDefinitions(
  definitions: readonly QuotaProviderDefinition[],
): QuotaProviderDefinition[] {
  return definitions.filter((definition) => !isMaintainedTuning(definition));
}

function resolveSessionModelIdentity(params: {
  currentModel: string;
  currentProviderID?: string;
}): { providerId: string; modelId: string } | null {
  const slashIndex = params.currentModel.indexOf("/");
  if (slashIndex === -1) {
    if (!params.currentProviderID || params.currentModel.length === 0) return null;
    return { providerId: params.currentProviderID, modelId: params.currentModel };
  }
  if (slashIndex === 0 || slashIndex === params.currentModel.length - 1) return null;
  const providerId = params.currentModel.slice(0, slashIndex);
  if (params.currentProviderID && params.currentProviderID !== providerId) return null;
  return { providerId, modelId: params.currentModel.slice(slashIndex + 1) };
}

export function selectEligibleQuotaProviders(params: {
  definitions: readonly QuotaProviderDefinition[];
  availableProviderIds: ReadonlySet<string>;
  onlyCurrentModel?: boolean;
  currentModel?: string;
  currentProviderID?: string;
}): QuotaProviderDefinition[] {
  const runtimeEligible = customDefinitions(params.definitions).filter((definition) =>
    params.availableProviderIds.has(definition.providerId),
  );
  if (!params.onlyCurrentModel) return runtimeEligible;

  if (!params.currentModel) {
    if (!params.currentProviderID) return [];
    return runtimeEligible.filter(
      (definition) =>
        definition.providerId === params.currentProviderID && definition.modelIds === undefined,
    );
  }

  const identity = resolveSessionModelIdentity({
    currentModel: params.currentModel,
    currentProviderID: params.currentProviderID,
  });
  if (!identity) return [];

  return runtimeEligible.filter(
    (definition) =>
      definition.providerId === identity.providerId &&
      (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
  );
}

function matchesConfiguredCurrentSelection(
  model: string,
  context?: QuotaProviderMatchContext,
): boolean {
  const identity = resolveSessionModelIdentity({
    currentModel: model,
    currentProviderID: context?.currentProviderID,
  });
  if (!identity) return false;
  return Boolean(
    customDefinitions(context?.quotaProviders ?? []).some(
      (definition) =>
        definition.providerId === identity.providerId &&
        (definition.modelIds === undefined || definition.modelIds.includes(identity.modelId)),
    ),
  );
}

async function getAvailableProviderIds(ctx: QuotaProviderContext): Promise<Set<string>> {
  const response = await ctx.client.config.providers();
  return new Set((response.data?.providers ?? []).map((provider) => provider.id));
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
    errors: [],
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

async function executeDefinition(
  definition: QuotaProviderDefinition,
  requestTimeoutMs?: number,
): Promise<InstanceResult> {
  if (definition.mode === "remote-api") {
    return executeRemote(definition, requestTimeoutMs);
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
    if (customDefinitions(definitions).length === 0) return false;
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
    if (customDefinitions(definitions).length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    let availableProviderIds: Set<string>;
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
          return await executeDefinition(definition, ctx.config.requestTimeoutMs);
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
