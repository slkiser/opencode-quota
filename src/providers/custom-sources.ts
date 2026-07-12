import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderDiagnostic,
  QuotaProviderMatchContext,
  QuotaProviderResult,
} from "../lib/entries.js";
import type { CustomSourceConfig } from "../lib/custom-sources.js";

import {
  CUSTOM_SOURCE_CONCURRENCY,
  fetchCustomSource,
  mapWithConcurrency,
  resolveCustomSourceApiKey,
} from "../lib/custom-sources-runtime.js";

export const CUSTOM_SOURCES_PROVIDER_ID = "custom-sources";

function resolveSessionModelIdentity(params: {
  currentModel: string;
  currentProviderID?: string;
}): { providerId: string; fullModel: string } | null {
  const slashIndex = params.currentModel.indexOf("/");
  if (slashIndex === -1) {
    if (!params.currentProviderID || params.currentModel.length === 0) return null;
    return {
      providerId: params.currentProviderID,
      fullModel: `${params.currentProviderID}/${params.currentModel}`,
    };
  }
  if (slashIndex === 0 || slashIndex === params.currentModel.length - 1) return null;

  const providerId = params.currentModel.slice(0, slashIndex);
  if (params.currentProviderID && params.currentProviderID !== providerId) return null;
  return { providerId, fullModel: params.currentModel };
}

export function selectEligibleCustomSources(params: {
  sources: readonly CustomSourceConfig[];
  availableProviderIds: ReadonlySet<string>;
  onlyCurrentModel?: boolean;
  currentModel?: string;
  currentProviderID?: string;
}): CustomSourceConfig[] {
  const runtimeEligible = params.sources.filter((source) =>
    params.availableProviderIds.has(source.providerId),
  );
  if (!params.onlyCurrentModel) return runtimeEligible;

  const currentModel = params.currentModel;
  const currentProviderID = params.currentProviderID;

  if (!currentModel) {
    if (!currentProviderID) return [];
    return runtimeEligible.filter(
      (source) => source.providerId === currentProviderID && source.modelIds === undefined,
    );
  }

  const identity = resolveSessionModelIdentity({
    currentModel,
    currentProviderID,
  });
  if (!identity) return [];

  return runtimeEligible.filter(
    (source) =>
      source.providerId === identity.providerId &&
      (source.modelIds === undefined || source.modelIds.includes(identity.fullModel)),
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
    context?.customSources?.some(
      (source) =>
        source.providerId === identity.providerId &&
        (source.modelIds === undefined || source.modelIds.includes(identity.fullModel)),
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
  source: CustomSourceConfig,
): Pick<
  QuotaProviderDiagnostic,
  "sourceId" | "providerId" | "preset" | "modelIds" | "apiKeyEnv" | "selected"
> {
  return {
    sourceId: source.id,
    providerId: source.providerId,
    preset: source.preset,
    modelIds: source.modelIds ? [...source.modelIds] : null,
    apiKeyEnv: source.apiKeyEnv ?? null,
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

async function executeSource(
  source: CustomSourceConfig,
  requestTimeoutMs?: number,
): Promise<InstanceResult> {
  const auth = await resolveCustomSourceApiKey(source);
  if (!auth.key) {
    const message = "API key not configured";
    return {
      entries: [],
      errors: [{ label: source.label, message }],
      diagnostic: {
        ...buildDiagnosticIdentity(source),
        attempted: false,
        credentialSource: null,
        outcome: "missing_credential",
        entryCount: 0,
        checkedPaths: [...auth.checkedPaths],
        authPaths: [...auth.authPaths],
      },
    };
  }

  const result = await fetchCustomSource(source, auth.key, requestTimeoutMs);
  if (!result.success) {
    return {
      entries: [],
      errors: [{ label: source.label, message: result.error }],
      diagnostic: {
        ...buildDiagnosticIdentity(source),
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
      accounting: {
        ...entry.accounting,
        sourceId: source.id,
      },
    })),
    errors: [],
    diagnostic: {
      ...buildDiagnosticIdentity(source),
      attempted: true,
      credentialSource: mapCredentialSource(auth.source),
      outcome: "success",
      entryCount: result.entries.length,
      checkedPaths: [...auth.checkedPaths],
      authPaths: [...auth.authPaths],
    },
  };
}

export const customSourcesProvider: QuotaProvider = {
  id: CUSTOM_SOURCES_PROVIDER_ID,

  async isAvailable(ctx): Promise<boolean> {
    const configuredSources = ctx.config.customSources ?? [];
    if (configuredSources.length === 0) return false;
    const availableProviderIds = await getAvailableProviderIds(ctx);
    return (
      selectEligibleCustomSources({
        sources: configuredSources,
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
    const configuredSources = ctx.config.customSources ?? [];
    if (configuredSources.length === 0) {
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
            label: "Custom sources",
            message: "Failed to read exact runtime provider identities",
          },
        ],
      };
    }

    const sources = selectEligibleCustomSources({
      sources: configuredSources,
      availableProviderIds,
      onlyCurrentModel: ctx.config.onlyCurrentModel,
      currentModel: ctx.config.currentModel,
      currentProviderID: ctx.config.currentProviderID,
    });
    if (sources.length === 0) {
      return { attempted: false, entries: [], errors: [] };
    }

    const results = await mapWithConcurrency(sources, CUSTOM_SOURCE_CONCURRENCY, async (source) => {
      try {
        return await executeSource(source, ctx.config.requestTimeoutMs);
      } catch {
        const message = "Source execution failed";
        return {
          entries: [],
          errors: [{ label: source.label, message }],
          diagnostic: {
            ...buildDiagnosticIdentity(source),
            attempted: true,
            credentialSource: null,
            outcome: "network_error",
            entryCount: 0,
            checkedPaths: [],
            authPaths: [],
          },
        } satisfies InstanceResult;
      }
    });

    return {
      attempted: true,
      entries: results.flatMap((result) => result.entries),
      errors: results.flatMap((result) => result.errors),
      diagnostics: results.map((result) => result.diagnostic),
    };
  },
};
