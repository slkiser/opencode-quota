import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function safeRm(targetPath) {
  try {
    await rm(targetPath, { force: true, recursive: true });
  } catch {
    // best-effort cleanup
  }
}

export async function replacePath(sourcePath, targetPath) {
  await mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await rename(sourcePath, targetPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const shouldReplace =
      code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "ENOTEMPTY";

    if (!shouldReplace) throw error;

    await safeRm(targetPath);
    await rename(sourcePath, targetPath);
  }
}
