import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  applyConfigDocumentEdit,
  parseConfigDocument,
  planConfigDocumentEdit,
  validateConfigDocumentEdit,
  type ConfigDocumentEdit,
  type ManagedConfigComment,
} from "./opencode-config-editor.js";
import { resolveEditableConfigPath, type ConfigFileFormat } from "./config-file-utils.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import {
  MAINTAINED_LOCAL_ESTIMATE_IDS,
  QUOTA_PROVIDERS_AGGREGATE_ID,
  validateQuotaProviders,
  type QuotaProviderDefinition,
} from "./quota-providers.js";

type JsonObject = Record<string, unknown>;

export interface ProviderAddPlan {
  path: string;
  format: ConfigFileFormat;
  definition: QuotaProviderDefinition;
  updated: string;
  changed: boolean;
  ordinaryProviderRequired: boolean;
  documentEdit: ConfigDocumentEdit;
  additionalDocumentEdits: ConfigDocumentEdit[];
}

export interface ProviderAddOptions {
  definition: unknown;
  configDir?: string;
  preferredFormat?: ConfigFileFormat;
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toPublicDefinition(definition: QuotaProviderDefinition): JsonObject {
  const result = cloneJson(definition) as unknown as JsonObject;
  if (definition.providerId === definition.id) delete result.providerId;
  return result;
}

function ensureObject(parent: JsonObject, key: string, path: string): JsonObject {
  if (!(key in parent)) {
    const child: JsonObject = {};
    parent[key] = child;
    return child;
  }
  if (!isPlainObject(parent[key])) throw new Error(path + " must be an object");
  return parent[key];
}

function managedComments(
  index: number,
  definition: QuotaProviderDefinition,
): ManagedConfigComment[] {
  const base: (string | number)[] = ["experimental", "quotaToast", "quotaProviders", index];
  const comments: ManagedConfigComment[] = [
    {
      path: ["experimental"],
      text: "// Plugin settings accepted by OpenCode's global config schema.",
    },
    {
      path: ["experimental", "quotaToast"],
      text: "// OpenCode Quota settings. Project quota-provider definitions are never trusted.",
    },
    {
      path: ["experimental", "quotaToast", "quotaProviders"],
      text: "// Ordered global-only definitions. Stable ids control state, cache, and provenance.",
    },
    {
      path: [...base, "id"],
      text: "// Stable definition id; also the OpenCode provider id by default.",
    },
    {
      path: [...base, "mode"],
      text: "// Exactly one acquisition mode: remote-api or local-estimate.",
    },
  ];

  if (definition.providerId !== definition.id) {
    comments.push({
      path: [...base, "providerId"],
      text: "// OpenCode provider id because it differs from the stable definition id.",
    });
  }
  if (definition.modelIds) {
    comments.push({
      path: [...base, "modelIds"],
      text: "// Optional exact OpenCode model ids; omission covers the whole provider.",
    });
  }
  if (definition.mode === "remote-api") {
    comments.push(
      {
        path: [...base, "url"],
        text: "// Fixed authenticated GET endpoint. HTTPS is required except on loopback.",
      },
      {
        path: [...base, "format"],
        text: "// Safe response contract: accounting-v1 or openrouter-key-v1.",
      },
    );
    if (definition.apiKeyEnv) {
      comments.push({
        path: [...base, "apiKeyEnv"],
        text: "// Environment variable name only. The command never writes its secret value.",
      });
    }
  } else {
    comments.push({
      path: [...base, "windows"],
      text: "// Request limits over explicit UTC-day or bounded rolling windows.",
    });
    if (definition.pricingModelMap) {
      comments.push({
        path: [...base, "pricingModelMap"],
        text: "// Manual models.dev fallback only where automatic matching cannot decide.",
      });
    }
  }
  return comments;
}

function sidecarManagedComments(
  index: number,
  definition: QuotaProviderDefinition,
): ManagedConfigComment[] {
  return managedComments(index, definition)
    .filter((comment) => comment.path.length > 2)
    .map((comment) => ({ ...comment, path: comment.path.slice(2) }));
}

export async function planProviderAdd(options: ProviderAddOptions): Promise<ProviderAddPlan> {
  const single = validateQuotaProviders([options.definition]);
  if (!single.value) {
    throw new Error(single.issues.map((issue) => issue.key + ": " + issue.message).join("\n"));
  }
  const definition = single.value[0]!;
  const configDir = options.configDir ?? getOpencodeRuntimeDirs().configDir;

  const sidecarCandidates = ["quota-toast.jsonc", "quota-toast.json"].map((name) =>
    join(configDir, "opencode-quota", name),
  );
  let selectedSidecar: { path: string; format: ConfigFileFormat; root: JsonObject } | undefined;
  let malformedSidecarPath: string | undefined;
  for (const path of sidecarCandidates) {
    if (!existsSync(path)) continue;
    const format: ConfigFileFormat = path.endsWith(".jsonc") ? "jsonc" : "json";
    try {
      selectedSidecar = {
        path,
        format,
        root: parseConfigDocument(await readFile(path, "utf8"), format, path),
      };
      break;
    } catch {
      malformedSidecarPath ??= path;
    }
  }
  if (!selectedSidecar && malformedSidecarPath) {
    throw new Error("Cannot parse existing quota sidecar: " + malformedSidecarPath);
  }

  const hostTarget = resolveEditableConfigPath({
    dir: configDir,
    kind: "opencode",
    preferredFormat: options.preferredFormat ?? "jsonc",
    convertJsonToJsonc: false,
  });
  const hostRoot = hostTarget.existed
    ? parseConfigDocument(
        await readFile(hostTarget.sourcePath, "utf8"),
        hostTarget.sourcePath.endsWith(".jsonc") ? "jsonc" : "json",
        hostTarget.sourcePath,
      )
    : {};
  const ordinaryProviders = isPlainObject(hostRoot.provider) ? hostRoot.provider : {};

  let target: {
    path: string;
    sourcePath: string;
    format: ConfigFileFormat;
    existed: boolean;
  };
  let root: JsonObject;
  let quotaToast: JsonObject;
  if (selectedSidecar) {
    target = {
      path: selectedSidecar.path,
      sourcePath: selectedSidecar.path,
      format: selectedSidecar.format,
      existed: true,
    };
    root = selectedSidecar.root;
    quotaToast = root;
  } else {
    target = hostTarget;
    root = hostTarget.existed ? hostRoot : { $schema: "https://opencode.ai/config.json" };
    const experimental = ensureObject(root, "experimental", "experimental");
    quotaToast = ensureObject(experimental, "quotaToast", "experimental.quotaToast");
  }

  if ("customSources" in quotaToast) {
    throw new Error("customSources was removed; delete it before adding quotaProviders");
  }
  const existing = quotaToast.quotaProviders;
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new Error("quotaProviders must be an array");
  }
  const definitions = (existing ? cloneJson(existing) : []) as unknown[];
  const publicDefinition = toPublicDefinition(definition);
  const existingIndex = definitions.findIndex(
    (value) => isPlainObject(value) && value.id === definition.id,
  );
  const index = existingIndex === -1 ? definitions.length : existingIndex;
  if (existingIndex === -1) definitions.push(publicDefinition);
  else definitions[existingIndex] = publicDefinition;

  const combined = validateQuotaProviders(definitions);
  if (!combined.value) {
    throw new Error(combined.issues.map((issue) => issue.key + ": " + issue.message).join("\n"));
  }
  quotaToast.quotaProviders = definitions;
  if (Array.isArray(quotaToast.enabledProviders)) {
    const enabledProviders = quotaToast.enabledProviders.filter(
      (value): value is string => typeof value === "string",
    );
    if (!enabledProviders.includes(QUOTA_PROVIDERS_AGGREGATE_ID)) {
      quotaToast.enabledProviders = [...enabledProviders, QUOTA_PROVIDERS_AGGREGATE_ID];
    }
  }

  const documentEdit = await planConfigDocumentEdit({
    target,
    desiredData: root,
    managedComments: selectedSidecar
      ? sidecarManagedComments(index, definition)
      : managedComments(index, definition),
  });
  return {
    path: documentEdit.path,
    format: documentEdit.format,
    definition,
    updated: documentEdit.updated,
    changed: documentEdit.changed,
    ordinaryProviderRequired:
      !(MAINTAINED_LOCAL_ESTIMATE_IDS as readonly string[]).includes(definition.id) &&
      !(definition.providerId in ordinaryProviders),
    documentEdit,
    additionalDocumentEdits: [],
  };
}

export async function applyProviderAddPlan(plan: ProviderAddPlan): Promise<void> {
  const edits = [plan.documentEdit, ...plan.additionalDocumentEdits];
  await Promise.all(edits.map((edit) => validateConfigDocumentEdit(edit)));
  for (const edit of edits) {
    await applyConfigDocumentEdit(edit);
  }
}
