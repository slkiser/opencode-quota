import { describe, expect, it } from "vite-plus/test";

import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  evaluateMaintainerAnnouncements,
  formatMaintainerAnnouncementHomeCountLine,
  getActiveMaintainerAnnouncements,
  getMaintainerAnnouncementsSummary,
  getMaintainerAnnouncementTargetProviderIds,
  type MaintainerAnnouncement,
} from "../src/lib/maintainer-announcements.js";

const NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");
const BUNDLED_NOW_MS = Date.parse("2026-07-22T12:00:00.000Z");

const BASE_ANNOUNCEMENT = {
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
} satisfies MaintainerAnnouncement;

const ecosystemAnnouncement = {
  id: "opencode-ecosystem-listing-support",
  message: "Support OpenCode Quota's ecosystem listing: review the issue and add a thumbs-up.",
  url: "https://github.com/anomalyco/opencode/issues/38281",
  startsAt: "2026-07-22T00:00:00.000Z",
  endsAt: "2026-08-22T00:00:00.000Z",
} satisfies MaintainerAnnouncement;
const openCode2FeedbackAnnouncement = {
  id: "opencode-2-feedback",
  message:
    "OpenCode 2 support is coming in OpenCode Quota 5.0. Tell us what you want from the OpenCode 2 version.",
  url: "https://github.com/slkiser/opencode-quota/issues/293",
  startsAt: "2026-09-25T00:00:00.000Z",
  endsAt: "2026-11-25T00:00:00.000Z",
} satisfies MaintainerAnnouncement;
const openCode1StayOn4xAnnouncement = {
  id: "opencode-1-stay-on-4x",
  message: 'On OpenCode 1? Run "npx @slkiser/opencode-quota@4 update" to stay on 4.x.',
  url: "https://github.com/slkiser/opencode-quota#updating",
  startsAt: "2026-09-26T00:00:00.000Z",
  endsAt: "2026-11-26T00:00:00.000Z",
} satisfies MaintainerAnnouncement;
const geminiAnnouncement = {
  id: "google-gemini-cli-org-only",
  message:
    "Gemini CLI quota support stays. It only works with Gemini Code Assist Standard or Enterprise (organization) accounts because Google ended personal accounts on 2026-06-18. Personal Google users should use Google AGY.",
  providerIds: ["google-gemini-cli"],
} satisfies MaintainerAnnouncement;

describe("maintainer announcements", () => {
  it("filters active announcements by date, validation, and provider ids", () => {
    const evaluations = evaluateMaintainerAnnouncements({
      nowMs: NOW_MS,
      enabledProviders: ["copilot"],
      announcements: [
        BASE_ANNOUNCEMENT,
        { ...BASE_ANNOUNCEMENT, id: "future", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "expired", endsAt: "2026-05-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "invalid-url", url: "http://example.com" },
        {
          ...BASE_ANNOUNCEMENT,
          id: "wrong-provider",
          providerIds: ["openai"],
        },
        {
          ...BASE_ANNOUNCEMENT,
          id: "targeted",
          providerIds: ["copilot"],
        },
      ],
    });

    expect(
      Object.fromEntries(evaluations.map((item) => [item.announcement.id, item.reasons])),
    ).toMatchObject({
      "copilot-credits": [],
      future: ["not_started"],
      expired: ["ended"],
      "invalid-url": ["invalid_url"],
      "wrong-provider": ["provider_mismatch"],
      targeted: [],
    });
    expect(evaluations.filter((item) => item.active).map((item) => item.announcement.id)).toEqual([
      "copilot-credits",
      "targeted",
    ]);
  });

  it("discovers the ordered union of valid canonical targets from every announcement", () => {
    const announcements: readonly MaintainerAnnouncement[] = [
      { ...BASE_ANNOUNCEMENT, id: "untargeted" },
      {
        ...BASE_ANNOUNCEMENT,
        id: "future-alias",
        startsAt: "2026-06-01T00:00:00.000Z",
        providerIds: ["gemini-cli" as never, "unknown-provider" as never],
      },
      {
        ...BASE_ANNOUNCEMENT,
        id: "expired",
        endsAt: "2026-05-01T00:00:00.000Z",
        providerIds: ["copilot"],
      },
      {
        ...BASE_ANNOUNCEMENT,
        id: "invalid-message",
        message: "",
        providerIds: ["openai", "google-gemini-cli"],
      },
      {
        ...BASE_ANNOUNCEMENT,
        id: "invalid-only",
        providerIds: ["unknown-provider" as never],
      },
    ];

    expect(getMaintainerAnnouncementTargetProviderIds({ announcements })).toEqual([
      "google-gemini-cli",
      "copilot",
      "openai",
    ]);

    const reasonsById = Object.fromEntries(
      evaluateMaintainerAnnouncements({
        announcements,
        enabledProviders: [],
        nowMs: NOW_MS,
      }).map((evaluation) => [evaluation.announcement.id, evaluation.reasons]),
    );
    expect(reasonsById).toMatchObject({
      "future-alias": ["not_started", "provider_mismatch"],
      expired: ["ended", "provider_mismatch"],
      "invalid-message": ["invalid_message", "provider_mismatch"],
      "invalid-only": ["invalid_provider_ids"],
    });
  });

  it("uses bundled targets by default and returns no target for untargeted or invalid-only input", () => {
    expect(getMaintainerAnnouncementTargetProviderIds()).toEqual(["google-gemini-cli"]);
    expect(
      getMaintainerAnnouncementTargetProviderIds({
        announcements: [
          BASE_ANNOUNCEMENT,
          { ...BASE_ANNOUNCEMENT, id: "invalid-only", providerIds: ["invalid" as never] },
        ],
      }),
    ).toEqual([]);
  });

  it("requires concrete provider ids for provider-targeted announcements", () => {
    const autoEvaluations = evaluateMaintainerAnnouncements({
      nowMs: NOW_MS,
      enabledProviders: "auto",
      announcements: [
        {
          ...BASE_ANNOUNCEMENT,
          providerIds: ["copilot"],
        },
      ],
    });
    const active = getActiveMaintainerAnnouncements({
      nowMs: NOW_MS,
      enabledProviders: ["copilot"],
      announcements: [
        {
          ...BASE_ANNOUNCEMENT,
          providerIds: ["copilot"],
        },
      ],
    });

    expect(autoEvaluations).toMatchObject([{ active: false, reasons: ["provider_mismatch"] }]);
    expect(active).toHaveLength(1);
  });

  it("preserves the global OpenCode ecosystem announcement beside the Gemini notice", () => {
    const active = getActiveMaintainerAnnouncements({
      nowMs: BUNDLED_NOW_MS,
      enabledProviders: "auto",
    });

    expect(BUNDLED_MAINTAINER_ANNOUNCEMENTS).toEqual([
      ecosystemAnnouncement,
      openCode2FeedbackAnnouncement,
      openCode1StayOn4xAnnouncement,
      geminiAnnouncement,
    ]);
    expect(active).toEqual([
      {
        announcement: ecosystemAnnouncement,
        active: true,
        reasons: [],
      },
    ]);
  });

  it("targets the Gemini CLI organization-only notice to Gemini configurations and aliases", () => {
    const getActiveIds = (enabledProviders: string[]) =>
      getActiveMaintainerAnnouncements({
        nowMs: BUNDLED_NOW_MS,
        enabledProviders,
      }).map((item) => item.announcement.id);

    expect(getActiveIds(["google-gemini-cli"])).toEqual([
      "opencode-ecosystem-listing-support",
      "google-gemini-cli-org-only",
    ]);
    expect(getActiveIds(["gemini-cli"])).toEqual([
      "opencode-ecosystem-listing-support",
      "google-gemini-cli-org-only",
    ]);
    expect(getActiveIds(["google-agy"])).toEqual(["opencode-ecosystem-listing-support"]);
  });

  it("shows the OpenCode 2 feedback notice to everyone only during its two-month window", () => {
    const evaluateAt = (iso: string, enabledProviders: string[] | "auto" = "auto") =>
      evaluateMaintainerAnnouncements({ nowMs: Date.parse(iso), enabledProviders }).find(
        (item) => item.announcement.id === "opencode-2-feedback",
      );
    const getActiveIds = (iso: string, enabledProviders: string[] | "auto") =>
      getActiveMaintainerAnnouncements({ nowMs: Date.parse(iso), enabledProviders }).map(
        (item) => item.announcement.id,
      );

    expect(evaluateAt("2026-09-24T23:59:59.999Z")?.reasons).toEqual(["not_started"]);
    expect(evaluateAt("2026-09-25T00:00:00.000Z")).toEqual({
      announcement: openCode2FeedbackAnnouncement,
      active: true,
      reasons: [],
    });
    expect(evaluateAt("2026-11-24T23:59:59.999Z", ["google-agy"])?.active).toBe(true);
    expect(evaluateAt("2026-11-25T00:00:00.000Z")?.reasons).toEqual(["ended"]);

    expect(getActiveIds("2026-10-15T12:00:00.000Z", "auto")).toEqual([
      "opencode-2-feedback",
      "opencode-1-stay-on-4x",
    ]);
    expect(getActiveIds("2026-10-15T12:00:00.000Z", ["google-gemini-cli"])).toEqual([
      "opencode-2-feedback",
      "opencode-1-stay-on-4x",
      "google-gemini-cli-org-only",
    ]);
    expect(getActiveIds("2026-11-25T00:00:00.000Z", "auto")).toEqual(["opencode-1-stay-on-4x"]);
  });

  it("tells OpenCode 1 users to pin 4.x to everyone only during its two-month window", () => {
    const evaluateAt = (iso: string, enabledProviders: string[] | "auto" = "auto") =>
      evaluateMaintainerAnnouncements({ nowMs: Date.parse(iso), enabledProviders }).find(
        (item) => item.announcement.id === "opencode-1-stay-on-4x",
      );

    expect(evaluateAt("2026-09-25T23:59:59.999Z")?.reasons).toEqual(["not_started"]);
    expect(evaluateAt("2026-09-26T00:00:00.000Z")).toEqual({
      announcement: openCode1StayOn4xAnnouncement,
      active: true,
      reasons: [],
    });
    expect(evaluateAt("2026-11-25T23:59:59.999Z", ["google-agy"])?.active).toBe(true);
    expect(evaluateAt("2026-11-26T00:00:00.000Z")?.reasons).toEqual(["ended"]);
    expect(openCode1StayOn4xAnnouncement.message.split(/\s+/).length).toBeLessThanOrEqual(15);
    expect(
      getMaintainerAnnouncementsSummary({
        nowMs: Date.parse("2026-10-15T12:00:00.000Z"),
        enabledProviders: "auto",
      }).activeCount,
    ).toBe(2);
    expect(formatMaintainerAnnouncementHomeCountLine(2)).toBe(
      "Notice: 2 maintainer announcements available. Run /quota_announcements.",
    );
  });

  it("sorts active announcements before inactive, then by end date and id", () => {
    const evaluations = evaluateMaintainerAnnouncements({
      nowMs: NOW_MS,
      announcements: [
        { ...BASE_ANNOUNCEMENT, id: "z-last", endsAt: "2026-06-10T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "inactive", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "a-first", endsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "b-first", endsAt: "2026-06-01T00:00:00.000Z" },
      ],
    });

    expect(evaluations.map((item) => item.announcement.id)).toEqual([
      "a-first",
      "b-first",
      "z-last",
      "inactive",
    ]);
  });

  it("summarizes bundled-only counts without state", () => {
    const summary = getMaintainerAnnouncementsSummary({
      nowMs: NOW_MS,
      enabledProviders: ["copilot"],
      announcements: [
        BASE_ANNOUNCEMENT,
        { ...BASE_ANNOUNCEMENT, id: "future", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "expired", endsAt: "2026-05-01T00:00:00.000Z" },
      ],
    });

    expect(summary).toMatchObject({
      source: "bundled_only",
      network: false,
      bundledCount: 3,
      activeCount: 1,
      futureCount: 1,
      expiredCount: 1,
    });
    expect(summary.activeAnnouncements.map((item) => item.announcement.id)).toEqual([
      "copilot-credits",
    ]);
  });

  it("formats PRD-exact count-only TUI home lines", () => {
    expect(formatMaintainerAnnouncementHomeCountLine(0)).toBe("");
    expect(formatMaintainerAnnouncementHomeCountLine(1)).toBe(
      "Notice: Maintainer announcement available. Run /quota_announcements.",
    );
    expect(formatMaintainerAnnouncementHomeCountLine(3)).toBe(
      "Notice: 3 maintainer announcements available. Run /quota_announcements.",
    );
  });
});
