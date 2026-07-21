import type { AccountingResultType, QuotaToastEntry } from "./entries.js";
import type { RemoteApiQuotaProviderDefinition } from "./quota-providers.js";

import {
  createProviderApiKeyResolver,
  getApiKeyCheckedPaths,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { getAuthPaths, readAuthFile } from "./opencode-auth.js";
import { REQUEST_TIMEOUT_MS } from "./types.js";

export const QUOTA_PROVIDER_MAX_BODY_BYTES = 256 * 1024;
export const QUOTA_PROVIDER_MAX_ACCOUNTING_ROWS = 100;
export const QUOTA_PROVIDER_CONCURRENCY = 4;

const RESULT_TYPES = new Set<AccountingResultType>([
  "quota",
  "rate_limit",
  "usage",
  "spend",
  "budget",
  "balance",
  "status",
]);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type QuotaProviderAuthSource = "env" | "opencode.json" | "opencode.jsonc" | "auth.json";

export interface QuotaProviderAuthResolution {
  key?: string;
  source: QuotaProviderAuthSource | null;
  checkedPaths: string[];
  authPaths: string[];
}

export type RemoteQuotaProviderResult =
  | { success: true; entries: QuotaToastEntry[] }
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" && ISO_TIMESTAMP_RE.test(value) && Number.isFinite(Date.parse(value))
  );
}

function boundedDisplayText(value: unknown, maxCodePoints: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeSingleLineDisplayText(value);
  const length = Array.from(normalized).length;
  return length >= 1 && length <= maxCodePoints ? normalized : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function accountingMetadata(
  resultType: AccountingResultType,
  observedAtIso?: string,
): QuotaToastEntry["accounting"] {
  return {
    resultType,
    acquisitionMethod: "remote_api",
    ownership: "user_configured",
    authority: "provider_reported",
    ...(observedAtIso ? { observedAtIso } : {}),
  };
}

export async function resolveQuotaProviderApiKey(
  source: RemoteApiQuotaProviderDefinition,
): Promise<QuotaProviderAuthResolution> {
  const resolver = createProviderApiKeyResolver<QuotaProviderAuthSource>({
    envVars: source.apiKeyEnv ? [{ name: source.apiKeyEnv, source: "env" }] : [],
    providerKeys: [source.providerId],
    allowedEnvVars: source.apiKeyEnv ? [source.apiKeyEnv] : [],
    configJsonSource: "opencode.json",
    configJsoncSource: "opencode.jsonc",
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    auth: {
      readAuth: readAuthFile,
      authKeys: [source.providerId],
      authSource: "auth.json",
    },
  });

  const resolved = await resolver.resolve();
  return {
    ...(resolved ? { key: resolved.key } : {}),
    source: resolved?.source ?? null,
    checkedPaths: getApiKeyCheckedPaths({
      envVarNames: source.apiKeyEnv ? [source.apiKeyEnv] : [],
      getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
    }),
    authPaths: getAuthPaths(),
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    !contentType ||
    (contentType !== "application/json" &&
      !(contentType.startsWith("application/") && contentType.endsWith("+json")))
  ) {
    throw new Error("Expected a JSON response");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > QUOTA_PROVIDER_MAX_BODY_BYTES) {
      throw new Error("Response exceeded 262144 bytes");
    }
  }

  let bytes: Uint8Array;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > QUOTA_PROVIDER_MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("Response exceeded 262144 bytes");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > QUOTA_PROVIDER_MAX_BODY_BYTES) {
      throw new Error("Response exceeded 262144 bytes");
    }
    bytes = buffer;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Invalid JSON response");
  }
}

function parseAccountingV1(
  source: RemoteApiQuotaProviderDefinition,
  body: unknown,
): RemoteQuotaProviderResult {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, ["version", "entries"]) ||
    body.version !== "accounting-v1" ||
    !Array.isArray(body.entries)
  ) {
    return { success: false, error: "Invalid accounting-v1 response" };
  }
  if (body.entries.length < 1 || body.entries.length > QUOTA_PROVIDER_MAX_ACCOUNTING_ROWS) {
    return { success: false, error: "Invalid accounting-v1 response" };
  }

  const entries: QuotaToastEntry[] = [];
  for (const raw of body.entries) {
    if (
      !isRecord(raw) ||
      !hasOnlyKeys(raw, [
        "kind",
        "name",
        "resultType",
        "percentRemaining",
        "value",
        "label",
        "right",
        "resetTimeIso",
        "observedAtIso",
      ])
    ) {
      return { success: false, error: "Invalid accounting-v1 response" };
    }

    const name = boundedDisplayText(raw.name, 80);
    const resultType =
      typeof raw.resultType === "string" && RESULT_TYPES.has(raw.resultType as AccountingResultType)
        ? (raw.resultType as AccountingResultType)
        : null;
    const label = raw.label === undefined ? undefined : boundedDisplayText(raw.label, 80);
    const right = raw.right === undefined ? undefined : boundedDisplayText(raw.right, 160);
    const resetTimeIso =
      raw.resetTimeIso === undefined
        ? undefined
        : isIsoTimestamp(raw.resetTimeIso)
          ? raw.resetTimeIso
          : null;
    const observedAtIso =
      raw.observedAtIso === undefined
        ? undefined
        : isIsoTimestamp(raw.observedAtIso)
          ? raw.observedAtIso
          : null;

    if (
      !name ||
      !resultType ||
      (raw.label !== undefined && label === null) ||
      (raw.right !== undefined && right === null) ||
      resetTimeIso === null ||
      observedAtIso === null
    ) {
      return { success: false, error: "Invalid accounting-v1 response" };
    }

    const common = {
      accounting: accountingMetadata(resultType, observedAtIso),
      name: `${source.label} ${name}`,
      group: source.label,
      ...(label ? { label } : {}),
      ...(right ? { right } : {}),
      ...(resetTimeIso ? { resetTimeIso } : {}),
    };

    if (
      raw.kind === "percent" &&
      typeof raw.percentRemaining === "number" &&
      Number.isFinite(raw.percentRemaining) &&
      raw.percentRemaining <= 100 &&
      ["quota", "rate_limit", "budget"].includes(resultType) &&
      raw.value === undefined
    ) {
      entries.push({ ...common, kind: "percent", percentRemaining: raw.percentRemaining });
      continue;
    }

    const value = boundedDisplayText(raw.value, 160);
    if (raw.kind === "value" && value !== null && raw.percentRemaining === undefined) {
      entries.push({ ...common, kind: "value", value });
      continue;
    }

    return { success: false, error: "Invalid accounting-v1 response" };
  }

  return { success: true, entries };
}

function parseOpenRouterKeyV1(
  source: RemoteApiQuotaProviderDefinition,
  body: unknown,
): RemoteQuotaProviderResult {
  if (!isRecord(body) || !isRecord(body.data)) {
    return { success: false, error: "Invalid openrouter-key-v1 response" };
  }

  const data = body.data;
  const usage = data.usage;
  const limit = data.limit;
  const remaining = data.limit_remaining;
  if (
    typeof usage !== "number" ||
    !Number.isFinite(usage) ||
    usage < 0 ||
    (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)) ||
    (remaining !== undefined && (typeof remaining !== "number" || !Number.isFinite(remaining)))
  ) {
    return { success: false, error: "Invalid openrouter-key-v1 response" };
  }

  if (typeof limit === "number" && limit > 0) {
    const remainingValue = typeof remaining === "number" ? remaining : limit - usage;
    if (remainingValue > limit) {
      return {
        success: false,
        error: "Invalid openrouter-key-v1 response",
      };
    }
    const percentRemaining = (remainingValue / limit) * 100;
    return {
      success: true,
      entries: [
        {
          accounting: accountingMetadata("budget"),
          kind: "percent",
          name: `${source.label} budget`,
          group: source.label,
          label: "Budget:",
          right: `${formatUsd(usage)}/${formatUsd(limit)}`,
          percentRemaining,
        },
      ],
    };
  }

  return {
    success: true,
    entries: [
      {
        accounting: accountingMetadata("spend"),
        kind: "value",
        name: `${source.label} spend`,
        group: source.label,
        label: "Spend:",
        value: formatUsd(usage),
      },
    ],
  };
}

export async function fetchRemoteQuotaProvider(
  source: RemoteApiQuotaProviderDefinition,
  apiKey: string,
  requestTimeoutMs?: number,
): Promise<RemoteQuotaProviderResult> {
  const timeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(source.url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      return { success: false, error: "Redirect rejected" };
    }
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const body = await readBoundedJson(response);
    return source.format === "accounting-v1"
      ? parseAccountingV1(source, body)
      : parseOpenRouterKeyV1(source, body);
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return {
        success: false,
        error: `Request timeout after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    if (
      error instanceof Error &&
      [
        "Response exceeded 262144 bytes",
        "Expected a JSON response",
        "Invalid JSON response",
      ].includes(error.message)
    ) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Failed to read accounting data" };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await map(values[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
  return results;
}
