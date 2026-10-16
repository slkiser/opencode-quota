/**
 * A lock file next to a file that several OpenCode processes change: it holds its owner's pid
 * and a random token. Only one process at a time creates it; a lock whose owner is gone is taken
 * over in one atomic rename. The settings file uses it, so a read, change and write never
 * interleaves with another one.
 *
 * A waiter that saw an abandoned lock and stalled can rename a lock another process has just
 * created. So the holder's write checks its token right before it commits (the fence): a holder
 * that lost its lock writes nothing and redoes its read, change and write under a new lock.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_STALE_MS = 10_000;
const LOCK_FILE_MODE = 0o600;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";

/** What a lock file of this process holds: our pid and a token of our own. */
function lockOwnerText(token: string): string {
  return JSON.stringify({ pid: process.pid, token });
}

/** Creates `path` holding `text`; false when it already exists. */
async function createExclusive(path: string, text: string): Promise<boolean> {
  try {
    await writeFile(path, text, { flag: "wx", mode: LOCK_FILE_MODE });
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

type LockFile = { text: string; mtimeMs: number };

async function readLock(path: string): Promise<LockFile | undefined> {
  const stats = await lstat(path).catch(() => undefined);
  return stats && { text: await readFile(path, "utf8").catch(() => ""), mtimeMs: stats.mtimeMs };
}

/** Its owner is gone: the process it names died, or it names none and is older than 10 s. */
function isAbandoned(lock: LockFile): boolean {
  let pid: unknown;
  try {
    pid = (JSON.parse(lock.text) as { pid?: unknown }).pid;
  } catch {
    // Empty or unreadable: only its age tells.
  }
  if (!(typeof pid === "number" && Number.isInteger(pid) && pid > 0)) {
    return Date.now() - lock.mtimeMs > LOCK_STALE_MS;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

/**
 * Takes over an abandoned lock in one atomic step, a rename: only one waiter's rename finds it.
 * It never enters the lock itself; the caller then tries to create a lock of its own. A lock
 * renamed that is not the one seen abandoned was just created by another process: it is not put
 * back (that owner's fence makes it redo its work), because a lock put back after a third
 * process entered and left would let that owner's fence pass on data read before.
 */
async function claimAbandoned(lock: string, token: string): Promise<void> {
  const seen = await readLock(lock);
  if (!seen || !isAbandoned(seen)) return;
  const claimed = `${lock}.stale-${token}`;
  const lost = await rename(lock, claimed).then(
    () => false,
    () => true,
  );
  if (lost) return; // Another waiter renamed it first.
  await rm(claimed, { force: true });
}

/** Removes the lock only while it is still ours. */
async function releaseLock(lock: string, mine: string): Promise<void> {
  if ((await readFile(lock, "utf8").catch(() => "")) === mine) await rm(lock, { force: true });
}

/**
 * The lock was taken over, or what the work read changed, while it ran: nothing was written, and
 * the work runs again.
 */
export class LockLostError extends Error {}

/**
 * Throws when the lock no longer holds our token. Call it right before the write that commits
 * (the atomic rename over the file). A takeover between this check and that rename still slips
 * through: a window of microseconds that also needs a waiter that stalled since it saw an
 * abandoned lock.
 */
export type LockFence = () => Promise<void>;

/**
 * Runs `work` while holding the lock file `lock`, making its folder (mode 700) first. `work`
 * calls the fence it gets right before it commits; when the lock was lost, the work runs again
 * under a new lock. After `waitMs` without the lock it fails with `busyMessage`.
 */
export async function withFileLock<T>(
  lock: string,
  work: (fence: LockFence) => Promise<T>,
  options: { waitMs: number; busyMessage: string },
): Promise<T> {
  const token = randomUUID();
  const mine = lockOwnerText(token);
  const fence: LockFence = async () => {
    const now = await readFile(lock, "utf8").catch(() => "");
    if (now !== mine) throw new LockLostError(`${lock} was taken over; trying again`);
  };
  const start = Date.now();
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  for (;;) {
    if (await createExclusive(lock, mine)) {
      try {
        return await work(fence);
      } catch (error) {
        if (!(error instanceof LockLostError)) throw error;
      } finally {
        await releaseLock(lock, mine);
      }
    } else {
      await claimAbandoned(lock, token);
    }
    if (Date.now() - start > options.waitMs) throw new Error(options.busyMessage);
    await sleep(20);
  }
}
