import { createHash } from "node:crypto";
import { getProviders } from "../providers/registry.js";
import type { LoadConfigMeta } from "./config.js";
import { createLoadConfigMeta, loadConfig } from "./config.js";
import type { RuntimeContextRootHints, RuntimeContextRoots } from "./config-file-utils.js";
import { resolveRuntimeContextRoots } from "./config-file-utils.js";
import type { QuotaProvider, QuotaProviderContext } from "./entries.js";
import { cloneQuotaProviders } from "./quota-providers.js";
import { configureQuotaTelemetry } from "./quota-telemetry.js";
import {
  createRuntimeProviderIdResolver,
  type RuntimeProviderIdResolver,
} from "./runtime-provider-ids.js";
import type { QuotaToastConfig } from "./types.js";

export type QuotaRuntimeClient = NonNullable<Parameters<typeof loadConfig>[0]> &
  QuotaProviderContext["client"];

export interface QuotaSessionModelContext {
  modelID?: string;
  providerID?: string;
}

export interface ResolveQuotaRuntimeContextParams {
  client: QuotaRuntimeClient;
  roots: RuntimeContextRootHints;
  config?: QuotaToastConfig;
  sessionID?: string;
  sessionMeta?: QuotaSessionModelContext;
  resolveSessionMeta?: (sessionID: string) => Promise<QuotaSessionModelContext>;
  includeSessionMeta?: boolean | ((config: QuotaToastConfig) => boolean);
  configMeta?: LoadConfigMeta;
  providers?: QuotaProvider[];
  configureTelemetry?: boolean;
}

export interface QuotaRuntimeContext {
  client: QuotaRuntimeClient;
  roots: RuntimeContextRoots;
  config: QuotaToastConfig;
  configMeta: LoadConfigMeta;
  providers: QuotaProvider[];
  resolveRuntimeProviderIds: RuntimeProviderIdResolver;
  session: {
    sessionID?: string;
    sessionMeta?: QuotaSessionModelContext;
  };
}

export function shouldIncludeSessionMeta(params: {
  config: QuotaToastConfig;
  includeSessionMeta?: ResolveQuotaRuntimeContextParams["includeSessionMeta"];
}): boolean {
  if (typeof params.includeSessionMeta === "function") {
    return params.includeSessionMeta(params.config);
  }

  return params.includeSessionMeta === true;
}

export async function resolveQuotaRuntimeContext(
  params: ResolveQuotaRuntimeContextParams,
): Promise<QuotaRuntimeContext> {
  const roots = resolveRuntimeContextRoots(params.roots);
  const configMeta = params.configMeta ?? createLoadConfigMeta();
  const config =
    params.config ??
    (await loadConfig(params.client, configMeta, {
      configRootDir: roots.configRoot,
    }));
  const providers = params.providers ?? getProviders();
  const resolveRuntimeProviderIds = createRuntimeProviderIdResolver(params.client);
  let sessionMeta = params.sessionMeta;
  if (
    !sessionMeta &&
    params.sessionID &&
    params.resolveSessionMeta &&
    shouldIncludeSessionMeta({
      config,
      includeSessionMeta: params.includeSessionMeta,
    })
  ) {
    sessionMeta = await params.resolveSessionMeta(params.sessionID);
  }
  if (params.configureTelemetry !== false) {
    configureRuntimeTelemetry({
      client: params.client,
      config,
      session: { sessionMeta },
      providers,
      resolveRuntimeProviderIds,
    });
  }

  return {
    client: params.client,
    roots,
    config,
    configMeta,
    providers,
    resolveRuntimeProviderIds,
    session: {
      sessionID: params.sessionID,
      sessionMeta,
    },
  };
}

export function createQuotaRuntimeRequestContext(runtime: Pick<QuotaRuntimeContext, "session">): {
  sessionID?: string;
  sessionMeta?: QuotaSessionModelContext;
} {
  return {
    sessionID: runtime.session.sessionID,
    sessionMeta: runtime.session.sessionMeta,
  };
}

export function createQuotaProviderRuntimeContext(runtime: {
  client: QuotaRuntimeClient;
  config: QuotaToastConfig;
  session: QuotaRuntimeContext["session"];
  resolveRuntimeProviderIds: RuntimeProviderIdResolver;
  configMeta?: Pick<LoadConfigMeta, "settingSources">;
  providers?: QuotaProvider[];
  configureTelemetry?: boolean;
}): QuotaProviderContext {
  const context: QuotaProviderContext = {
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    config: {
      googleModels: runtime.config.googleModels,
      anthropicBinaryPath: runtime.config.anthropicBinaryPath,
      cursorPlan: runtime.config.cursorPlan,
      cursorIncludedApiUsd: runtime.config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: runtime.config.cursorBillingCycleStartDay,
      opencodeGoWindows: runtime.config.opencodeGoWindows,
      opencodeMonthlyLimit: runtime.config.opencodeMonthlyLimit,
      requestTimeoutMs: runtime.config.requestTimeoutMs,
      providerCacheTtlMs: runtime.config.minIntervalMs,
      requestTimeoutMsConfigured: Boolean(runtime.configMeta?.settingSources.requestTimeoutMs),
      onlyCurrentModel: runtime.config.onlyCurrentModel,
      enabledProviders:
        runtime.config.enabledProviders === "auto" ? "auto" : [...runtime.config.enabledProviders],
      quotaProviders: cloneQuotaProviders(runtime.config.quotaProviders),
      nineRouter: {
        ...runtime.config.nineRouter,
        providers: [...runtime.config.nineRouter.providers],
      },
      currentModel: runtime.session.sessionMeta?.modelID,
      currentProviderID: runtime.session.sessionMeta?.providerID,
    },
  };
  if (runtime.configureTelemetry !== false) {
    context.config.telemetryToken = configureRuntimeTelemetry({
      ...runtime,
      providers: runtime.providers ?? getProviders(),
      context,
    });
  }
  return context;
}

function configureRuntimeTelemetry(runtime: {
  client: QuotaRuntimeClient;
  config: QuotaToastConfig;
  session: QuotaRuntimeContext["session"];
  providers: QuotaProvider[];
  resolveRuntimeProviderIds: RuntimeProviderIdResolver;
  context?: QuotaProviderContext;
}) {
  const context =
    runtime.context ??
    createQuotaProviderRuntimeContext({
      ...runtime,
      configureTelemetry: false,
    });
  const enabledProviders = runtime.providers.filter(
    (provider) =>
      runtime.config.enabledProviders === "auto" ||
      runtime.config.enabledProviders.includes(provider.id),
  );
  const telemetryEnabled = runtime.config.enabled && runtime.config.telemetry?.enabled === true;
  const telemetryIdentity = createHash("sha256")
    .update(
      JSON.stringify([
        "quota-telemetry-config-v1",
        runtime.config.enabled,
        runtime.config.telemetry?.enabled === true,
        runtime.config.enabledProviders === "auto"
          ? "auto"
          : [...runtime.config.enabledProviders].sort(),
        runtime.config.quotaProviders,
        runtime.config.googleModels,
        runtime.config.anthropicBinaryPath,
        runtime.config.cursorPlan,
        runtime.config.cursorIncludedApiUsd,
        runtime.config.cursorBillingCycleStartDay,
        runtime.config.opencodeGoWindows,
        runtime.config.opencodeMonthlyLimit,
        runtime.config.onlyCurrentModel,
        enabledProviders.map((provider) => [provider.id, provider.cacheIdentity?.(context) ?? ""]),
        runtime.session.sessionMeta?.providerID,
        runtime.session.sessionMeta?.modelID,
      ]),
    )
    .digest("hex");
  return configureQuotaTelemetry({
    owner: runtime.client,
    enabled: telemetryEnabled,
    identity: telemetryIdentity,
  });
}
