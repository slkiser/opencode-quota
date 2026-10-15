/**
 * Alibaba Personal Token Plan as one module: a fake Alibaba Cloud CLI (`bl`) on the PATH, a
 * shell script that prints a reply or exits with the CLI's codes. The provider itself runs on
 * Windows too, but a fake `bl` is a POSIX shell script, so the cases that install one only run
 * where such a script can be spawned.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import { NO_WINDOW_HINT } from "../src/lib/alibaba-token-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

/** The provider's own platforms. */
const SUPPORTED = process.platform === "darwin" || process.platform === "linux";
/** A fake `bl` is a POSIX shell script, so the CLI cases need a host that can run one. */
const FAKE_CLI_HOST = process.platform !== "win32";
const RESET = "2024-05-01T20:53:20.000Z";
const PLATFORM = { key: "platform", value: process.platform };
const originalPath = process.env.PATH;

let root = "";
let project = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opencode-quota-alibaba-token-plan-"));
  project = join(root, "project");
  mkdirSync(project);
  // An empty folder, so no `bl` installed on this machine is found.
  const emptyBin = join(root, "empty-bin");
  mkdirSync(emptyBin);
  process.env.PATH = emptyBin;
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

/** Puts a `bl` running `script` first on the PATH, in `folder` (below the temp root). */
function installCli(script: string, folder = join(root, "bin")): void {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "bl");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${folder}:/usr/bin:/bin`;
}

/** A CLI that prints this usage reply. */
function replying(usage: Record<string, unknown>): string {
  return `printf '%s' '${JSON.stringify(usage)}'`;
}

async function fetchTokenPlan(requestTimeoutMs = 5_000) {
  return rowsFromProviderResult(
    "alibaba-token-plan",
    await alibabaTokenPlanProvider.fetch({
      workspaceRoot: project,
      locationDirectory: project,
      config: { requestTimeoutMs },
    } as never),
  );
}

describe("alibaba-token-plan provider", () => {
  it("is available from explicit selection or recognized runtime presence, whatever the PATH holds", async () => {
    const selected = createProviderAvailabilityContext({
      providerIds: ["alibaba-token-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(selected)).resolves.toBe(SUPPORTED);

    const codingPlanOnly = createProviderAvailabilityContext({
      providerIds: ["alibaba", "alibaba-coding-plan"],
    });
    await expect(alibabaTokenPlanProvider.isAvailable(codingPlanOnly)).resolves.toBe(false);

    const runtime = createProviderAvailabilityContext({
      configOverrides: { currentProviderID: "alibaba-token-plan" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(runtime)).resolves.toBe(SUPPORTED);

    const model = createProviderAvailabilityContext({
      configOverrides: { currentModel: "alibaba-token-plan/qwen3" },
    });
    await expect(alibabaTokenPlanProvider.isAvailable(model)).resolves.toBe(SUPPORTED);
  });

  it.each([
    ["alibaba-token-plan/qwen3", "alibaba-token-plan", true],
    ["alibaba/qwen3-coder", "alibaba", false],
    ["alibaba-coding-plan/qwen3", "alibaba-coding-plan", false],
    ["alibaba-token-plan/qwen3", undefined, true],
    ["alibaba/qwen3-coder", undefined, false],
  ])("matchesCurrentModel(%s, provider %s) -> %s", (model, currentProviderID, expected) => {
    const context = currentProviderID ? ({ currentProviderID } as never) : undefined;
    expect(alibabaTokenPlanProvider.matchesCurrentModel?.(model, context)).toBe(expected);
  });

  it.runIf(FAKE_CLI_HOST)("never runs a bl from inside the project folder", async () => {
    installCli(replying({ per1MonthPercentage: 0.4 }), join(project, "bin"));

    const fetched = await fetchTokenPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.debug).toContainEqual({ key: "failure_kind", value: "executable_not_found" });
  });

  it.runIf(FAKE_CLI_HOST).each([
    [
      "the monthly window, with its reset",
      replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      [["alibaba-token-plan.personal", null, "Monthly", "month", 40, RESET]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "a signed-in reply with no window, left blank rather than reported",
      replying({}),
      [],
      undefined,
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "windows", value: "(none)" },
        { key: "window_hint", value: NO_WINDOW_HINT },
      ],
    ],
    [
      "the monthly window without a reset time",
      replying({ per1MonthPercentage: 0.5 }),
      [["alibaba-token-plan.personal", null, "Monthly", "month", 50, null]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "a missing CLI",
      undefined,
      [],
      { code: "local_tool" },
      [
        { key: "cli_available", value: "false" },
        PLATFORM,
        { key: "failure_kind", value: "executable_not_found" },
        {
          key: "error",
          value:
            "Alibaba Personal Token Plan: Alibaba Cloud CLI (bl) was not found on the trusted PATH.",
        },
        { key: "error_kind", value: "local_tool" },
      ],
    ],
    [
      "an expired console sign-in",
      "exit 3",
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value:
            "Alibaba Personal Token Plan: Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
        },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "a timeout",
      "exec sleep 5",
      [],
      { code: "timeout" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "timeout" },
        {
          key: "error",
          value: "Alibaba Personal Token Plan: Timed out while running the Alibaba Cloud CLI.",
        },
        { key: "error_kind", value: "timeout" },
      ],
    ],
  ])("shows %s", async (name, script, rows, error, debug) => {
    if (script !== undefined) installCli(script);

    // Only the timeout case waits out a short limit; the others get time to start the CLI.
    const fetched = await fetchTokenPlan(name === "a timeout" ? 300 : undefined);

    expect(rowSummary(fetched.rows)).toEqual(rows);
    if (error) expect(fetched.error).toMatchObject(error);
    else expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual(debug);
  });

  it.runIf(FAKE_CLI_HOST)(
    "gives the monthly row a start a calendar month before its reset",
    async () => {
      installCli(replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }));

      const fetched = await fetchTokenPlan();

      // The reply says when the month resets; its cycle is anchored on that day, so the start is
      // the same day a calendar month back.
      expect(fetched.rows[0]?.windowStartedAt).toBe("2024-04-01T20:53:20.000Z");
    },
  );

  it.runIf(FAKE_CLI_HOST)(
    "clamps the monthly start to the last day of a shorter month",
    async () => {
      installCli(
        replying({
          per1MonthPercentage: 0.6,
          per1MonthResetTime: Date.parse("2024-03-31T00:00:00.000Z"),
        }),
      );

      const fetched = await fetchTokenPlan();

      // February 2024 has no 31st, so the start lands on the last day it has.
      expect(fetched.rows[0]?.windowStartedAt).toBe("2024-02-29T00:00:00.000Z");
    },
  );

  it.runIf(!SUPPORTED)("is not set up on an unsupported platform", async () => {
    const fetched = await fetchTokenPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.error).toMatchObject({ code: "not_configured" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "failure_kind", value: "unsupported_platform" },
    ]);
  });
});
