import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";

import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
  type ParseError,
} from "jsonc-parser";

import { writeTextAtomic } from "./atomic-json.js";
import type { ConfigFileFormat, EditableConfigPath } from "./config-file-utils.js";

export interface ManagedConfigComment {
  path: (string | number)[];
  text: string;
}

export interface ConfigDocumentEdit {
  path: string;
  sourcePath: string;
  removeSourcePath?: string;
  format: ConfigFileFormat;
  originalBytes: Buffer | null;
  targetOriginalBytes: Buffer | null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  if (!isPlainObject(parsed.value)) {
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

  if (isPlainObject(current) && isPlainObject(desired)) {
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

export function editConfigDocumentPaths(params: {
  raw: string;
  format: ConfigFileFormat;
  path: string;
  edits: Array<{ path: (string | number)[]; value: unknown }>;
}): string {
  let updated = params.raw;
  for (const edit of params.edits) {
    const removed =
      edit.value === undefined
        ? removeArrayElementPreservingSiblings(updated, edit.path)
        : undefined;
    updated = removed ?? applyEdits(updated, modify(updated, edit.path, edit.value, {}));
  }
  parseConfigDocument(updated, params.format, params.path);
  return updated;
}

export function editConfigDocument(params: {
  raw: string;
  sourceFormat: ConfigFileFormat;
  outputFormat: ConfigFileFormat;
  path: string;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
}): string {
  const current = parseConfigDocument(params.raw, params.sourceFormat, params.path);
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

  if (params.outputFormat === "jsonc") {
    for (const comment of params.managedComments ?? []) {
      updated = addManagedComment(updated, comment);
    }
  }

  if (!updated.endsWith(eol)) {
    updated += eol;
  }

  parseConfigDocument(updated, params.outputFormat, params.path);
  return updated;
}

export async function planConfigDocumentEdit(params: {
  target: EditableConfigPath;
  desiredData: Record<string, unknown>;
  managedComments?: ManagedConfigComment[];
}): Promise<ConfigDocumentEdit> {
  const originalBytes = params.target.existed ? await readFile(params.target.sourcePath) : null;
  const originalRaw = originalBytes?.toString("utf8") ?? "{}\n";
  const sourceFormat: ConfigFileFormat = params.target.sourcePath.endsWith(".jsonc")
    ? "jsonc"
    : "json";
  const convertingJsonToJsonc = sourceFormat === "json" && params.target.format === "jsonc";
  const raw = convertingJsonToJsonc ? "{}\n" : originalRaw;
  const updated = editConfigDocument({
    raw,
    sourceFormat,
    outputFormat: params.target.format,
    path: params.target.path,
    desiredData: params.desiredData,
    managedComments: params.managedComments,
  });
  const targetOriginalBytes =
    params.target.path === params.target.sourcePath
      ? originalBytes
      : existsSync(params.target.path)
        ? await readFile(params.target.path)
        : null;

  return {
    path: params.target.path,
    sourcePath: params.target.sourcePath,
    removeSourcePath: params.target.removeSourcePath,
    format: params.target.format,
    originalBytes,
    targetOriginalBytes,
    updated,
    changed:
      updated !== raw || params.target.path !== params.target.sourcePath || !params.target.existed,
  };
}

export async function validateConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
  } = {},
): Promise<void> {
  if (!edit.changed) {
    return;
  }

  const readBytes = options.readBytes ?? ((path: string) => readFile(path));
  const pathExists = options.pathExists ?? existsSync;

  if (edit.originalBytes === null) {
    if (pathExists(edit.sourcePath)) {
      throw new ConfigDocumentError(
        `Config changed since preview: ${edit.sourcePath}`,
        edit.sourcePath,
      );
    }
  } else {
    let current: Buffer;
    try {
      current = await readBytes(edit.sourcePath);
    } catch {
      throw new ConfigDocumentError(`Failed reading config: ${edit.sourcePath}`, edit.sourcePath);
    }
    if (!current.equals(edit.originalBytes)) {
      throw new ConfigDocumentError(
        `Config changed since preview: ${edit.sourcePath}`,
        edit.sourcePath,
      );
    }
  }

  if (edit.path !== edit.sourcePath) {
    if (edit.targetOriginalBytes === null) {
      if (pathExists(edit.path)) {
        throw new ConfigDocumentError(
          `Config target appeared since preview: ${edit.path}`,
          edit.path,
        );
      }
    } else {
      let currentTarget: Buffer;
      try {
        currentTarget = await readBytes(edit.path);
      } catch {
        throw new ConfigDocumentError(`Failed reading config target: ${edit.path}`, edit.path);
      }
      if (!currentTarget.equals(edit.targetOriginalBytes)) {
        throw new ConfigDocumentError(
          `Config target changed since preview: ${edit.path}`,
          edit.path,
        );
      }
    }
  }
}

export async function applyConfigDocumentEdit(
  edit: ConfigDocumentEdit,
  options: {
    readBytes?: (path: string) => Promise<Buffer>;
    pathExists?: (path: string) => boolean;
    writeText?: (path: string, content: string) => Promise<void>;
    removePath?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
  if (!edit.changed) {
    return;
  }

  await validateConfigDocumentEdit(edit, options);

  const writeText = options.writeText ?? writeTextAtomic;
  const removePath = options.removePath ?? ((path: string) => rm(path));
  await writeText(edit.path, edit.updated);

  if (!edit.removeSourcePath) {
    return;
  }

  try {
    await removePath(edit.removeSourcePath);
  } catch {
    if (edit.targetOriginalBytes === null) {
      try {
        await removePath(edit.path);
      } catch {
        // Best effort: the original source is still intact and remains the rollback authority.
      }
    }
    throw new ConfigDocumentError(
      `Failed removing converted config source: ${edit.removeSourcePath}`,
      edit.removeSourcePath,
    );
  }
}
