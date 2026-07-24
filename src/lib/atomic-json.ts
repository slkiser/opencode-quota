import { mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { stringifyWithComments } from "./jsonc.js";

export interface WriteJsonAtomicOptions {
  trailingNewline?: boolean;
  directoryMode?: number;
  fileMode?: number;
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
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    await rename(tmp, path);
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

    await safeRm(path);
    try {
      await rename(tmp, path);
    } catch (replaceError) {
      await safeRm(tmp);
      throw replaceError;
    }
  }
}
