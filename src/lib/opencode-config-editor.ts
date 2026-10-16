import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";

import type { ConfigFileFormat, EditableConfigPath } from "./config-file-utils.js";
import {
  assertSameConfigWriteTarget,
  ConfigWriteTargetError,
  type ConfigWriteTargetSnapshot,
  resolveConfigWriteTarget,
  writeResolvedConfigText,
} from "./config-write-target.js";
import { isRecord } from "./json-guards.js";

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

function parseErrors(
  raw: string,
  format: ConfigFileFormat,
): {
  value: unknown;
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const value = parse(raw, errors, {
    allowTrailingComma: format === "jsonc",
    disallowComments: format === "json",
  });
  return { value, errors };
}

export function parseConfigDocument(
  raw: string,
  format: ConfigFileFormat,
  path: string,
): Record<string, unknown> {
  const parsed = parseErrors(raw, format);
  if (parsed.errors.length > 0) {
    throw new ConfigDocumentError(`Cannot parse ${format.toUpperCase()} config: ${path}`, path);
  }
  if (!isRecord(parsed.value)) {
    throw new ConfigDocumentError(`Config root must be an object: ${path}`, path);
  }
  return parsed.value;
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

  if (Array.isArray(current) && Array.isArray(desired)) {
    const prefixMatches =
      desired.length >= current.length &&
      current.every((value, index) => jsonEqual(value, desired[index]));
    if (prefixMatches) {
      for (let index = current.length; index < desired.length; index++) {
        edits.push({ path: [...path, -1], value: desired[index] });
      }
      return;
    }

    const keyedObjectPrefixMatches =
      desired.length >= current.length &&
      current.every((value, index) => {
        const desiredValue = desired[index];
        return (
          isRecord(value) &&
          isRecord(desiredValue) &&
          typeof value.id === "string" &&
          value.id === desiredValue.id
        );
      });
    if (keyedObjectPrefixMatches) {
      for (let index = 0; index < current.length; index++) {
        const currentValue = current[index] as Record<string, unknown>;
        const desiredValue = desired[index] as Record<string, unknown>;
        for (const key of Object.keys(currentValue)) {
          if (!Object.hasOwn(desiredValue, key)) {
            edits.push({ path: [...path, index, key], value: undefined });
          }
        }
        collectValueEdits(currentValue, desiredValue, [...path, index], edits);
      }
      for (let index = current.length; index < desired.length; index++) {
        edits.push({ path: [...path, -1], value: desired[index] });
      }
      return;
    }

    if (desired.length < current.length) {
      let desiredIndex = 0;
      const removedIndexes: number[] = [];
      for (let currentIndex = 0; currentIndex < current.length; currentIndex++) {
        if (
          desiredIndex < desired.length &&
          jsonEqual(current[currentIndex], desired[desiredIndex])
        ) {
          desiredIndex++;
        } else {
          removedIndexes.push(currentIndex);
        }
      }
      if (desiredIndex === desired.length) {
        for (const removedIndex of removedIndexes.reverse()) {
          edits.push({ path: [...path, removedIndex], value: undefined });
        }
        return;
      }
    }
  }

  edits.push({ path, value: desired });
}

function removeArrayElementPreservingSiblings(
  raw: string,
  path: (string | number)[],
): string | undefined {
  const tree = parseTree(raw, [], {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const node = tree ? findNodeAtLocation(tree, path) : undefined;
  const parent = node?.parent;
  if (!node || !parent || parent.type !== "array" || !parent.children) {
    return undefined;
  }

  const index = parent.children.indexOf(node);
  if (index < 0) return undefined;

  if (parent.children.length === 1) {
    return raw.slice(0, node.offset) + raw.slice(node.offset + node.length);
  }

  if (index < parent.children.length - 1) {
    const next = parent.children[index + 1];
    const between = raw.slice(node.offset + node.length, next.offset);
    const commaOffset = between.indexOf(",");
    if (commaOffset < 0) return undefined;
    const removeEnd = node.offset + node.length + commaOffset + 1;
    return raw.slice(0, node.offset) + raw.slice(removeEnd);
  }

  const previous = parent.children[index - 1];
  const between = raw.slice(previous.offset + previous.length, node.offset);
  const commaOffset = between.lastIndexOf(",");
  if (commaOffset < 0) return undefined;
  const removeStart = previous.offset + previous.length + commaOffset;
  return raw.slice(0, removeStart) + raw.slice(node.offset + node.length);
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
  const current = parseConfigDocument(params.raw, params.format, params.path);
  const edits: Array<{ path: (string | number)[]; value: unknown }> = [];
  collectValueEdits(current, params.desiredData, [], edits);

  const eol = params.raw.includes("\r\n") ? "\r\n" : "\n";
  let updated = params.raw;
  for (const edit of edits) {
    const removed =
      edit.value === undefined
        ? removeArrayElementPreservingSiblings(updated, edit.path)
        : undefined;
    updated =
      removed ??
      applyEdits(
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

  parseConfigDocument(updated, params.format, params.path);
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

async function validateConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
  } = {},
): Promise<void> {
  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const pathExists = options.pathExists ?? existsSync;

  const writePath = edit.writeTarget.writePath;
  if (edit.originalBytes === null) {
    if (pathExists(writePath)) {
      throw new ConfigDocumentError(`Config changed since preview: ${edit.path}`, edit.path);
    }
  } else {
    let current: Buffer;
    try {
      current = await readBytes(writePath);
    } catch {
      throw new ConfigDocumentError(`Failed reading config: ${edit.path}`, edit.path);
    }
    if (!current.equals(edit.originalBytes)) {
      throw new ConfigDocumentError(`Config changed since preview: ${edit.path}`, edit.path);
    }
  }
}

export async function applyConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
    writeText?: (path: string, content: string) => Promise<void>;
  } = {},
): Promise<void> {
  if (!edit.changed) {
    return;
  }

  await validateConfigDocumentEdit(edit, options);

  try {
    const currentTarget = await resolveConfigWriteTarget(edit.path);
    assertSameConfigWriteTarget(edit.writeTarget, currentTarget);
    if (options.writeText) {
      await options.writeText(currentTarget.writePath, edit.updated);
    } else {
      await writeResolvedConfigText(currentTarget, edit.updated);
    }
  } catch (error) {
    asConfigDocumentError(error, edit.path);
  }
}
