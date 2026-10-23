import {
  type CanonicalQuotaProviderId,
  getCanonicalQuotaProviderId,
  normalizeQuotaProviderId,
} from "./provider-metadata.js";

export interface MaintainerAnnouncement {
  id: string;
  message: string;
  url?: string;
  startsAt?: string;
  endsAt: string;
  providerIds?: CanonicalQuotaProviderId[];
}

type MaintainerAnnouncementInactiveReason =
  | "invalid_id"
  | "invalid_message"
  | "invalid_url"
  | "invalid_starts_at"
  | "invalid_ends_at"
  | "not_started"
  | "ended"
  | "invalid_provider_ids"
  | "provider_mismatch";

interface MaintainerAnnouncementEvaluation {
  announcement: MaintainerAnnouncement;
  active: boolean;
  reasons: MaintainerAnnouncementInactiveReason[];
}

export interface MaintainerAnnouncementsSummary {
  source: "bundled_only";
  network: false;
  bundledCount: number;
  activeCount: number;
  futureCount: number;
  expiredCount: number;
  activeAnnouncements: MaintainerAnnouncementEvaluation[];
  evaluations: MaintainerAnnouncementEvaluation[];
}

export const BUNDLED_MAINTAINER_ANNOUNCEMENTS: readonly MaintainerAnnouncement[] = [
  {
    id: "opencode-ecosystem-listing-thumbs-up",
    message: "Help OpenCode list this plugin: add a thumbs-up to issue #38281.",
    url: "https://github.com/anomalyco/opencode/issues/38281",
    startsAt: "2026-09-26T00:00:00.000Z",
    endsAt: "2026-10-26T00:00:00.000Z",
  },
  {
    id: "google-gemini-cli-org-only",
    message:
      "Gemini CLI quota support stays. It only works with Gemini Code Assist Standard or Enterprise (organization) accounts because Google ended personal accounts on 2026-06-18. Personal Google users should use Google AGY.",
    endsAt: "2027-01-01T00:00:00.000Z",
    providerIds: ["google-gemini-cli"],
  },
];

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedProviderIds(providerIds: readonly string[]): CanonicalQuotaProviderId[] {
  const out: CanonicalQuotaProviderId[] = [];
  const seen = new Set<string>();

  for (const providerId of providerIds) {
    const canonicalId = getCanonicalQuotaProviderId(normalizeQuotaProviderId(providerId));
    if (!canonicalId || seen.has(canonicalId)) {
      continue;
    }
    seen.add(canonicalId);
    out.push(canonicalId);
  }

  return out;
}

function isHttpsUrl(value: string | undefined): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function getEndsAtSortValue(announcement: MaintainerAnnouncement): number {
  return parseTimestamp(announcement.endsAt) ?? Number.POSITIVE_INFINITY;
}

function evaluateMaintainerAnnouncements(params?: {
  announcements?: readonly MaintainerAnnouncement[];
  nowMs?: number;
  enabledProviders?: string[] | "auto";
}): MaintainerAnnouncementEvaluation[] {
  const nowMs = params?.nowMs ?? Date.now();
  const enabledProviders = params?.enabledProviders ?? "auto";
  // "auto" is unresolved provider scope here; provider-targeted announcements require
  // callers to pass concrete detected provider IDs.
  const concreteEnabledProviderIds =
    enabledProviders === "auto" ? [] : normalizedProviderIds(enabledProviders);

  return [...(params?.announcements ?? BUNDLED_MAINTAINER_ANNOUNCEMENTS)]
    .map((announcement): MaintainerAnnouncementEvaluation => {
      const reasons: MaintainerAnnouncementInactiveReason[] = [];

      if (!announcement.id.trim()) reasons.push("invalid_id");
      if (!announcement.message.trim()) reasons.push("invalid_message");
      if (announcement.url !== undefined && !isHttpsUrl(announcement.url))
        reasons.push("invalid_url");

      const startsAtMs = parseTimestamp(announcement.startsAt);
      const endsAtMs = parseTimestamp(announcement.endsAt);
      if (announcement.startsAt !== undefined && startsAtMs === undefined)
        reasons.push("invalid_starts_at");
      if (announcement.endsAt !== undefined && endsAtMs === undefined)
        reasons.push("invalid_ends_at");
      if (startsAtMs !== undefined && startsAtMs > nowMs) reasons.push("not_started");
      if (endsAtMs !== undefined && endsAtMs <= nowMs) reasons.push("ended");

      const providerIds = announcement.providerIds;
      const announcementProviderIds = normalizedProviderIds(providerIds ?? []);
      if (providerIds && announcementProviderIds.length === 0) {
        reasons.push("invalid_provider_ids");
      } else if (announcementProviderIds.length > 0) {
        const enabledProviderSet = new Set(concreteEnabledProviderIds);
        if (!announcementProviderIds.some((providerId) => enabledProviderSet.has(providerId))) {
          reasons.push("provider_mismatch");
        }
      }

      return {
        announcement,
        active: reasons.length === 0,
        reasons,
      };
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      const endsAtDelta = getEndsAtSortValue(a.announcement) - getEndsAtSortValue(b.announcement);
      if (endsAtDelta !== 0) return endsAtDelta;
      return a.announcement.id.localeCompare(b.announcement.id);
    });
}

export function getMaintainerAnnouncementsSummary(params?: {
  announcements?: readonly MaintainerAnnouncement[];
  nowMs?: number;
  enabledProviders?: string[] | "auto";
}): MaintainerAnnouncementsSummary {
  const announcements = params?.announcements ?? BUNDLED_MAINTAINER_ANNOUNCEMENTS;
  const evaluations = evaluateMaintainerAnnouncements({ ...params, announcements });
  const activeAnnouncements = evaluations.filter((evaluation) => evaluation.active);

  return {
    source: "bundled_only",
    network: false,
    bundledCount: announcements.length,
    activeCount: activeAnnouncements.length,
    futureCount: evaluations.filter((evaluation) => evaluation.reasons.includes("not_started"))
      .length,
    expiredCount: evaluations.filter((evaluation) => evaluation.reasons.includes("ended")).length,
    activeAnnouncements,
    evaluations,
  };
}
