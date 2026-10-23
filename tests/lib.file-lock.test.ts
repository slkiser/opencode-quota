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
 * Pauses the file system at the steps of Sol's interleaving: a waiter that just read an
 * abandoned lock, and a holder past its fence, about to write its commit.
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
    /** The lock file's name: reads of it and creates that find it taken are watched. */
    lockName: "",
    afterLockRead: undefined as ReturnType<typeof pause> | undefined,
    beforeCommit: undefined as ReturnType<typeof pause> | undefined,
    onLockTaken: undefined as (() => void) | undefined,
    /** Renames onto a file with this name: the commits. */
    targetName: "",
    commits: 0,
  };
});

const fsWithSteps = vi.hoisted(() => (actual: typeof import("node:fs/promises")) => {
  const nameOf = (path: unknown) => String(path).split(/[\\/]/).pop();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const text = await actual.readFile(...args);
      if (nameOf(args[0]) === steps.lockName) {
        const step = steps.afterLockRead;
        steps.afterLockRead = undefined;
        await step?.hold();
      }
      return text;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      try {
        return await actual.writeFile(...args);
      } catch (error) {
        const taken = (error as { code?: unknown }).code === "EEXIST";
        if (taken && nameOf(args[0]) === steps.lockName) {
          const then = steps.onLockTaken;
          steps.onLockTaken = undefined;
          then?.();
        }
        throw error;
      }
    },
    rename: async (from: string, to: string) => {
      if (String(from).includes(".tmp-")) {
        const step = steps.beforeCommit;
        steps.beforeCommit = undefined;
        await step?.hold();
      }
      await actual.rename(from, to);
      if (nameOf(to) === steps.targetName) steps.commits += 1;
    },
  };
});

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
  steps.afterLockRead = undefined;
  steps.beforeCommit = undefined;
  steps.onLockTaken = undefined;
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

type Writer = {
  name: string;
  /** The file the writers change; it exists before they start. */
  file: () => string;
  start: () => void;
  write: (actor: "a" | "b") => Promise<unknown>;
  written: () => Promise<unknown>;
  expected: unknown;
};

const SETTINGS_WRITES = {
  a: { words: { percent: "used" } },
  b: { words: { reset: "short" } },
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
    expected: { percent: "used", reset: "short" },
  },
];

describe("the file lock's takeover", () => {
  it.each(writers)(
    "$name: a waiter that saw an abandoned lock never removes the lock taken since",
    async (writer) => {
      const file = writer.file();
      const lock = `${file}.lock`;
      mkdirSync(dirname(file), { recursive: true });
      writer.start();
      steps.targetName = basename(file);
      steps.lockName = basename(lock);
      // An abandoned lock: no owner named, and old.
      writeFileSync(lock, "");
      utimesSync(lock, 0, 0);

      // B reads the abandoned lock and stalls right after.
      const bStalls = steps.pause();
      steps.afterLockRead = bStalls;
      const b = writer.write("b");
      await bStalls.reached;

      // A takes the abandoned lock over, enters, passes its fence and stalls before its commit.
      const aStalls = steps.pause();
      steps.beforeCommit = aStalls;
      const a = writer.write("a");
      await aStalls.reached;
      const aLock = readFileSync(lock, "utf8");
      expect(aLock).toContain(String(process.pid));

      // B goes on from what it read: it leaves A's live lock alone and waits for it.
      const bFindsItTaken = new Promise<void>((resolve) => {
        steps.onLockTaken = resolve;
      });
      bStalls.go();
      await Promise.race([b, bFindsItTaken]);
      expect(existsSync(lock) && readFileSync(lock, "utf8")).toBe(aLock);

      aStalls.go();
      await Promise.all([a, b]);
      await expect(writer.written()).resolves.toMatchObject(writer.expected as object);
      expect(steps.commits).toBe(2);
      expect(existsSync(lock)).toBe(false);
      const leftovers = readdirSync(dirname(file)).filter((name) =>
        /\.(claim|stale-|tmp-)/.test(name),
      );
      expect(leftovers).toEqual([]);
    },
  );
});
