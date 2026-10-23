import {
  type CanonicalQuotaProviderId,
  QUOTA_PROVIDER_REGISTRATION_SOURCE,
  type QuotaProviderRegistrationSourceEntry,
} from "./provider-registration.js";

export type { CanonicalQuotaProviderId } from "./provider-registration.js";

interface QuotaProviderCatalogEntry {
  label: string;
  labelAliases: readonly string[];
  runtimeIds: readonly string[];
  synonyms: readonly string[];
}

const REGISTRATIONS: readonly QuotaProviderRegistrationSourceEntry[] =
  QUOTA_PROVIDER_REGISTRATION_SOURCE;
const CANONICAL_IDS = new Set(REGISTRATIONS.map(({ id }) => id));

function isCanonicalQuotaProviderId(value: string): value is CanonicalQuotaProviderId {
  return CANONICAL_IDS.has(value);
}

function catalogEntry(source: QuotaProviderRegistrationSourceEntry): QuotaProviderCatalogEntry {
  return {
    label: source.label,
    labelAliases: [...(source.labelAliases ?? [])],
    runtimeIds: [...source.runtimeIds],
    synonyms: [...source.synonyms],
  };
}

/** Every provider in registration order. */
export const QUOTA_PROVIDER_CATALOG = Object.fromEntries(
  REGISTRATIONS.map((source) => [source.id, catalogEntry(source)]),
) as Readonly<Record<CanonicalQuotaProviderId, QuotaProviderCatalogEntry>>;

const CATALOG = Object.entries(QUOTA_PROVIDER_CATALOG) as Array<
  [CanonicalQuotaProviderId, QuotaProviderCatalogEntry]
>;

export const QUOTA_PROVIDER_RUNTIME_IDS = Object.fromEntries(
  CATALOG.map(([id, entry]) => [id, entry.runtimeIds]),
) as Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

/** The v6 row keys each provider may emit; see `rowKeys` in provider-registration.ts. */
export const PROVIDER_ROW_KEYS = Object.fromEntries(
  REGISTRATIONS.map(({ id, rowKeys }) => [id, rowKeys]),
) as Readonly<Record<CanonicalQuotaProviderId, readonly string[]>>;

const GROUP_BRANDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  REGISTRATIONS.map(({ id, label, groupBrands }) => [id, groupBrands ?? [label]]),
);

/** Labels by provider id and by label alias. */
const LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => [id, ...entry.labelAliases].map((name) => [name, entry.label])),
);

const SYNONYMS: Readonly<Record<string, string>> = Object.fromEntries(
  CATALOG.flatMap(([id, entry]) => entry.synonyms.map((synonym) => [synonym, id])),
);

const LIVE_LOCAL_USAGE_IDS = new Set(
  REGISTRATIONS.filter((s) => s.liveLocalUsage).map((s) => s.id),
);

/** Trimmed, lowercase, and a synonym ("claude") turned into its provider id ("anthropic"). */
export function normalizeQuotaProviderId(id: string): string {
  const normalized = id.trim().toLowerCase();
  return SYNONYMS[normalized] ?? normalized;
}

/** The provider id for an id or synonym ("claude" → "anthropic"); none for an unknown id. */
export function getCanonicalQuotaProviderId(id: string): CanonicalQuotaProviderId | undefined {
  const normalized = normalizeQuotaProviderId(id);
  return isCanonicalQuotaProviderId(normalized) ? normalized : undefined;
}

/** The provider's label; an unknown id is shown as given. */
export function getQuotaProviderDisplayLabel(id: string): string {
  return LABELS[normalizeQuotaProviderId(id)] ?? id;
}

/** The OpenCode provider ids that count as this provider (narrower than its synonyms). */
export function getQuotaProviderRuntimeIds(id: string): readonly string[] {
  const providerId = getCanonicalQuotaProviderId(id);
  return providerId ? [...new Set(QUOTA_PROVIDER_RUNTIME_IDS[providerId])] : [];
}

export function getQuotaProviderIdsForRuntimeId(id: string): readonly CanonicalQuotaProviderId[] {
  const normalized = id.trim().toLowerCase();
  return CATALOG.filter(([, entry]) => entry.runtimeIds.includes(normalized)).map(([id]) => id);
}

/** Brand words at the start of the provider's account names; none for an unknown id. */
export function getQuotaProviderGroupBrands(providerId: string): readonly string[] {
  return Object.hasOwn(GROUP_BRANDS, providerId) ? (GROUP_BRANDS[providerId] ?? []) : [];
}

export function isLiveLocalUsageProviderId(id: string): boolean {
  return LIVE_LOCAL_USAGE_IDS.has(normalizeQuotaProviderId(id));
}
