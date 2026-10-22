/** One fake `bl` shared by the Alibaba provider tests: a case declares what each command prints. */

import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, vi } from "vite-plus/test";

import { useProviderWorld } from "./provider-fetch.js";

export const SUPPORTED = ["darwin", "linux", "win32"].includes(process.platform);
/** Whether a fake `bl` can really be a shell script here; otherwise the launch is faked. */
const POSIX_HOST = process.platform !== "win32";
export const PLATFORM = { key: "platform", value: process.platform };

/** The `bl auth status --output json` replies by which halves they name; `neither` is no account. */
export const AUTH_STATUS = {
  both: {
    console: { masked: "9f2c...d41a" },
    api_key: { masked: "sk-q...Z7m2" },
    openapi: { access_key_id: "LTAI...k9Pw" },
  },
  seatOnly: { openapi: { access_key_id: "LTAI...k9Pw" } },
  consoleOnly: { console: { masked: "9f2c...d41a" }, api_key: { masked: "sk-q...Z7m2" } },
  neither: {},
} as const;

type CliReply =
  | { kind: "prints"; body: unknown; log?: string }
  | { kind: "exits"; code: number }
  | { kind: "fails"; body: unknown; code: number }
  | { kind: "waits" };

type CliParts = {
  usage?: CliReply;
  seats?: CliReply;
  codingPlan?: CliReply;
  auth?: CliReply;
};

type LaunchCall = {
  file: string;
  args: readonly string[];
  options: SpawnOptions;
};

type FakePipe = {
  write(chunk: string): unknown;
  on(event: string, listener: () => void): unknown;
  listenerCount(event: string): number;
};

type FakeChild = {
  stdout: FakePipe;
  stderr: FakePipe;
  pid: number;
  kill: () => boolean;
  unref: () => void;
};

/** What the fake writes and the cases read; `replies` is null on a POSIX host, which runs the script. */
export const launch = {
  replies: null as null | Required<CliParts>,
  calls: [] as LaunchCall[],
  pipes: [] as FakePipe[],
};

function fakeChild(): EventEmitter & FakeChild {
  const child = new EventEmitter() as EventEmitter & FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // There is no process group of ours to signal; the real kill path belongs to the lib test.
  child.pid = 0;
  child.kill = () => true;
  child.unref = () => {};
  // A real pipe fails no write either, so a late one into a destroyed pipe stays silent.
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  return child;
}

/** Answers from the declared reply, matching the POSIX arm's own behaviour. */
function deliver(child: EventEmitter & FakeChild, reply: CliReply | undefined): void {
  setImmediate(() => {
    if (reply === undefined || reply.kind === "exits") {
      child.emit("close", reply?.code ?? 0);
      return;
    }
    if (reply.kind === "waits") return;
    if (reply.kind === "fails") {
      child.stderr.write(JSON.stringify(reply.body));
      setImmediate(() => child.emit("close", reply.code));
      return;
    }
    if (reply.log) writeFileSync(reply.log, "auth status\n", { flag: "a" });
    child.stdout.write(JSON.stringify(reply.body));
    setImmediate(() => child.emit("close", 0));
  });
}

/** The `bl` commands a case can declare, and the reply key each one answers from. */
const REPLY_KEY = {
  "usage token-plan": "usage",
  "usage coding-plan": "codingPlan",
  "token-plan list-seats": "seats",
  "auth status": "auth",
} as const;

type CliCommand = keyof typeof REPLY_KEY;

function replyFor(args: readonly string[]): CliReply | undefined {
  const key = REPLY_KEY[`${args[0]} ${args[1]}` as CliCommand];
  // Only `auth status` is answered by default, so a case stays silent about what it never declares.
  return key === undefined ? launch.replies?.auth : launch.replies?.[key];
}

/** `node:child_process` with only `spawn` replaced; argv, limits, timeout and parsers stay the provider's own code. */
export async function mockChildProcess(): Promise<typeof import("node:child_process")> {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: ((file: string, args: readonly string[], options: SpawnOptions) => {
      launch.calls.push({ file, args: [...args], options });
      if (launch.replies === null) return actual.spawn(file, args as string[], options as never);
      const child = fakeChild();
      launch.pipes.push(child.stdout);
      deliver(child, replyFor(args));
      return child as unknown as ChildProcess;
    }) as typeof actual.spawn,
  };
}

const world = useProviderWorld();

/** The world's temp root and its project folder; the shared world wipes and recreates the root. */
export const paths = { root: world.root, project: join(world.root, "project") };

/** The project folder and an empty PATH per case, so no installed `bl` is found. */
export function useAlibabaCliFixture(): void {
  beforeEach(() => {
    mkdirSync(paths.project);
    const emptyBin = join(paths.root, "empty-bin");
    mkdirSync(emptyBin);
    process.env.PATH = emptyBin;
    launch.replies = null;
    launch.calls = [];
    launch.pipes = [];
  });
}

/** `bl` prints this JSON and exits 0: the CLI's own reply, never a value fed to the parser. */
export function replying(body: unknown, log?: string): CliReply {
  return { kind: "prints", body, ...(log ? { log } : {}) };
}

/** `bl` exits with this code and prints nothing, as it does for a credential it is missing. */
export function exits(code: number): CliReply {
  return { kind: "exits", code };
}

/** A `bl` that never answers, so the runner's own timeout is what ends the command. */
export const WAITS: CliReply = { kind: "waits" };

export function seatPage(items: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { Success: true, Data: { Items: items, Total: items.length } };
}

/** `bl` answering its own commands; defaults keep a case silent about the commands it does not declare. */
function cli(parts: CliParts): Required<CliParts> {
  return {
    usage: parts.usage ?? replying({}),
    seats: parts.seats ?? replying(seatPage([])),
    codingPlan: parts.codingPlan ?? replying({}),
    auth: parts.auth ?? replying(AUTH_STATUS.both),
  };
}

/** One shell word: a single quote inside it ends the word, so the quote is closed and reopened. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function shellReply(reply: CliReply): string {
  if (reply.kind === "exits") return `exit ${reply.code}`;
  // An `exec` replaces the shell, so the runner's signal reaches the command it is waiting on.
  if (reply.kind === "waits") return "exec sleep 5";
  if (reply.kind === "fails") {
    return `printf '%s' ${shellWord(JSON.stringify(reply.body))} >&2 && exit ${reply.code}`;
  }
  const print = `printf '%s' ${shellWord(JSON.stringify(reply.body))}`;
  return reply.log
    ? `printf '%s\\n' ${shellWord("auth status")} >> ${shellWord(reply.log)} && ${print}`
    : print;
}

function shellScript(parts: Required<CliParts>): string {
  return [
    'case "$1 $2" in',
    ...Object.entries(REPLY_KEY).map(
      ([command, key]) => `  "${command}") ${shellReply(parts[key])} ;;`,
    ),
    "  *) exit 0 ;;",
    "esac",
  ].join("\n");
}

/** Puts a `bl` first on PATH that answers as `parts` declares; `folder` is never the project. */
export function installCli(parts: CliParts, folder = join(paths.root, "bin")): void {
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
