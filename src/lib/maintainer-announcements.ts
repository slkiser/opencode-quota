import {
  getQuotaProviderShape,
  normalizeQuotaProviderId,
  type CanonicalQuotaProviderId,
} from "./provider-metadata.js";

export interface MaintainerAnnouncement {
  id: string;
  message: string;
  url?: string;
  startsAt?: string;
  endsAt?: string;
  providerIds?: CanonicalQuotaProviderId[];
}

export type MaintainerAnnouncementInactiveReason =
  | "invalid_id"
  | "invalid_message"
  | "invalid_url"
  | "invalid_starts_at"
  | "invalid_ends_at"
  | "not_started"
  | "ended"
  | "invalid_provider_ids"
  | "provider_mismatch";

export interface MaintainerAnnouncementEvaluation {
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
    id: "gemini-cli-antigravity-transition-feedback",
    message:
      "Gemini CLI transition: individual usage stops June 18, 2026 as users move to Antigravity CLI. Tell us if you want Antigravity CLI or companion plugin support next.",
    url: "https://github.com/slkiser/opencode-quota/issues/125",
    startsAt: "2026-06-13T00:00:00.000Z",
    endsAt: "2026-06-19T00:00:00.000Z",
    providerIds: ["google-gemini-cli"],
  },
  {
    id: "copilot-github-ai-credits-feedback",
    message:
      "Copilot billing update: usage-based billing with GitHub AI Credits is live as of June 1, 2026. Tell us what opencode-quota should track next.",
    url: "https://github.com/slkiser/opencode-quota/issues/126",
    startsAt: "2026-06-01T00:00:00.000Z",
    endsAt: "2026-08-01T00:00:00.000Z",
    providerIds: ["copilot"],
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
    const shape = getQuotaProviderShape(normalizeQuotaProviderId(providerId));
    if (!shape || seen.has(shape.id)) {
      continue;
    }
    seen.add(shape.id);
    out.push(shape.id);
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

export function evaluateMaintainerAnnouncements(params?: {
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
      if (announcement.url !== undefined && !isHttpsUrl(announcement.url)) reasons.push("invalid_url");

      const startsAtMs = parseTimestamp(announcement.startsAt);
      const endsAtMs = parseTimestamp(announcement.endsAt);
      if (announcement.startsAt !== undefined && startsAtMs === undefined) reasons.push("invalid_starts_at");
      if (announcement.endsAt !== undefined && endsAtMs === undefined) reasons.push("invalid_ends_at");
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

export function getActiveMaintainerAnnouncements(params?: {
  announcements?: readonly MaintainerAnnouncement[];
  nowMs?: number;
  enabledProviders?: string[] | "auto";
}): MaintainerAnnouncementEvaluation[] {
  return evaluateMaintainerAnnouncements(params).filter((evaluation) => evaluation.active);
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
    futureCount: evaluations.filter((evaluation) => evaluation.reasons.includes("not_started")).length,
    expiredCount: evaluations.filter((evaluation) => evaluation.reasons.includes("ended")).length,
    activeAnnouncements,
    evaluations,
  };
}

export function formatMaintainerAnnouncementHomeCountLine(activeCount: number): string {
  if (activeCount <= 0) return "";
  if (activeCount === 1) {
    return "Notice: Maintainer announcement available. Run /quota_announcements.";
  }
  return `Notice: ${activeCount} maintainer announcements available. Run /quota_announcements.`;
}
