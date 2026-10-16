import { describe, expect, it } from "vite-plus/test";

import {
  BUNDLED_MAINTAINER_ANNOUNCEMENTS,
  getMaintainerAnnouncementsSummary,
  type MaintainerAnnouncement,
} from "../src/lib/maintainer-announcements.js";

const NOW_MS = Date.parse("2026-05-21T12:00:00.000Z");

const BASE_ANNOUNCEMENT = {
  id: "copilot-credits",
  message: "If you use Copilot, GitHub billing is moving to AI Credits.",
  url: "https://github.blog/example",
  endsAt: "2026-07-01T00:00:00.000Z",
} satisfies MaintainerAnnouncement;

function evaluate(
  announcements: readonly MaintainerAnnouncement[],
  enabledProviders: string[] | "auto",
) {
  return getMaintainerAnnouncementsSummary({ nowMs: NOW_MS, enabledProviders, announcements })
    .evaluations;
}

describe("maintainer announcements", () => {
  it("gives every bundled notice a valid end date", () => {
    expect(BUNDLED_MAINTAINER_ANNOUNCEMENTS).toHaveLength(2);
    for (const announcement of BUNDLED_MAINTAINER_ANNOUNCEMENTS) {
      expect(typeof announcement.endsAt).toBe("string");
      expect(Number.isFinite(Date.parse(announcement.endsAt))).toBe(true);
      if (announcement.startsAt) {
        expect(Date.parse(announcement.endsAt)).toBeGreaterThan(Date.parse(announcement.startsAt));
      }
    }
  });

  it.each([
    ["2026-05-21T11:59:59.999Z", false],
    ["2026-05-21T12:00:00.000Z", true],
    ["2026-05-22T11:59:59.999Z", true],
    ["2026-05-22T12:00:00.000Z", false],
  ])("shows a notice only within its dates at %s", (now, active) => {
    const summary = getMaintainerAnnouncementsSummary({
      announcements: [
        {
          ...BASE_ANNOUNCEMENT,
          startsAt: "2026-05-21T12:00:00.000Z",
          endsAt: "2026-05-22T12:00:00.000Z",
        },
      ],
      nowMs: Date.parse(now),
    });
    expect(summary.evaluations[0].active).toBe(active);
  });

  it("keeps an announcement inactive for each reason it fails", () => {
    const evaluations = evaluate(
      [
        BASE_ANNOUNCEMENT,
        { ...BASE_ANNOUNCEMENT, id: "future", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "expired", endsAt: "2026-05-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "invalid-url", url: "http://example.com" },
        { ...BASE_ANNOUNCEMENT, id: "invalid-end", endsAt: "not a date" },
        { ...BASE_ANNOUNCEMENT, id: "wrong-provider", providerIds: ["openai"] },
        { ...BASE_ANNOUNCEMENT, id: "targeted", providerIds: ["copilot"] },
        {
          ...BASE_ANNOUNCEMENT,
          id: "future-alias",
          startsAt: "2026-06-01T00:00:00.000Z",
          providerIds: ["gemini-cli" as never, "unknown-provider" as never],
        },
        { ...BASE_ANNOUNCEMENT, id: "invalid-message", message: "", providerIds: ["openai"] },
        { ...BASE_ANNOUNCEMENT, id: "invalid-only", providerIds: ["unknown-provider" as never] },
      ],
      ["copilot"],
    );

    expect(
      Object.fromEntries(evaluations.map((item) => [item.announcement.id, item.reasons])),
    ).toEqual({
      "copilot-credits": [],
      future: ["not_started"],
      expired: ["ended"],
      "invalid-url": ["invalid_url"],
      "invalid-end": ["invalid_ends_at"],
      "wrong-provider": ["provider_mismatch"],
      targeted: [],
      "future-alias": ["not_started", "provider_mismatch"],
      "invalid-message": ["invalid_message", "provider_mismatch"],
      "invalid-only": ["invalid_provider_ids"],
    });
    expect(evaluations.filter((item) => item.active).map((item) => item.announcement.id)).toEqual([
      "copilot-credits",
      "targeted",
    ]);
  });

  it("requires concrete provider ids for provider-targeted announcements", () => {
    const targeted = [{ ...BASE_ANNOUNCEMENT, providerIds: ["copilot" as const] }];

    expect(evaluate(targeted, "auto")).toMatchObject([
      { active: false, reasons: ["provider_mismatch"] },
    ]);
    expect(evaluate(targeted, ["copilot"])).toMatchObject([{ active: true }]);
  });

  it.each([
    ["2026-07-22T12:00:00.000Z", "auto", []],
    ["2026-07-22T12:00:00.000Z", ["gemini-cli"], ["google-gemini-cli-org-only"]],
    ["2026-07-22T12:00:00.000Z", ["google-agy"], []],
    ["2026-09-25T23:59:59.999Z", "auto", []],
    ["2026-09-26T00:00:00.000Z", "auto", ["opencode-ecosystem-listing-thumbs-up"]],
    [
      "2026-10-15T12:00:00.000Z",
      ["google-gemini-cli"],
      ["opencode-ecosystem-listing-thumbs-up", "google-gemini-cli-org-only"],
    ],
    ["2026-10-25T23:59:59.999Z", ["google-agy"], ["opencode-ecosystem-listing-thumbs-up"]],
    ["2026-10-26T00:00:00.000Z", "auto", []],
    ["2026-12-31T23:59:59.999Z", ["google-gemini-cli"], ["google-gemini-cli-org-only"]],
    ["2027-01-01T00:00:00.000Z", ["google-gemini-cli"], []],
  ] as const)("shows the bundled notices active at %s for %o", (iso, enabledProviders, ids) => {
    const summary = getMaintainerAnnouncementsSummary({
      nowMs: Date.parse(iso),
      enabledProviders: enabledProviders === "auto" ? "auto" : [...enabledProviders],
    });

    expect(summary.activeAnnouncements.map((item) => item.announcement.id)).toEqual(ids);
  });

  it("sorts active announcements before inactive, then by end date and id", () => {
    const evaluations = evaluate(
      [
        { ...BASE_ANNOUNCEMENT, id: "z-last", endsAt: "2026-06-10T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "inactive", startsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "a-first", endsAt: "2026-06-01T00:00:00.000Z" },
        { ...BASE_ANNOUNCEMENT, id: "b-first", endsAt: "2026-06-01T00:00:00.000Z" },
      ],
      "auto",
    );

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
});
