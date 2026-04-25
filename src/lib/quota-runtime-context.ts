import type { LoadConfigMeta } from "./config.js";
import type { QuotaProvider, QuotaProviderContext } from "./entries.js";
import type { QuotaToastConfig } from "./types.js";
import type { RuntimeContextRootHints, RuntimeContextRoots } from "./config-file-utils.js";

import { createLoadConfigMeta, loadConfig } from "./config.js";
import { getProviders } from "../providers/registry.js";
import { resolveRuntimeContextRoots } from "./config-file-utils.js";

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
}

export interface QuotaRuntimeContext {
  client: QuotaRuntimeClient;
  roots: RuntimeContextRoots;
  config: QuotaToastConfig;
  configMeta: LoadConfigMeta;
  providers: QuotaProvider[];
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

  return {
    client: params.client,
    roots,
    config,
    configMeta,
    providers: params.providers ?? getProviders(),
    session: {
      sessionID: params.sessionID,
      sessionMeta,
    },
  };
}

export function createQuotaRuntimeRequestContext(
  runtime: Pick<QuotaRuntimeContext, "session">,
): {
  sessionID?: string;
  sessionMeta?: QuotaSessionModelContext;
} {
  return {
    sessionID: runtime.session.sessionID,
    sessionMeta: runtime.session.sessionMeta,
  };
}

export function createQuotaProviderRuntimeContext(
  runtime: Pick<QuotaRuntimeContext, "client" | "config" | "session">,
): QuotaProviderContext {
  return {
    client: runtime.client,
    config: {
      googleModels: runtime.config.googleModels,
      anthropicBinaryPath: runtime.config.anthropicBinaryPath,
      alibabaCodingPlanTier: runtime.config.alibabaCodingPlanTier,
      cursorPlan: runtime.config.cursorPlan,
      cursorIncludedApiUsd: runtime.config.cursorIncludedApiUsd,
      cursorBillingCycleStartDay: runtime.config.cursorBillingCycleStartDay,
      onlyCurrentModel: runtime.config.onlyCurrentModel,
      currentModel: runtime.session.sessionMeta?.modelID,
      currentProviderID: runtime.session.sessionMeta?.providerID,
    },
  };
}
