/**
 * Alibaba Token Plan as one module: a fake Alibaba Cloud CLI (`bl`) on the PATH, declared once and
 * answering each of the provider's commands (`usage token-plan`, `token-plan list-seats`,
 * `auth status`) from its own reply or exiting with the CLI's codes. The declaration drives both
 * arms: a POSIX host runs it as a shell script, and a host where `spawn(..., { shell: false })`
 * cannot start one drives the provider's own process runner through a faked launch instead.
 */

import type { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import {
  clearAlibabaTokenPlanIdentityCacheForTests,
  NO_WINDOW_HINT,
} from "../src/lib/alibaba-token-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

/** The provider's own platforms, Windows included. */
const SUPPORTED = ["darwin", "linux", "win32"].includes(process.platform);
/** Whether a fake `bl` can really be a shell script here; otherwise the launch below is faked. */
const POSIX_HOST = process.platform !== "win32";
const RESET = "2024-05-01T20:53:20.000Z";
const PLATFORM = { key: "platform", value: process.platform };
const CONSOLE_NO_AUTH =
  "Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.";
const SEAT_NO_AUTH =
  "Alibaba Cloud API Key credentials are missing or expired for team seats; this requires login. Run `bl auth login --open-api`, or set ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET.";

/** The `bl auth status --output json` replies by which halves they name; `neither` is no account. */
const AUTH_STATUS = {
  both: {
    console: { masked: "9f2c...d41a" },
    api_key: { masked: "sk-q...Z7m2" },
    openapi: { access_key_id: "LTAI...k9Pw" },
  },
  seatOnly: { openapi: { access_key_id: "LTAI...k9Pw" } },
  consoleOnly: { console: { masked: "9f2c...d41a" }, api_key: { masked: "sk-q...Z7m2" } },
  neither: {},
} as const;

/** What one command's `bl` answers, declared once and rendered for whichever arm runs it. */
type CliReply =
  | { kind: "prints"; body: unknown; log?: string }
  | { kind: "exits"; code: number }
  | { kind: "fails"; body: unknown; code: number }
  | { kind: "waits" };

/** The three commands the provider runs, each with its own reply. */
type CliParts = { usage?: CliReply; seats?: CliReply; auth?: CliReply };

/** One launch as the provider's runner made it, seen at the mock's own boundary. */
type LaunchCall = {
  file: string;
  args: readonly string[];
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    detached?: boolean;
    windowsHide?: boolean;
  };
};

/** The pieces of a child pipe this test touches: the runner's reader and the fake's writer. */
type FakePipe = {
  write(chunk: string): unknown;
  on(event: string, listener: () => void): unknown;
  listenerCount(event: string): number;
};

/** The pieces of a child process the provider's runner touches. */
type FakeChild = {
  stdout: FakePipe;
  stderr: FakePipe;
  pid: number;
  kill: () => boolean;
  unref: () => void;
};

/**
 * The one thing replaced for the faked arm: `spawn` from `node:child_process`. Everything past it
 * is the provider's own code — the argv it builds, the stdout byte limit, the timeout, the
 * process-group signal, the whole-document exit, `mapSpawnResult`, the JSON parsers, the
 * percentage arithmetic and the row construction — so a case declares only what the CLI prints.
 * A POSIX host leaves `replies` null and every call goes to the real launch.
 */
const launch = vi.hoisted(() => ({
  replies: null as null | Required<CliParts>,
  calls: [] as LaunchCall[],
  pipes: [] as FakePipe[],
}));

// The identity is mocked so the test reads the principal it was given, not a digest of the key.
const identityMocks = vi.hoisted(() => ({
  deriveIdentity: vi.fn(async (params: unknown) => `rai1_${JSON.stringify(params)}`),
}));

vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: identityMocks.deriveIdentity,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const events = await import("node:events");
  const streams = await import("node:stream");
  const files = await import("node:fs");

  /** A fake child process: an EventEmitter with the two pipes the provider's runner reads. */
  function fakeChild(): EventEmitter & FakeChild {
    const child = new events.EventEmitter() as EventEmitter & FakeChild;
    child.stdout = new streams.PassThrough();
    child.stderr = new streams.PassThrough();
    // There is no process group of ours to signal; the real kill path belongs to the lib test.
    child.pid = 0;
    child.kill = () => true;
    child.unref = () => {};
    // A real pipe fails no write either, so a late one into a destroyed pipe stays silent.
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    return child;
  }

  /**
   * Answers the child's command from its declared reply, exactly as the POSIX script's own arm
   * does: a whole document on stdout, or the CLI's exit code, or its failure envelope on stderr,
   * or no answer at all.
   */
  function deliver(child: EventEmitter & FakeChild, reply: CliReply | undefined): void {
    setImmediate(() => {
      if (reply === undefined || reply.kind === "exits") {
        child.emit("close", reply?.code ?? 0);
        return;
      }
      if (reply.kind === "waits") return;
      if (reply.kind === "fails") {
        // The CLI writes its failure envelope to stderr and exits with the code it carries.
        child.stderr.write(JSON.stringify(reply.body));
        setImmediate(() => child.emit("close", reply.code));
        return;
      }
      if (reply.log) files.appendFileSync(reply.log, "auth status\n");
      child.stdout.write(JSON.stringify(reply.body));
      setImmediate(() => child.emit("close", 0));
    });
  }

  return {
    ...actual,
    spawn: ((file: string, args: readonly string[], options: LaunchCall["options"]) => {
      launch.calls.push({ file, args: [...args], options });
      if (launch.replies === null) return actual.spawn(file, args as string[], options as never);
      const child = fakeChild();
      launch.pipes.push(child.stdout);
      const command = `${args[0]} ${args[1]}`;
      deliver(
        child,
        command === "usage token-plan"
          ? launch.replies.usage
          : command === "token-plan list-seats"
            ? launch.replies.seats
            : launch.replies.auth,
      );
      return child;
    }) as typeof actual.spawn,
  };
});

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
  // Each case declares its own replies, and nothing carries over from the case before it.
  launch.replies = null;
  launch.calls = [];
  launch.pipes = [];
  // `bl auth status` is memoised per process, so each case must start from its own reply.
  clearAlibabaTokenPlanIdentityCacheForTests();
  identityMocks.deriveIdentity.mockClear();
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

/** `bl` prints this JSON and exits 0: the CLI's own reply, never a value fed to the parser. */
function replying(body: unknown, log?: string): CliReply {
  return { kind: "prints", body, ...(log ? { log } : {}) };
}

/** `bl` exits with this code and prints nothing, as it does for a credential it is missing. */
function exits(code: number): CliReply {
  return { kind: "exits", code };
}

/** A `bl` that never answers, so the runner's own timeout is what ends the command. */
const WAITS: CliReply = { kind: "waits" };

/** The seat command's own envelope: `{ Success: true, Data: { Items, Total } }`. */
function seatPage(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { Success: true, Data: { Items: items, Total: items.length } };
}

/**
 * A `bl` answering its three commands from its own arms; any other command prints nothing. The
 * usage command defaults to a signed-in reply with no window, so a seat-only case sees no personal
 * row either way; the seat command to an empty page, and the identity command to a set-up account.
 */
function cli(parts: CliParts): Required<CliParts> {
  return {
    usage: parts.usage ?? replying({}),
    seats: parts.seats ?? replying(seatPage([])),
    auth: parts.auth ?? replying(AUTH_STATUS.both),
  };
}

/** The POSIX arm's rendering of one declared reply, as that script's own arm. */
function shellReply(reply: CliReply): string {
  if (reply.kind === "exits") return `exit ${reply.code}`;
  // An `exec` replaces the shell, so the runner's signal reaches the command it is waiting on.
  if (reply.kind === "waits") return "exec sleep 5";
  if (reply.kind === "fails") {
    // The CLI writes its failure envelope to stderr and exits with the code it carries.
    return `printf '%s' '${JSON.stringify(reply.body)}' >&2 && exit ${reply.code}`;
  }
  const print = `printf '%s' '${JSON.stringify(reply.body)}'`;
  return reply.log ? `printf '%s\\n' 'auth status' >> '${reply.log}' && ${print}` : print;
}

/** The fake script: each arm answers from the same declaration the faked launch reads. */
function shellScript(parts: Required<CliParts>): string {
  return [
    'case "$1 $2" in',
    `  "usage token-plan") ${shellReply(parts.usage)} ;;`,
    `  "token-plan list-seats") ${shellReply(parts.seats)} ;;`,
    `  "auth status") ${shellReply(parts.auth)} ;;`,
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
}

/**
 * Puts a `bl` first on the PATH that answers the provider's commands as `parts` declares: a shell
 * script where one can be spawned, and on Windows a real file for the executable probe beside the
 * faked launch that feeds the same replies. `folder` sits below the temp root, never in the project.
 */
function installCli(parts: CliParts, folder = join(root, "bin")): void {
  mkdirSync(folder, { recursive: true });
  const declared = cli(parts);
  if (!POSIX_HOST) {
    // Windows probes `bl.exe`, and the file only has to exist for the probe; the launch is faked.
    writeFileSync(join(folder, "bl.exe"), "");
    process.env.PATH = folder;
    launch.replies = declared;
    return;
  }
  const file = join(folder, "bl");
  writeFileSync(file, `#!/bin/sh\n${shellScript(declared)}\n`);
  chmodSync(file, 0o755);
  process.env.PATH = `${folder}:/usr/bin:/bin`;
}

async function fetchTokenPlan(requestTimeoutMs = 5_000) {
  return rowsFromProviderResult(
    "alibaba-token-plan",
    await alibabaTokenPlanProvider.fetch({
      workspaceRoot: project,
      locationDirectory: project,
      // The provider takes the user's timeout only when the settings say one is set.
      config: { requestTimeoutMs, requestTimeoutMsConfigured: true },
    } as never),
  );
}

function seatJson(name: string, equity?: Record<string, number>): Record<string, unknown> {
  return { Status: "NORMAL", AccountName: name, ...(equity ? { EquityList: [equity] } : {}) };
}

const SEAT_RESET = new Date(1_792_742_400_000).toISOString();
const SEAT_CYCLE_START = new Date(1_790_150_400_000).toISOString();
const TEAM_LEAD_EQUITY = {
  CycleTotalValue: 250_000,
  CycleSurplusValue: 170_000,
  CycleStartTime: Date.parse(SEAT_CYCLE_START),
  CycleEndTime: Date.parse(SEAT_RESET),
};
const TEAM_LEAD = seatJson("team-lead", TEAM_LEAD_EQUITY);
const TEAM_LEAD_ROW = [
  "alibaba-token-plan.team.team_lead",
  "team-lead",
  "Credits",
  "month",
  "68 (80000 credit of 250000 credit)",
  SEAT_RESET,
];

const IDENTITY_CONTEXT = {
  workspaceRoot: "/home/user/project",
  config: { requestTimeoutMs: 5_000 },
};

function identityPolicy() {
  const policy = alibabaTokenPlanProvider.cachePolicy;
  if (policy?.kind !== "resolved-auth") throw new Error("Expected a resolved-auth policy");
  return policy;
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

  it.runIf(SUPPORTED)("never runs a bl from inside the project folder", async () => {
    installCli(cli({ usage: replying({ per1MonthPercentage: 0.4 }) }), join(project, "bin"));

    const fetched = await fetchTokenPlan();

    expect(fetched.rows).toEqual([]);
    expect(fetched.debug).toContainEqual({ key: "failure_kind", value: "executable_not_found" });
  });

  it.runIf(SUPPORTED).each([
    [
      "the monthly window, with its reset",
      cli({ usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }) }),
      [["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "the monthly window without a reset time",
      { usage: replying({ per1MonthPercentage: 0.5 }) },
      [["alibaba-token-plan.personal", "personal", "Monthly", "month", 50, null]],
      undefined,
      [{ key: "cli_available", value: "true" }, PLATFORM, { key: "windows", value: "monthly" }],
    ],
    [
      "a signed-in reply with no window, left blank rather than reported",
      cli({ usage: replying({}) }),
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
      "a missing CLI, failing both commands",
      undefined,
      [],
      { code: "local_tool" },
      [
        { key: "cli_available", value: "false" },
        PLATFORM,
        { key: "failure_kind", value: "executable_not_found" },
        { key: "seat_failure_kind", value: "executable_not_found" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.executable_not_found}`,
        },
        { key: "error_kind", value: "local_tool" },
        {
          key: "error",
          value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.executable_not_found}`,
        },
        { key: "error_kind", value: "local_tool" },
      ],
    ],
    [
      "an expired console sign-in, leaving the seats alone",
      cli({ usage: exits(3) }),
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        { key: "error", value: `Alibaba Token Plan (personal): ${CONSOLE_NO_AUTH}` },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "the CLI's own reason for a rejected call, with the exit code as the error kind",
      cli({
        usage: {
          kind: "fails",
          code: 1,
          body: { error: { code: 1, message: "COMMON-2001 - the reply was rejected" } },
        },
      }),
      [],
      { code: "provider_error" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "nonzero_exit" },
        {
          key: "error",
          value: "Alibaba Token Plan (personal): COMMON-2001 - the reply was rejected",
        },
        { key: "error_kind", value: "provider_error" },
      ],
    ],
    [
      "an expired sign-in whose words do not say so, decided by the exit code",
      cli({
        usage: {
          kind: "fails",
          code: 3,
          body: { error: { code: 3, message: "the session token was refused" } },
        },
      }),
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value: "Alibaba Token Plan (personal): the session token was refused",
        },
        { key: "error_kind", value: "login_expired" },
      ],
    ],
    [
      "a timeout",
      cli({ usage: WAITS }),
      [],
      { code: "timeout" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "timeout" },
        {
          key: "error",
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.timeout}`,
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

  it.runIf(SUPPORTED)(
    "gives the monthly row a start a calendar month before its reset",
    async () => {
      installCli(
        cli({
          usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
        }),
      );

      const fetched = await fetchTokenPlan();

      // The reply says when the month resets; its cycle is anchored on that day, so the start is
      // the same day a calendar month back.
      expect(fetched.rows[0]?.windowStartedAt).toBe("2024-04-01T20:53:20.000Z");
    },
  );

  it.runIf(SUPPORTED)("clamps the monthly start to the last day of a shorter month", async () => {
    installCli(
      cli({
        usage: replying({
          per1MonthPercentage: 0.6,
          per1MonthResetTime: Date.parse("2024-03-31T00:00:00.000Z"),
        }),
      }),
    );

    const fetched = await fetchTokenPlan();

    // February 2024 has no 31st, so the start lands on the last day it has.
    expect(fetched.rows[0]?.windowStartedAt).toBe("2024-02-29T00:00:00.000Z");
  });

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

  it.runIf(SUPPORTED)(
    "shows a team seat row with the account name as its own account name",
    async () => {
      installCli({ seats: replying(seatPage([TEAM_LEAD])) });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.rows[0]?.account).toBe("team-lead");
      expect(fetched.rows[0]?.id).toBe("alibaba-token-plan.team.team_lead");
      // A personal reply with no window is an absence, so the seats stand alone and nothing fails.
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "windows", value: "(none)" },
        { key: "window_hint", value: NO_WINDOW_HINT },
        { key: "seat_windows", value: "credits" },
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "gives a seat row the cycle's start, so its window has an exact span",
    async () => {
      installCli({ seats: replying(seatPage([TEAM_LEAD])) });

      const fetched = await fetchTokenPlan();

      // A month-long window has no fixed length, so the pace of a row needs the start it reports.
      expect(fetched.rows[0]?.windowStartedAt).toBe(SEAT_CYCLE_START);
      expect(fetched.rows[0]?.resetsAt).toBe(SEAT_RESET);
    },
  );

  it.runIf(SUPPORTED)("shows both the personal window and the team seats", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: replying(seatPage([TEAM_LEAD])),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
      TEAM_LEAD_ROW,
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_windows", value: "credits" },
    ]);
  });

  it.runIf(SUPPORTED)("keeps a seat row whose cycle total is 0, through its amount", async () => {
    installCli({
      seats: replying(seatPage([seatJson("zero", { CycleTotalValue: 0, CycleSurplusValue: 0 })])),
    });

    const fetched = await fetchTokenPlan();

    // No percentage (the total is 0), but `amount` carries the surplus, so the row survives.
    expect(rowSummary(fetched.rows)).toEqual([
      [
        "alibaba-token-plan.team.zero",
        "zero",
        "Credits",
        "month",
        "0 credit (0 credit of 0 credit)",
        null,
      ],
    ]);
  });

  it.runIf(SUPPORTED)(
    "keeps a seat reporting a cycle total but no usage, with text instead of a dropped row",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("no-surplus", {
              CycleTotalValue: 250_000,
              CycleEndTime: Date.parse(SEAT_RESET),
            }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      // A limit alone is not a row value; without the text this row is dropped as `no value`.
      expect(fetched.rows.map((row) => [row.id, row.text, row.limit?.decimal])).toEqual([
        ["alibaba-token-plan.team.no_surplus", "no usage reported", "250000"],
      ]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    },
  );

  // A CN team names its seats in Chinese; a slug drops every non-ASCII character, so the key is a
  // digest of the name rather than the name's position in the list.
  it.runIf(SUPPORTED)(
    "keeps a seat whose name is not plain ASCII, keying a name digest and texting the raw name",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("张三", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("John Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
        ["alibaba-token-plan.team.seat_1d841bc0", "张三"],
        ["alibaba-token-plan.team.john_doe", "John Doe"],
      ]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([]);
    },
  );

  it.runIf(SUPPORTED)(
    "keys a seat by its name, not its position, so a reorder keeps the same row",
    async () => {
      const seats = (names: readonly string[]) =>
        replying(
          seatPage(
            names.map((name) => seatJson(name, { CycleTotalValue: 100, CycleSurplusValue: 40 })),
          ),
        );
      const idsByAccount = (rows: readonly { account?: string; id: string }[]) =>
        Object.fromEntries(rows.map((row) => [row.account, row.id]));

      installCli({ seats: seats(["张三", "李四"]) });
      const first = await fetchTokenPlan();
      installCli({ seats: seats(["李四", "张三"]) });
      const second = await fetchTokenPlan();

      // Each name keeps its own key however the reply orders the seats.
      expect(idsByAccount(second.rows)).toEqual(idsByAccount(first.rows));
    },
  );

  it.runIf(SUPPORTED)(
    "keeps two seats that slug alike, giving each a name digest so neither id is shared",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("John Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("John-Doe", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => [row.id, row.account])).toEqual([
        ["alibaba-token-plan.team.john_doe_6cea57c2", "John Doe"],
        ["alibaba-token-plan.team.john_doe_7679aa58", "John-Doe"],
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "drops the second of two identically named seats, as a repeated row",
    async () => {
      installCli({
        seats: replying(
          seatPage([
            seatJson("team-lead", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
            seatJson("team-lead", { CycleTotalValue: 100, CycleSurplusValue: 40 }),
          ]),
        ),
      });

      const fetched = await fetchTokenPlan();

      expect(fetched.rows.map((row) => row.id)).toEqual(["alibaba-token-plan.team.team_lead"]);
      expect(fetched.debug.filter((item) => item.key === "dropped_row")).toEqual([
        { key: "dropped_row", value: "alibaba-token-plan.team.team_lead: repeated row" },
      ]);
    },
  );

  it.runIf(SUPPORTED)("keeps the personal row when only the seat command fails", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: exits(3),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
    ]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_failure_kind", value: "seat_not_authenticated" },
      {
        key: "error",
        value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.seat_not_authenticated}`,
      },
      { key: "error_kind", value: "login_expired" },
    ]);
  });

  it.runIf(SUPPORTED)("keeps the team seats when only the personal command fails", async () => {
    installCli({ usage: exits(3), seats: replying(seatPage([TEAM_LEAD])) });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
    expect(fetched.error).toMatchObject({ code: "login_expired" });
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "failure_kind", value: "not_authenticated" },
      { key: "seat_windows", value: "credits" },
      { key: "error", value: `Alibaba Token Plan (personal): ${CONSOLE_NO_AUTH}` },
      { key: "error_kind", value: "login_expired" },
    ]);
  });

  it.runIf(SUPPORTED)(
    "leaves out the personal account an AK/SK-only user never set up",
    async () => {
      installCli({
        usage: exits(3),
        seats: replying(seatPage([TEAM_LEAD])),
        auth: replying(AUTH_STATUS.seatOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.error).toBeUndefined();
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        { key: "seat_windows", value: "credits" },
      ]);
    },
  );

  it.runIf(SUPPORTED)("leaves out the team account a console-only user never set up", async () => {
    installCli({
      usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
      seats: exits(3),
      auth: replying(AUTH_STATUS.consoleOnly),
    });

    const fetched = await fetchTokenPlan();

    expect(rowSummary(fetched.rows)).toEqual([
      ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
    ]);
    expect(fetched.error).toBeUndefined();
    expect(fetched.debug).toEqual([
      { key: "cli_available", value: "true" },
      PLATFORM,
      { key: "windows", value: "monthly" },
      { key: "seat_failure_kind", value: "seat_not_authenticated" },
    ]);
  });

  // `bl auth status` is memoised for 60 s while each command runs live, so a marker can lag the
  // command it describes: a half it calls absent may still have answered with rows.
  it.runIf(SUPPORTED)(
    "shows the personal window a stale identity read called the console half absent",
    async () => {
      installCli({
        usage: replying({ per1MonthPercentage: 0.6, per1MonthResetTime: Date.parse(RESET) }),
        auth: replying(AUTH_STATUS.seatOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([
        ["alibaba-token-plan.personal", "personal", "Monthly", "month", 40, RESET],
      ]);
      expect(fetched.error).toBeUndefined();
    },
  );

  it.runIf(SUPPORTED)(
    "shows the team seats a stale identity read called the OpenAPI half absent",
    async () => {
      installCli({
        seats: replying(seatPage([TEAM_LEAD])),
        auth: replying(AUTH_STATUS.consoleOnly),
      });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([TEAM_LEAD_ROW]);
      expect(fetched.error).toBeUndefined();
    },
  );

  it.runIf(SUPPORTED)(
    "still reports both halves when the account names neither credential",
    async () => {
      // A read that failed looks the same to a provider that cannot tell absence from failure.
      installCli({ usage: exits(3), seats: exits(3), auth: replying(AUTH_STATUS.neither) });

      const fetched = await fetchTokenPlan();

      expect(rowSummary(fetched.rows)).toEqual([]);
      expect(fetched.error).toMatchObject({ code: "login_expired" });
      expect(fetched.debug).toEqual([
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        { key: "seat_failure_kind", value: "seat_not_authenticated" },
        { key: "error", value: `Alibaba Token Plan (personal): ${CONSOLE_NO_AUTH}` },
        { key: "error_kind", value: "login_expired" },
        {
          key: "error",
          value: `Alibaba Token Plan (team): ${ERROR_MESSAGES.seat_not_authenticated}`,
        },
        { key: "error_kind", value: "login_expired" },
      ]);
    },
  );

  it.runIf(SUPPORTED)(
    "keys the account on the access key id, so a replaced console token keeps the slot",
    async () => {
      installCli({ auth: replying(AUTH_STATUS.both) });

      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      // A key id does not rotate, so the slot survives the console token being replaced.
      expect(identityMocks.deriveIdentity).toHaveBeenCalledWith({
        providerId: "alibaba-token-plan",
        principal: { kind: "stable-id", value: "LTAI...k9Pw" },
      });
    },
  );

  it.runIf(SUPPORTED)(
    "falls back to the console token when the CLI reports no access key id",
    async () => {
      installCli({ auth: replying(AUTH_STATUS.consoleOnly) });

      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      expect(identityMocks.deriveIdentity).toHaveBeenCalledWith({
        providerId: "alibaba-token-plan",
        principal: { kind: "credential", value: "9f2c...d41a" },
      });
    },
  );

  it.runIf(SUPPORTED)(
    "reads `bl auth status` once for a fetch and the identity together, through the same memo",
    async () => {
      const log = join(root, "auth-status.log");
      installCli({ auth: replying(AUTH_STATUS.both, log) });

      await fetchTokenPlan();
      await identityPolicy().resolveIdentity(IDENTITY_CONTEXT as never, {} as never);

      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["auth status"]);
    },
  );

  // The seam: the provider spawns through its own `runAlibabaTokenPlanProcess`, so a row appears
  // only after the declared document travelled argv, pipes, parsers and arithmetic.
  it.runIf(SUPPORTED)(
    "drives the provider's own process runner from the declared replies",
    async () => {
      installCli(
        cli({
          usage: replying({ per1MonthPercentage: 0.25, per1MonthResetTime: Date.parse(RESET) }),
        }),
      );

      const fetched = await fetchTokenPlan();

      const commands = launch.calls.map((call) => call.args.join(" ")).sort();
      expect(commands).toEqual(
        [
          "usage token-plan --output json",
          "token-plan list-seats --status NORMAL --query-assigned true --page-size 100 --output json",
          "auth status --output json",
        ].sort(),
      );
      for (const call of launch.calls) {
        expect(call.options.shell).toBe(false);
        expect(call.options.detached).toBe(true);
        expect(call.options.env?.PATH).toContain(join(root, "bin"));
      }
      // Only the provider's runner attaches a stdout reader, so a pipe with one is the runner reading
      // the declared chunks. The POSIX path spawns a real `bl`, so there are no fake pipes to check.
      if (process.platform === "win32") {
        expect(launch.pipes.every((pipe) => pipe.listenerCount("data") === 1)).toBe(true);
      }

      // 0.25 used is 75% left: the arithmetic ran on the faked chunks, unmodified.
      expect(rowSummary(fetched.rows)).toEqual([
        ["alibaba-token-plan.personal", "personal", "Monthly", "month", 75, RESET],
      ]);
    },
  );
});
