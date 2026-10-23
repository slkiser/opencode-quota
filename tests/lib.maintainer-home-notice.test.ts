import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// One announcement for Copilot users and one for Z.ai users, with the same dates.
vi.mock("../src/lib/maintainer-announcements.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/maintainer-announcements.js")>()),
  BUNDLED_MAINTAINER_ANNOUNCEMENTS: [
    {
      id: "copilot-credits",
      message: "If you use Copilot, GitHub billing is moving to AI Credits.",
      startsAt: new Date(2026, 9, 10, 8, 0).toISOString(),
      endsAt: "2026-11-01T00:00:00.000Z",
      providerIds: ["copilot"],
    },
    {
      id: "zai-plan",
      message: "Z.ai changed its plan limits.",
      startsAt: new Date(2026, 9, 10, 8, 0).toISOString(),
      endsAt: "2026-11-01T00:00:00.000Z",
      providerIds: ["zai"],
    },
  ],
}));

import {
  __resetMaintainerHomeNoticeForTests,
  homeNoticeLine,
  listNotices,
} from "../src/lib/maintainer-home-notice.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

const folders = useOpencodeFolders();

const NOTICE = "Notice: 1 maintainer notice, see /quota_status.";
const MINUTE = 60_000;
const homeStateFile = () =>
  join(folders.stateDir, "opencode-quota", "maintainer-announcements-home.json");
const MORNING = new Date(2026, 9, 10, 9, 0).getTime();

function lineAt(nowMs: number) {
  return homeNoticeLine({ providerIds: ["copilot"], nowMs });
}

describe("Home maintainer notice", () => {
  beforeEach(async () => {
    __resetMaintainerHomeNoticeForTests();
  });

  it.each([
    { providerIds: [], expected: "" },
    { providerIds: ["copilot"], expected: NOTICE },
    {
      providerIds: ["copilot", "zai"],
      expected: "Notice: 2 maintainer notices, see /quota_status.",
    },
  ])("counts the active notices for $providerIds", async ({ providerIds, expected }) => {
    await expect(homeNoticeLine({ providerIds, nowMs: MORNING })).resolves.toBe(expected);
  });

  it("shows the daily notice for 10 minutes on the first Home screen of each day", async () => {
    const shown = [];
    for (const nowMs of [
      MORNING,
      MORNING + 10 * MINUTE - 1,
      MORNING + 10 * MINUTE,
      new Date(2026, 9, 10, 23, 59).getTime(),
      new Date(2026, 9, 11, 0, 1).getTime(),
    ]) {
      shown.push((await lineAt(nowMs)) === NOTICE);
    }
    expect(shown).toEqual([true, true, false, false, true]);
  });

  it("counts a showing from the future as used up when the clock goes back", async () => {
    await expect(lineAt(new Date(2026, 9, 10, 15, 0).getTime())).resolves.toBe(NOTICE);
    await expect(lineAt(new Date(2026, 9, 10, 13, 0).getTime())).resolves.toBe("");
  });

  it("keeps one process to once a day when the state file cannot be written", async () => {
    // A file where the state folder should be makes every read and write fail.
    await mkdir(folders.stateDir, { recursive: true });
    await writeFile(join(folders.stateDir, "opencode-quota"), "not a folder");
    await expect(lineAt(MORNING)).resolves.toBe(NOTICE);
    await expect(lineAt(MORNING + 11 * MINUTE)).resolves.toBe("");
    await expect(lineAt(new Date(2026, 9, 11, 9, 0).getTime())).resolves.toBe(NOTICE);
  });

  it("does not use up the day's showing while no notice is active", async () => {
    await expect(homeNoticeLine({ providerIds: [], nowMs: MORNING })).resolves.toBe("");
    await expect(lineAt(MORNING + 60 * MINUTE)).resolves.toBe(NOTICE);
  });

  it("does not use up the day's showing before a notice starts", async () => {
    await expect(lineAt(new Date(2026, 9, 10, 7, 0).getTime())).resolves.toBe("");
    await expect(readFile(homeStateFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lineAt(MORNING)).resolves.toBe(NOTICE);
  });

  it("shows nothing after the notices end and writes no daily claim", async () => {
    await expect(lineAt(Date.parse("2026-11-01T00:00:00.000Z"))).resolves.toBe("");
    await expect(readFile(homeStateFile(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the daily claim across processes", async () => {
    await expect(lineAt(MORNING)).resolves.toBe(NOTICE);
    const claim = JSON.parse(await readFile(homeStateFile(), "utf8"));
    expect(claim).toEqual({ day: "2026-10-10", shownAtMs: MORNING });
    __resetMaintainerHomeNoticeForTests();
    await expect(lineAt(MORNING + 9 * MINUTE)).resolves.toBe(NOTICE);
    await expect(lineAt(MORNING + 10 * MINUTE)).resolves.toBe("");
    expect(JSON.parse(await readFile(homeStateFile(), "utf8"))).toEqual(claim);
  });

  it("lists active notices without read state", async () => {
    await expect(listNotices({ providerIds: ["copilot"], nowMs: MORNING })).resolves.toEqual([
      {
        id: "copilot-credits",
        message: "If you use Copilot, GitHub billing is moving to AI Credits.",
      },
    ]);
  });
});
