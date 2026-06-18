import { describe, expect, it } from "vitest";

import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  evaluateMaintainerAnnouncements,
  formatMaintainerAnnouncementHomeCountLine,
  getActiveMaintainerAnnouncements,
  getMaintainerAnnouncementsSummary,
  type MaintainerAnnouncement,
} from "../src/lib/maintainer-announcements.js";

const NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");
const BUNDLED_NOW_MS = Date.parse("2026-06-13T12:00:00.000Z");

const BASE_ANNOUNCEMENT = {
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
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

    expect(Object.fromEntries(evaluations.map((item) => [item.announcement.id, item.reasons]))).toMatchObject({
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

  it("bundles current provider-scoped Gemini and Copilot announcements", () => {
    const geminiActive = getActiveMaintainerAnnouncements({
      nowMs: BUNDLED_NOW_MS,
      enabledProviders: ["google-gemini-cli"],
    });
    const copilotActive = getActiveMaintainerAnnouncements({
      nowMs: BUNDLED_NOW_MS,
      enabledProviders: ["copilot"],
    });
    const openaiActive = getActiveMaintainerAnnouncements({
      nowMs: BUNDLED_NOW_MS,
      enabledProviders: ["openai"],
    });

    expect(BUNDLED_MAINTAINER_ANNOUNCEMENTS).toHaveLength(2);
    expect(geminiActive.map((item) => item.announcement.id)).toEqual([
      "gemini-cli-antigravity-transition-feedback",
    ]);
    expect(geminiActive[0]?.announcement).toMatchObject({
      message:
        "Gemini CLI transition: individual usage stops June 18, 2026 as users move to Antigravity CLI. Tell us if you want Antigravity CLI or companion plugin support next.",
      url: "https://github.com/slkiser/opencode-quota/issues/125",
      startsAt: "2026-06-13T00:00:00.000Z",
      endsAt: "2026-06-19T00:00:00.000Z",
      providerIds: ["google-gemini-cli"],
    });
    expect(copilotActive.map((item) => item.announcement.id)).toEqual([
      "copilot-github-ai-credits-feedback",
    ]);
    expect(copilotActive[0]?.announcement).toMatchObject({
      message:
        "Copilot billing update: usage-based billing with GitHub AI Credits is live as of June 1, 2026. Tell us what opencode-quota should track next.",
      url: "https://github.com/slkiser/opencode-quota/issues/126",
      startsAt: "2026-06-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:00:00.000Z",
      providerIds: ["copilot"],
    });
    expect(openaiActive).toEqual([]);
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
    expect(summary.activeAnnouncements.map((item) => item.announcement.id)).toEqual(["copilot-credits"]);
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
