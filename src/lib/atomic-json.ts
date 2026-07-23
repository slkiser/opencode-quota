import { mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";
import { stringifyWithComments } from "./jsonc.js";

export interface WriteJsonAtomicOptions {
  trailingNewline?: boolean;
  mode?: number;
  /** Whether retryable rename errors may replace an existing destination. */
  replaceOnRenameError?: boolean;
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
  await writeTextAtomic(path, content, {
    mode: opts.mode,
    replaceOnRenameError: opts.replaceOnRenameError,
  });
}

export async function writeTextAtomic(
  path: string,
  content: string,
  opts: { mode?: number; replaceOnRenameError?: boolean } = {},
): Promise<void> {
  const dir = dirname(path);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  await mkdir(dir, { recursive: true });
  await writeFile(
    tmp,
    content,
    opts.mode === undefined ? "utf-8" : { encoding: "utf-8", mode: opts.mode },
  );

  try {
    await rename(tmp, path);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    const shouldRetryAsReplace =
      opts.replaceOnRenameError !== false &&
      (code === "EPERM" || code === "EEXIST" || code === "EACCES" || code === "ENOTEMPTY");

    if (!shouldRetryAsReplace) {
      await safeRm(tmp);
      throw err;
    }

    await safeRm(path);
    await rename(tmp, path);
  }
}
