/**
 * The /quota_status report of the slash command, the `quota_status` tool, the TUI and
 * `opencode-quota status`, and the quota lines of `opencode-quota show`. Each reads the server
 * settings the host holds now.
 */
import {
  loadProviderSource,
  type ProviderSourceHost,
  providerContext,
  registeredProviders,
} from "../core/provider-source.js";
import { matchesQuotaProviderCurrentSelection } from "../core/selection.js";
import { createQuotaStore } from "../core/store.js";
import type { DebugDetail, ProviderSnapshot, QuotaSnapshot, SessionModel } from "../core/types.js";
import { type UsageReport, usageReport } from "../core/usage.js";
import { cursorAuthDetails } from "../providers/cursor.js";
import { resolveOpenRouterApiKey } from "../providers/openrouter.js";
import {
  apiKeyStatusDetails,
  simpleApiKeyStatusDetails,
  vendorKeyDetails,
} from "../providers/result-helpers.js";
import type { V5Conversion } from "../settings/index.js";
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
import { refreshPricesIfDue } from "./modelsdev-pricing.js";
import { getCredentialSourceDiagnostics } from "./opencode-auth.js";
import { getQuotaProviderDisplayLabel, getQuotaProviderRuntimeIds } from "./provider-metadata.js";
import {
  type QuotaStatusReport,
  renderQuotaStatusReport,
  type StatusOrigin,
} from "./quota-status.js";

/** `opencode-quota show` lists every row of every provider. */
const EVERY_ROW: SurfaceRows = { hidden: [], providerOrder: [], rowOrder: {} };
const EVERY_ROW_SETTINGS: RowSettings = {
  sidebar: EVERY_ROW,
  collapsed: EVERY_ROW,
  statusLine: EVERY_ROW,
  toast: EVERY_ROW,
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
async function apiKeySetupDetails(providerId: string, directory: string): Promise<DebugDetail[]> {
  if (Object.hasOwn(API_KEY_VENDORS, providerId)) {
    const vendor: ApiKeyLoginSpec = API_KEY_VENDORS[providerId as keyof typeof API_KEY_VENDORS];
    return vendor.skipBrokenLogins
      ? vendorKeyDetails(vendor, await readVendorKeys(vendor, directory), directory)
      : apiKeyStatusDetails(await getApiKeyLoginDiagnostics(vendor, directory));
  }
  if (providerId === "openrouter") {
    const resolved = await resolveOpenRouterApiKey(directory);
    return simpleApiKeyStatusDetails({
      configured: Boolean(resolved.key),
      source: resolved.source,
      checkedPaths: resolved.checkedPaths,
      credentialDatabasePaths: resolved.credentialDatabasePaths,
    });
  }
  if (providerId === "cursor") return cursorAuthDetails(await inspectCursorAuthPresence());
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
    details.push(...(await apiKeySetupDetails(providerId, ctx.locationDirectory)));
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
  ctx: QuotaProviderContext,
  providerId: string | undefined,
  model?: SessionModel,
): Promise<{ checks: ProviderCheck[]; snapshots: ProviderSnapshot[] }> {
  const source = await loadProviderSource(host, model);
  const sourceIds = new Set(source.providers.map((provider) => provider.id));
  const { enabledProviders } = ctx.config;
  const turnedOn = (id: string) => enabledProviders.includes(id);
  const known = registeredProviders(host).filter(
    (provider) => !providerId || provider.id === providerId,
  );
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

/**
 * The Quota Status report of /quota_status, the `quota_status` tool, the TUI Plugin tab and
 * `opencode-quota status`: the settings read once, every known provider (or only
 * `onlyProviderId`) checked fresh, then the text and the `status --json` payload made from
 * the same facts.
 */
export async function statusReport(
  host: ProviderSourceHost,
  options: {
    origin: StatusOrigin;
    /** OpenCode's version and release channel; the CLI runs without OpenCode. */
    opencode?: { version: string; channel: string };
    /** The session's model; undefined without a session. */
    sessionModel?: SessionModel;
    /** The v5 settings conversion this server wrote when it started. */
    conversion?: V5Conversion;
    /** Only this provider is listed and checked. */
    onlyProviderId?: string;
    nowMs: number;
  },
): Promise<QuotaStatusReport> {
  const loaded = host.settings();
  const held: ProviderSourceHost = { ...host, settings: () => loaded };
  await refreshPricesIfDue();

  const ctx = providerContext(held, loaded, options.sessionModel);
  const { enabledProviders, automaticDiscovery, quotaProviders } = ctx.config;
  const [{ checks, snapshots }, usage] = await Promise.all([
    checkKnownProviders(held, ctx, options.onlyProviderId, options.sessionModel),
    readRecentUsage(options.nowMs),
  ]);
  const currentModel = options.sessionModel?.id;
  const currentProviderID = options.sessionModel?.providerID;
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
  const checkedIds = availability
    .filter((item) => item.enabled && item.available)
    .map((item) => item.id);

  return renderQuotaStatusReport({
    origin: options.origin,
    opencode: options.opencode,
    settings: loaded,
    conversion: loaded.conversion ?? options.conversion,
    workspaceRoot: host.workspaceRoot,
    sessionModel: options.sessionModel,
    providerAvailability: availability,
    providers: snapshots,
    credentialSource: getCredentialSourceDiagnostics(),
    maintainerAnnouncements: {
      summary: getMaintainerAnnouncementsSummary({ enabledProviders: checkedIds }),
    },
    usage,
    generatedAtMs: options.nowMs,
  });
}
