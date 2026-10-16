/**
 * The /quota_status report of the slash command, the `quota_status` tool and
 * `opencode-quota status`, and the quota lines of `opencode-quota show`. Each reads the server
 * settings the host holds now.
 */
import {
  loadProviderSource,
  type ProviderSourceHost,
  providerContext,
} from "../core/provider-source.js";
import { matchesQuotaProviderCurrentSelection } from "../core/selection.js";
import { createQuotaStore } from "../core/store.js";
import type { DebugDetail, ProviderSnapshot, QuotaSnapshot, SessionModel } from "../core/types.js";
import { type UsageReport, usageReport } from "../core/usage.js";
import { resolveOpenRouterApiKey } from "../providers/openrouter.js";
import { getProviders } from "../providers/registry.js";
import {
  apiKeyStatusDetails,
  simpleApiKeyStatusDetails,
  vendorKeyDetails,
} from "../providers/result-helpers.js";
import type { V5Conversion } from "../settings/index.js";
import { PROVIDER_IDS } from "../settings/schema.js";
import { DEFAULT_WORDS } from "../view/format.js";
import { type RowSettings, type SurfaceRows, visibleGroups } from "../view/select.js";
import { plainLines } from "../view/text.js";
import {
  API_KEY_VENDORS,
  type ApiKeyLoginSpec,
  getApiKeyLoginDiagnostics,
  readVendorKeys,
} from "./api-key-resolver.js";
import { inspectCursorAuthPresence } from "./cursor-detection.js";
import { isCursorProviderId } from "./cursor-pricing.js";
import { sanitizeDisplayText } from "./display-sanitize.js";
import type { QuotaProvider, QuotaProviderContext } from "./entries.js";
import { getMaintainerAnnouncementsSummary } from "./maintainer-announcements.js";
import {
  describePriceList,
  type PricingSnapshotSource,
  refreshPricesIfDue,
} from "./modelsdev-pricing.js";
import { getCredentialSourceDiagnostics } from "./opencode-auth.js";
import { getQuotaProviderDisplayLabel, getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import {
  buildQuotaStatusReportDocument,
  knownProviderIds,
  publicPricingMeta,
  type StatusOrigin,
  statusPathText,
} from "./quota-status.js";
import { renderPlainTextReport } from "./report-document.js";

/** `opencode-quota show` lists every row of every provider. */
const EVERY_ROW: SurfaceRows = { enabled: true, hidden: [], providerOrder: [], rowOrder: {} };
const EVERY_ROW_SETTINGS: RowSettings = {
  labels: {},
  window: {},
  surfaces: { sidebar: EVERY_ROW, collapsed: EVERY_ROW, statusLine: EVERY_ROW, toast: EVERY_ROW },
};

/**
 * The quota lines `opencode-quota show` prints, in the snapshot's words: a line per row (with
 * "runs out in …" when the quota runs out before its reset), a line per provider problem, then the session's
 * tokens when the snapshot has them.
 */
export function quotaReportLines(snapshot: QuotaSnapshot, nowMs: number): string[] {
  const words = snapshot.words ?? DEFAULT_WORDS;
  const groups = visibleGroups(snapshot, EVERY_ROW_SETTINGS, "toast", words);
  const sessionTokens = snapshot.sessionTokens ? { sessionTokens: snapshot.sessionTokens } : {};
  return plainLines({ groups, words, nowMs, runsOut: true, ...sessionTokens }).map(
    sanitizeDisplayText,
  );
}

/** `opencode-quota status --json`: the format version, then what the report says, as data. */
interface QuotaStatusReportPayload {
  version: "6";
  generatedAt: string;
  /** Where the settings come from and what they say about providers and prices. */
  config: {
    settingsPath: string;
    settingsFileExists: boolean;
    enabledProviders: string[] | "auto";
    onlyCurrentModel: boolean;
    pricingSnapshotSource: PricingSnapshotSource;
  };
  providers: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  pricing: {
    selection: PricingSnapshotSource;
    activeSource: string;
    snapshot: { source: string; generatedAt: string | null; units: string };
    snapshotPath: string;
    refreshStatePath: string;
  };
  /** One per enabled and available provider: ok when its check had no error. */
  liveProbes: Array<{ id: string; ok: boolean }>;
}

/**
 * A fresh check of every enabled and available provider (or only `providerId`), through a
 * store of its own that keeps nothing: the same providers, rows, errors and debug details the
 * plugin's store would hold.
 */
export async function checkProviders(
  host: ProviderSourceHost,
  providerId?: string,
): Promise<QuotaSnapshot> {
  const store = createQuotaStore({ source: () => loadProviderSource(host), file: null });
  try {
    const providerIds = providerId ? [providerId] : undefined;
    const snapshot = await store.refresh({ reason: "manual", providerIds });
    const providers = snapshot.providers.filter(
      (provider: ProviderSnapshot) => !providerId || provider.providerId === providerId,
    );
    return { ...snapshot, providers };
  } finally {
    await store.dispose();
  }
}

type ProviderCheck = { provider: QuotaProvider; enabled: boolean; available: boolean };

async function isAvailable(provider: QuotaProvider, ctx: QuotaProviderContext): Promise<boolean> {
  try {
    return await provider.isAvailable(ctx);
  } catch {
    return false;
  }
}

/**
 * Where an API-key provider (and Cursor) looked for its key, from local reads only, with the
 * same details its own check writes: whether a key is set, its source, and the files checked.
 * Nothing for a provider without an API key.
 */
async function apiKeySetupDetails(providerId: string): Promise<DebugDetail[]> {
  if (Object.hasOwn(API_KEY_VENDORS, providerId)) {
    const vendor: ApiKeyLoginSpec = API_KEY_VENDORS[providerId as keyof typeof API_KEY_VENDORS];
    return vendor.skipBrokenLogins
      ? vendorKeyDetails(vendor, await readVendorKeys(vendor))
      : apiKeyStatusDetails(await getApiKeyLoginDiagnostics(vendor));
  }
  if (providerId === "openrouter") {
    const resolved = await resolveOpenRouterApiKey();
    return simpleApiKeyStatusDetails({
      configured: Boolean(resolved.key),
      source: resolved.source,
      checkedPaths: resolved.checkedPaths,
      credentialDatabasePaths: resolved.credentialDatabasePaths,
    });
  }
  if (providerId === "cursor") {
    const auth = await inspectCursorAuthPresence();
    return [
      { key: "auth_state", value: auth.state },
      { key: "auth_selected_path", value: auth.selectedPath ?? "(none)" },
      { key: "auth_present_paths", value: auth.presentPaths.join(" | ") || "(none)" },
      { key: "auth_candidate_paths", value: auth.candidatePaths.join(" | ") || "(none)" },
    ];
  }
  return [];
}

/**
 * What an unavailable provider's setup looks like, from local checks only: whether OpenCode
 * lists the provider and, for an API-key provider, where its key was looked for. No quota
 * request is made.
 */
async function localSetupDetails(
  providerId: string,
  ctx: QuotaProviderContext,
): Promise<DebugDetail[]> {
  const details: DebugDetail[] = [];
  const runtimeIds = getQuotaProviderRuntimeIds(providerId);
  if (runtimeIds.length > 0) {
    let listed: string;
    try {
      const openCodeIds = await ctx.resolveRuntimeProviderIds();
      const found = runtimeIds.filter((id) => openCodeIds.has(id));
      listed =
        found.length > 0 ? `yes found=${found.join(",")}` : `no looked_for=${runtimeIds.join(",")}`;
    } catch {
      listed = "unreadable";
    }
    details.push({ key: "opencode_provider", value: listed });
  }
  try {
    details.push(...(await apiKeySetupDetails(providerId)));
  } catch {
    details.push({ key: "api_key_configured", value: "unreadable" });
  }
  return details;
}

/**
 * A fresh check of every known provider (or only `providerId`) for /quota_status. The plugin's
 * source decides which providers are enabled and available; those are checked through a store
 * of its own that keeps nothing, as the plugin's store would check them. An unavailable
 * provider shows its local setup details instead, and one turned off in the settings is never
 * fetched.
 */
async function checkKnownProviders(
  host: ProviderSourceHost,
  providerId: string | undefined,
): Promise<{ checks: ProviderCheck[]; snapshots: ProviderSnapshot[] }> {
  const source = await loadProviderSource(host);
  const sourceIds = new Set(source.providers.map((provider) => provider.id));
  const ctx = providerContext(host);
  const { enabledProviders } = ctx.config;
  const turnedOn = (id: string) => enabledProviders === "auto" || enabledProviders.includes(id);
  const known = getProviders().filter((provider) => !providerId || provider.id === providerId);
  const checks = await Promise.all(
    known.map(async (provider): Promise<ProviderCheck> => {
      if (sourceIds.has(provider.id)) return { provider, enabled: true, available: true };
      if (turnedOn(provider.id)) return { provider, enabled: true, available: false };
      return { provider, enabled: false, available: await isAvailable(provider, ctx) };
    }),
  );

  const setupSnapshots = checks
    .filter((check) => !check.available && turnedOn(check.provider.id))
    .map(async ({ provider }): Promise<ProviderSnapshot> => ({
      providerId: provider.id,
      label: getQuotaProviderDisplayLabel(provider.id),
      rows: [],
      refreshing: false,
      debug: await localSetupDetails(provider.id, ctx),
    }));
  const store = createQuotaStore({ source: async () => source, file: null });
  try {
    const knownIds = new Set(known.map((provider) => provider.id));
    const snapshot = await store.refresh({ reason: "manual", providerIds: [...knownIds] });
    const checked = snapshot.providers.filter((provider) => knownIds.has(provider.providerId));
    return { checks, snapshots: [...checked, ...(await Promise.all(setupSnapshots))] };
  } finally {
    await store.dispose();
  }
}

/** The last 30 days of usage, for the models without a price; null when it can't be read. */
async function readRecentUsage(nowMs: number): Promise<UsageReport | null> {
  try {
    return await usageReport({ range: "30d" }, nowMs);
  } catch {
    return null;
  }
}

export async function buildStatusReportData(params: {
  host: ProviderSourceHost;
  origin: StatusOrigin;
  /** OpenCode's version and release channel; the CLI runs without OpenCode. */
  opencode?: { version: string; channel: string };
  sessionID?: string;
  /** The session's model; undefined without a session. */
  sessionModel?: SessionModel;
  /** The v5 settings conversion this server wrote when it started. */
  conversion?: V5Conversion;
  generatedAtMs: number;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
  /** When set, restrict provider availability and live checks to this provider id. */
  providerFilterId?: string;
}): Promise<{
  output: string;
  payload: QuotaStatusReportPayload;
  hasComparableProviderData: boolean;
}> {
  const { host } = params;
  const loaded = host.settings();
  const { settings } = loaded;
  await refreshPricesIfDue();

  const currentModel = params.sessionModel?.id;
  const currentProviderID = params.sessionModel?.providerID;
  const sessionModelLookup: "ok" | "not_found" | "no_session" = !params.sessionID
    ? "no_session"
    : currentModel
      ? "ok"
      : "not_found";

  const { enabledProviders, automaticDiscovery, quotaProviders } = providerContext(
    host,
    loaded,
  ).config;
  const [{ checks, snapshots }, usage] = await Promise.all([
    checkKnownProviders(host, params.providerFilterId),
    readRecentUsage(params.generatedAtMs),
  ]);
  const availability = checks.map(({ provider, enabled, available }) => ({
    id: provider.id,
    enabled,
    available,
    matchesCurrentModel:
      currentModel || isCursorProviderId(currentProviderID)
        ? matchesQuotaProviderCurrentSelection({
            provider,
            currentModel,
            currentProviderID,
            enabledProviders,
            automaticDiscovery,
            quotaProviders,
          })
        : undefined,
  }));

  await params.onDetectedProviderIds?.(
    availability.filter((item) => item.enabled && item.available).map((item) => item.id),
  );
  const checkedIds = new Set(
    availability.filter((item) => item.enabled && item.available).map((item) => item.id),
  );
  const checked = snapshots.filter((provider) => checkedIds.has(provider.providerId));

  const announcementProviderIds = availability
    .filter((item) => item.enabled && item.available)
    .map((item) => item.id);
  const maintainerAnnouncementsSummary = getMaintainerAnnouncementsSummary({
    enabledProviders: announcementProviderIds,
  });

  const document = await buildQuotaStatusReportDocument({
    origin: params.origin,
    opencode: params.opencode,
    settings: loaded,
    conversion: loaded.conversion ?? params.conversion,
    workspaceRoot: host.workspaceRoot,
    enabledProviders:
      settings.providers.off.length === 0
        ? "auto"
        : PROVIDER_IDS.filter((id) => !settings.providers.off.includes(id)),
    offProviders: settings.providers.off,
    quotaProviders: settings.providers.custom,
    pricingSnapshotSource: settings.providers.pricing.source,
    currentModel,
    currentProviderID,
    sessionModelLookup,
    providerAvailability: availability,
    providers: snapshots,
    credentialSource: getCredentialSourceDiagnostics(),
    maintainerAnnouncements: {
      summary: maintainerAnnouncementsSummary,
    },
    usage,
    generatedAtMs: params.generatedAtMs,
  });

  // The payload follows the report's closed vocabulary: known ids, fixed words, known paths.
  const priceList = await describePriceList();
  const pricingMeta = publicPricingMeta(priceList);
  const payload: QuotaStatusReportPayload = {
    version: "6",
    generatedAt: new Date(params.generatedAtMs).toISOString(),
    config: {
      settingsPath: statusPathText(loaded.path),
      settingsFileExists: loaded.exists,
      enabledProviders: knownProviderIds(
        settings.providers.off.length === 0
          ? "auto"
          : PROVIDER_IDS.filter((id) => !settings.providers.off.includes(id)),
      ),
      onlyCurrentModel: settings.words.onlyCurrentModel,
      pricingSnapshotSource: settings.providers.pricing.source,
    },
    providers: availability,
    pricing: {
      selection: settings.providers.pricing.source,
      activeSource: priceList.source,
      snapshot: {
        source: pricingMeta.source,
        // "(none)" and "(invalid date)" are no time.
        generatedAt: /^\d/u.test(pricingMeta.generatedAt) ? pricingMeta.generatedAt : null,
        units: pricingMeta.units,
      },
      snapshotPath: statusPathText(priceList.paths.snapshot),
      refreshStatePath: statusPathText(priceList.paths.refreshState),
    },
    liveProbes: checked.map((provider) => ({
      id: provider.providerId,
      ok: provider.error === undefined,
    })),
  };

  return {
    output: renderPlainTextReport(document),
    payload,
    hasComparableProviderData: checked.some((provider) => provider.rows.length > 0),
  };
}

/** The /quota_status report as text. */
export async function buildQuotaDialogCommandOutput(params: {
  host: ProviderSourceHost;
  origin: StatusOrigin;
  opencode?: { version: string; channel: string };
  sessionID?: string;
  /** The session's model, for /quota_status. */
  resolveSessionModel?: (sessionID: string) => Promise<SessionModel>;
  /** The v5 settings conversion this server wrote when it started. */
  conversion?: V5Conversion;
  generatedAtMs?: number;
  onDetectedProviderIds?: (providerIds: string[]) => Promise<void>;
}): Promise<{ output: string }> {
  const generatedAtMs = params.generatedAtMs ?? Date.now();
  const sessionModel =
    params.sessionID && params.resolveSessionModel
      ? await params.resolveSessionModel(params.sessionID)
      : undefined;
  const data = await buildStatusReportData({
    host: params.host,
    origin: params.origin,
    opencode: params.opencode,
    sessionID: params.sessionID,
    sessionModel,
    conversion: params.conversion,
    generatedAtMs,
    onDetectedProviderIds: params.onDetectedProviderIds,
  });
  return { output: data.output };
}
