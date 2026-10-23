import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

import {
  configWriteTargetsEqual,
  ConfigWriteTargetError,
  type ConfigWriteTargetSnapshot,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "./config-write-target.js";
import { isRecord } from "./json-guards.js";
import {
  type ConfigFileFormat,
  type EditableConfigPath,
  parseOpenCodeConfig,
} from "./opencode-config-files.js";

interface ManagedConfigComment {
  path: (string | number)[];
  text: string;
}

interface ConfigDocumentEdit {
  path: string;
  format: ConfigFileFormat;
  originalBytes: Buffer | null;
  writeTarget: ConfigWriteTargetSnapshot;
  updated: string;
  changed: boolean;
}

export class ConfigDocumentError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ConfigDocumentError";
  }
}

function asConfigDocumentError(error: unknown, fallbackPath: string): never {
  if (error instanceof ConfigDocumentError) {
    throw error;
  }
  if (error instanceof ConfigWriteTargetError) {
    throw new ConfigDocumentError(error.message, error.path);
  }
  throw error instanceof Error
    ? error
    : new ConfigDocumentError(`Failed inspecting config: ${fallbackPath}`, fallbackPath);
}

/** Parses either file kind the way OpenCode does: comments and trailing commas are allowed. */
export function parseConfigDocument(raw: string, path: string): Record<string, unknown> {
  const config = parseOpenCodeConfig(raw);
  if (!config) {
    throw new ConfigDocumentError(`Cannot parse config: ${path}`, path);
  }
  return config;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function collectValueEdits(
  current: unknown,
  desired: unknown,
  path: (string | number)[],
  edits: Array<{ path: (string | number)[]; value: unknown }>,
): void {
  if (jsonEqual(current, desired)) {
    return;
  }

  if (isRecord(current) && isRecord(desired)) {
    for (const [key, value] of Object.entries(desired)) {
      collectValueEdits(current[key], value, [...path, key], edits);
    }
    return;
  }

  edits.push({ path, value: desired });
}

function addManagedComment(raw: string, comment: ManagedConfigComment): string {
  if (raw.includes(comment.text)) {
    return raw;
  }

  const tree = parseTree(raw, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const valueNode = tree ? findNodeAtLocation(tree, comment.path) : undefined;
  const propertyNode = valueNode?.parent;
  if (!propertyNode || propertyNode.type !== "property") {
    return raw;
  }

  const lineStart = raw.lastIndexOf("\n", propertyNode.offset - 1) + 1;
  const indentation = raw.slice(lineStart, propertyNode.offset);
  if (!/^\s*$/.test(indentation)) {
    return raw;
  }

  return raw.slice(0, lineStart) + `${indentation}${comment.text}\n` + raw.slice(lineStart);
}

function editConfigDocument(params: {
  raw: string;
  format: ConfigFileFormat;
  path: string;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
}): string {
  const current = parseConfigDocument(params.raw, params.path);
  const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
  collectValueEdits(current, params.desiredData, [], edits);

  const eol = params.raw.includes("\r\n") ? "\r\n" : "\n";
  let updated = params.raw;
  for (const edit of edits) {
    updated = applyEdits(
      updated,
      modify(updated, edit.path, edit.value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol,
        },
      }),
    );
  }

  if (params.format === "jsonc") {
    for (const comment of params.managedComments ?? []) {
      updated = addManagedComment(updated, comment);
    }
  }

  if (!updated.endsWith(eol)) {
    updated += eol;
  }

  parseConfigDocument(updated, params.path);
  return updated;
}

export async function planConfigDocumentEdit(params: {
  target: EditableConfigPath;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
}): Promise<ConfigDocumentEdit> {
  let writeTarget: ConfigWriteTargetSnapshot;
  try {
    writeTarget = await resolveConfigWriteTarget(params.target.path);
  } catch (error) {
    asConfigDocumentError(error, params.target.path);
  }

  const originalBytes = params.target.existed ? await readFile(writeTarget.writePath) : null;
  const raw = originalBytes?.toString("utf8") ?? "{}\n";
  const updated = editConfigDocument({
    raw,
    format: params.target.format,
    path: params.target.path,
    desiredData: params.desiredData,
    managedComments: params.managedComments,
  });

  return {
    path: params.target.path,
    format: params.target.format,
    originalBytes,
    writeTarget,
    updated,
    changed: updated !== raw || !params.target.existed,
  };
}

async function validateConfigDocumentEdit(edit: ConfigDocumentEdit): Promise<void> {
  const writePath = edit.writeTarget.writePath;
  if (edit.originalBytes === null) {
    if (existsSync(writePath)) {
      throw new ConfigDocumentError(`Config changed since preview: ${edit.path}`, edit.path);
    }
  } else {
    let current: Buffer;
    try {
      current = await readFile(writePath);
    } catch {
      throw new ConfigDocumentError(`Failed reading config: ${edit.path}`, edit.path);
    }
    if (!current.equals(edit.originalBytes)) {
      throw new ConfigDocumentError(`Config changed since preview: ${edit.path}`, edit.path);
    }
  }
}

export async function applyConfigDocumentEdit(edit: ConfigDocumentEdit): Promise<void> {
  if (!edit.changed) {
    return;
  }

  await validateConfigDocumentEdit(edit);

  try {
    const currentTarget = await resolveConfigWriteTarget(edit.path);
    if (!configWriteTargetsEqual(edit.writeTarget, currentTarget)) {
      throw new ConfigDocumentError(
        `Config write target changed since preview: ${edit.path}`,
        edit.path,
      );
    }
    await writeResolvedConfigText(currentTarget, edit.updated);
  } catch (error) {
    asConfigDocumentError(error, edit.path);
  }
}
