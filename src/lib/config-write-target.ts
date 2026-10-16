import { realpathSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { type WriteJsonAtomicOptions, writeTextAtomic } from "./atomic-json.js";

export const MAX_CONFIG_SYMLINK_HOPS = 40;
export const NEW_CONFIG_FILE_MODE = 0o600;
export const NEW_CONFIG_DIRECTORY_MODE = 0o700;

type ConfigWriteTargetReason =
  | "dangling"
  | "loop"
  | "depth"
  | "non-regular"
  | "permission"
  | "changed"
  | "bytes-changed";

interface ConfigWriteHop {
  path: string;
  linkText: string;
}

export interface ConfigWriteTargetSnapshot {
  configuredPath: string;
  writePath: string;
  hops: ConfigWriteHop[];
  terminalExisted: boolean;
}

export class ConfigWriteTargetError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly reason: ConfigWriteTargetReason,
  ) {
    super(message);
    this.name = "ConfigWriteTargetError";
  }
}

function fsCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return "";
}

function isNotFound(error: unknown): boolean {
  return fsCode(error) === "ENOENT";
}

function isPermission(error: unknown): boolean {
  const code = fsCode(error);
  return code === "EACCES" || code === "EPERM";
}

function throwFsError(error: unknown, path: string): never {
  if (isPermission(error) || fsCode(error) === "ELOOP") {
    throw new ConfigWriteTargetError(
      fsCode(error) === "ELOOP"
        ? `Config symlink loop: ${path}`
        : `Cannot inspect config path: ${path}`,
      path,
      fsCode(error) === "ELOOP" ? "loop" : "permission",
    );
  }
  throw error;
}

export function configWriteTargetsEqual(
  left: ConfigWriteTargetSnapshot,
  right: ConfigWriteTargetSnapshot,
): boolean {
  return (
    left.configuredPath === right.configuredPath &&
    left.writePath === right.writePath &&
    left.terminalExisted === right.terminalExisted &&
    left.hops.length === right.hops.length &&
    left.hops.every((hop, index) => {
      const other = right.hops[index];
      return other !== undefined && hop.path === other.path && hop.linkText === other.linkText;
    })
  );
}

export function assertSameConfigWriteTarget(
  planned: ConfigWriteTargetSnapshot,
  current: ConfigWriteTargetSnapshot,
): void {
  if (configWriteTargetsEqual(planned, current)) {
    return;
  }
  throw new ConfigWriteTargetError(
    `Config write target changed since preview: ${planned.configuredPath}`,
    planned.configuredPath,
    "changed",
  );
}

export async function resolveConfigWriteTarget(path: string): Promise<ConfigWriteTargetSnapshot> {
  const configuredPath = resolve(path);
  const hops: ConfigWriteHop[] = [];
  const seen = new Set<string>();
  let current = configuredPath;

  for (;;) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) {
        if (hops.length === 0) {
          return { configuredPath, writePath: current, hops, terminalExisted: false };
        }
        throw new ConfigWriteTargetError(
          `Dangling config symlink: ${configuredPath}`,
          current,
          "dangling",
        );
      }
      throwFsError(error, current);
    }

    if (stats.isSymbolicLink()) {
      if (seen.has(current)) {
        throw new ConfigWriteTargetError(`Config symlink loop: ${configuredPath}`, current, "loop");
      }
      if (hops.length >= MAX_CONFIG_SYMLINK_HOPS) {
        throw new ConfigWriteTargetError(
          `Config symlink chain exceeds ${MAX_CONFIG_SYMLINK_HOPS} hops: ${configuredPath}`,
          current,
          "depth",
        );
      }
      seen.add(current);
      let linkText: string;
      try {
        linkText = await readlink(current);
      } catch (error) {
        throwFsError(error, current);
      }
      hops.push({ path: current, linkText });
      let parentReal: string;
      try {
        parentReal = realpathSync(dirname(current));
      } catch (error) {
        throwFsError(error, current);
      }
      current = resolve(parentReal, linkText);
      continue;
    }

    if (!stats.isFile()) {
      throw new ConfigWriteTargetError(
        `Config write target is not a regular file: ${current}`,
        current,
        "non-regular",
      );
    }

    let writePath: string;
    try {
      writePath = realpathSync(current);
    } catch (error) {
      throwFsError(error, current);
    }
    return { configuredPath, writePath, hops, terminalExisted: true };
  }
}

async function existingFileMode(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      throw new ConfigWriteTargetError(
        `Config write target is not a regular file: ${path}`,
        path,
        "non-regular",
      );
    }
    return stats.mode & 0o777;
  } catch (error) {
    if (error instanceof ConfigWriteTargetError) {
      throw error;
    }
    if (isNotFound(error)) {
      throw new ConfigWriteTargetError(
        `Config write target changed since preview: ${path}`,
        path,
        "changed",
      );
    }
    throwFsError(error, path);
  }
}

async function configurationWriteOptions(
  snapshot: ConfigWriteTargetSnapshot,
): Promise<Omit<WriteJsonAtomicOptions, "trailingNewline">> {
  const fileMode = snapshot.terminalExisted
    ? await existingFileMode(snapshot.writePath)
    : NEW_CONFIG_FILE_MODE;
  return {
    policy: "configuration",
    directoryMode: NEW_CONFIG_DIRECTORY_MODE,
    fileMode,
  };
}

export async function writeResolvedConfigText(
  snapshot: ConfigWriteTargetSnapshot,
  content: string,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  const options = await configurationWriteOptions(snapshot);
  await writeTextAtomic(snapshot.writePath, content, { ...options, beforeCommit });
}
