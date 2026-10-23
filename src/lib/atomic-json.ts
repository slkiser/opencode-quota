import { chmod, mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname } from "path";

type AtomicWritePolicy = "ordinary" | "configuration";

export interface WriteJsonAtomicOptions {
  trailingNewline?: boolean;
  directoryMode?: number;
  fileMode?: number;
  /** Default ordinary. Configuration never deletes the destination; it only removes the temp file. */
  policy?: AtomicWritePolicy;
  /** Runs after the temp file is written, right before it replaces `path`; throwing writes nothing. */
  beforeCommit?: () => Promise<void>;
}

async function safeRm(target: string): Promise<void> {
  try {
    await rm(target, { force: true });
  } catch {
    // best-effort cleanup
  }
}

function renameErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "";
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {},
): Promise<void> {
  const content = JSON.stringify(data, null, 2) + (opts.trailingNewline ? "\n" : "");
  await writeTextAtomic(path, content, opts);
}

export async function writeTextAtomic(
  path: string,
  content: string,
  opts: Omit<WriteJsonAtomicOptions, "trailingNewline"> = {},
): Promise<void> {
  const policy = opts.policy ?? "ordinary";
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
    if (policy === "configuration" && opts.fileMode !== undefined && process.platform !== "win32") {
      await chmod(tmp, opts.fileMode);
    }
    await opts.beforeCommit?.();
  } catch (writeError) {
    await safeRm(tmp);
    throw writeError;
  }

  try {
    await rename(tmp, path);
  } catch (renameError) {
    if (policy === "configuration") {
      await safeRm(tmp);
      throw renameError;
    }

    const code = renameErrorCode(renameError);
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
