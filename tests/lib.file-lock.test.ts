import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Pauses the file system at the steps of Sol's interleaving: a waiter about to take over an
 * abandoned lock, the moment that takeover lands, and a holder about to write its commit.
 */
const steps = vi.hoisted(() => {
  const pause = () => {
    let arrive = () => {};
    let go = () => {};
    const reached = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const released = new Promise<void>((resolve) => {
      go = resolve;
    });
    /** Marks the step reached and waits until the test says go. */
    const hold = () => {
      arrive();
      return released;
    };
    return { reached, go, hold };
  };
  return {
    pause,
    beforeTakeover: undefined as ReturnType<typeof pause> | undefined,
    afterTakeover: undefined as (() => Promise<void>) | undefined,
    beforeTempWrite: undefined as ReturnType<typeof pause> | undefined,
    /** Renames onto a file with this name: the commits. */
    targetName: "",
    commits: 0,
  };
});

const fsWithSteps = vi.hoisted(() => (actual: typeof import("node:fs/promises")) => ({
  ...actual,
  rename: async (from: string, to: string) => {
    const takeover = String(to).includes(".stale-");
    if (takeover) {
      const step = steps.beforeTakeover;
      steps.beforeTakeover = undefined;
      await step?.hold();
    }
    await actual.rename(from, to);
    if (String(to).split(/[\\/]/).pop() === steps.targetName) steps.commits += 1;
    const then = takeover ? steps.afterTakeover : undefined;
    if (takeover) steps.afterTakeover = undefined;
    await then?.();
  },
  writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]).includes(".tmp-")) {
      const step = steps.beforeTempWrite;
      steps.beforeTempWrite = undefined;
      await step?.hold();
    }
    return actual.writeFile(...args);
  },
}));

vi.mock("node:fs/promises", async (importOriginal) =>
  fsWithSteps(await importOriginal<typeof import("node:fs/promises")>()),
);
vi.mock("fs/promises", async (importOriginal) =>
  fsWithSteps(await importOriginal<typeof import("node:fs/promises")>()),
);

import { loadSettings, saveSettings, settingsPath } from "../src/settings/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-file-lock-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  steps.commits = 0;
});

afterEach(async () => {
  steps.beforeTakeover = undefined;
  steps.afterTakeover = undefined;
  steps.beforeTempWrite = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

type Writer = {
  name: string;
  /** The file the writers change; it exists before they start. */
  file: () => string;
  start: () => void;
  write: (actor: "a" | "b" | "c") => Promise<unknown>;
  written: () => Promise<unknown>;
  expected: unknown;
};

const SETTINGS_WRITES = {
  a: { words: { percent: "used" } },
  b: { words: { reset: "short" } },
  c: { words: { detail: "detailed" } },
} as const;

const writers: Writer[] = [
  {
    name: "settings saves",
    file: settingsPath,
    start: () => writeFileSync(settingsPath(), "{}\n"),
    write: async (actor) => {
      const result = await saveSettings(SETTINGS_WRITES[actor]);
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
    },
    written: async () => (await loadSettings()).settings.words,
    expected: { percent: "used", reset: "short", detail: "detailed" },
  },
];

describe("the file lock's fence", () => {
  it.each(writers)(
    "$name: a waiter that stalled before taking over an abandoned lock never loses an update",
    async (writer) => {
      const file = writer.file();
      const lock = `${file}.lock`;
      mkdirSync(dirname(file), { recursive: true });
      writer.start();
      steps.targetName = basename(file);
      // An abandoned lock: no owner named, and old.
      writeFileSync(lock, "");
      utimesSync(lock, 0, 0);

      // B sees the abandoned lock and stalls right before its takeover rename.
      const bStalls = steps.pause();
      steps.beforeTakeover = bStalls;
      const b = writer.write("b");
      await bStalls.reached;

      // A takes the abandoned lock over itself, enters, reads the file, and stalls before its
      // commit.
      const aStalls = steps.pause();
      steps.beforeTempWrite = aStalls;
      const a = writer.write("a");
      await aStalls.reached;
      expect(readFileSync(lock, "utf8")).toContain(String(process.pid));

      // B's stale rename now moves A's live lock. In that gap C enters, writes and leaves.
      let c: Promise<unknown> | undefined;
      steps.afterTakeover = async () => {
        c = writer.write("c");
        await c;
      };
      bStalls.go();
      await vi.waitFor(() => expect(c).toBeDefined());
      await c;

      // A's commit finds its lock gone: it writes nothing and redoes its work after B.
      aStalls.go();
      await Promise.all([a, b]);

      await expect(writer.written()).resolves.toMatchObject(writer.expected as object);
      // One commit per writer: A's round that lost its lock committed nothing.
      expect(steps.commits).toBe(3);
      expect(existsSync(lock)).toBe(false);
      const leftovers = readdirSync(dirname(file)).filter((name) => /\.(stale|tmp)-/.test(name));
      expect(leftovers).toEqual([]);
    },
  );
});
