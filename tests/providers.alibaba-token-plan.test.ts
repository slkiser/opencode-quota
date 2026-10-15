/**
 * Alibaba Personal Token Plan as one module: a fake Alibaba Cloud CLI (`bl`) on the PATH, declared
 * once and answering the provider's `usage token-plan` command from its own reply or exiting with
 * the CLI's codes. The declaration drives both arms: a POSIX host runs it as a shell script, and a
 * host where `spawn(..., { shell: false })` cannot start one drives the provider's own process
 * runner through a faked launch instead.
 */

import type { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { rowsFromProviderResult } from "../src/core/rows.js";
import { NO_WINDOW_HINT } from "../src/lib/alibaba-token-plan.js";
import { alibabaTokenPlanProvider } from "../src/providers/alibaba-token-plan.js";
import { rowSummary } from "./helpers/provider-fetch.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

/** The provider's own platforms, Windows included. */
const SUPPORTED = ["darwin", "linux", "win32"].includes(process.platform);
/** Whether a fake `bl` can really be a shell script here; otherwise the launch below is faked. */
const POSIX_HOST = process.platform !== "win32";
const RESET = "2024-05-01T20:53:20.000Z";
const PLATFORM = { key: "platform", value: process.platform };
/** What one command's `bl` answers, declared once and rendered for whichever arm runs it. */
type CliReply =
  | { kind: "prints"; body: unknown; log?: string }
  | { kind: "exits"; code: number }
  | { kind: "waits" };

/** The commands the provider runs, each with its own reply. */
type CliParts = { usage?: CliReply };

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
   * does: a whole document on stdout, or the CLI's exit code, or no answer at all.
   */
  function deliver(child: EventEmitter & FakeChild, reply: CliReply | undefined): void {
    setImmediate(() => {
      if (reply === undefined || reply.kind === "exits") {
        child.emit("close", reply?.code ?? 0);
        return;
      }
      if (reply.kind === "waits") return;
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
      deliver(
        child,
        `${args[0]} ${args[1]}` === "usage token-plan" ? launch.replies.usage : undefined,
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

/**
 * A `bl` answering its commands from its own arms; any other command prints nothing. The usage
 * command defaults to a signed-in reply with no window rather than no answer at all.
 */
function cli(parts: CliParts): Required<CliParts> {
  return { usage: parts.usage ?? replying({}) };
}

/** The POSIX arm's rendering of one declared reply, as that script's own arm. */
function shellReply(reply: CliReply): string {
  if (reply.kind === "exits") return `exit ${reply.code}`;
  // An `exec` replaces the shell, so the runner's signal reaches the command it is waiting on.
  if (reply.kind === "waits") return "exec sleep 5";
  const print = `printf '%s' '${JSON.stringify(reply.body)}'`;
  return reply.log ? `printf '%s\\n' 'auth status' >> '${reply.log}' && ${print}` : print;
}

/** The fake script: each arm answers from the same declaration the faked launch reads. */
function shellScript(parts: Required<CliParts>): string {
  return [
    'case "$1 $2" in',
    `  "usage token-plan") ${shellReply(parts.usage)} ;;`,
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
      "the monthly window without a reset time",
      cli({ usage: replying({ per1MonthPercentage: 0.5 }) }),
      [["alibaba-token-plan.personal", "personal", "Monthly", "month", 50, null]],
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
          value: `Alibaba Token Plan (personal): ${ERROR_MESSAGES.executable_not_found}`,
        },
        { key: "error_kind", value: "local_tool" },
      ],
    ],
    [
      "an expired console sign-in",
      cli({ usage: exits(3) }),
      [],
      { code: "login_expired" },
      [
        { key: "cli_available", value: "true" },
        PLATFORM,
        { key: "failure_kind", value: "not_authenticated" },
        {
          key: "error",
          value:
            "Alibaba Token Plan (personal): Alibaba Cloud console session is missing or expired. Run `bl auth login --console`.",
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

      // The command the provider built, and the runner's own launch options for it.
      const commands = launch.calls.map((call) => call.args.join(" ")).sort();
      expect(commands).toEqual(["usage token-plan --output json"]);
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
