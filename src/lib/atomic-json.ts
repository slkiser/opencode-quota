import { lstat, mkdir, readlink, rename, rm, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { stringifyWithComments } from "./jsonc.js";

export interface WriteJsonAtomicOptions {
  trailingNewline?: boolean;
  directoryMode?: number;
  fileMode?: number;
}

const MAX_SYMLINK_DEPTH = 8;

/**
 * Resolve the real file a destination points at.
 *
 * An atomic write ends in `rename()`, which replaces the path itself rather
 * than following it. When the destination is a symlink - the usual shape for a
 * config file linked into a dotfiles repository - renaming over it silently
 * detaches the link and leaves a plain file behind, so later edits stop
 * reaching the original target. Resolving first keeps the write atomic while
 * preserving the link.
 *
 * A missing destination, a dangling link, or a cycle longer than
 * `MAX_SYMLINK_DEPTH` resolves to the last path reached, which the caller then
 * writes as a regular file.
 */
async function resolveWriteTarget(path: string): Promise<string> {
  let current = path;

  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth += 1) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch {
      return current;
    }

    if (!stats.isSymbolicLink()) {
      return current;
    }

    current = resolve(dirname(current), await readlink(current));
  }

  return current;
}

async function safeRm(target: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch {
    // best-effort cleanup
  }
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {},
): Promise<void> {
  // Use the comment-preserving stringifier here instead of JSON.stringify.
  const content = stringifyWithComments(data) + (opts.trailingNewline ? "\n" : "");
  await writeTextAtomic(path, content, opts);
}

export async function writeTextAtomic(
  path: string,
  content: string,
  opts: Omit<WriteJsonAtomicOptions, "trailingNewline"> = {},
): Promise<void> {
  const target = await resolveWriteTarget(path);
  const dir = dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(
    dir,
    opts.directoryMode === undefined
      ? { recursive: true }
      : { recursive: true, mode: opts.directoryMode },
  );

  try {
    await writeFile(
      tmp,
      content,
      opts.fileMode === undefined ? "utf-8" : { encoding: "utf-8", mode: opts.fileMode },
    );
  } catch (writeError) {
    await safeRm(tmp);
    throw writeError;
  }

  try {
    await rename(tmp, target);
  } catch (renameError) {
    const code =
      renameError && typeof renameError === "object" && "code" in renameError
        ? String((renameError as { code?: unknown }).code)
        : "";
    const shouldRetryAsReplace =
      code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY";

    if (!shouldRetryAsReplace) {
      await safeRm(tmp);
      throw renameError;
    }

    await safeRm(target);
    try {
      await rename(tmp, target);
    } catch (replaceError) {
      await safeRm(tmp);
      throw replaceError;
    }
  }
}
