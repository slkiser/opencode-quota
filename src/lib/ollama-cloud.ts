/**
 * Ollama Cloud usage API client.
 *
 * Fetches session and weekly usage fractions plus per-model request counts
 * from the authenticated Ollama Cloud usage endpoint.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveOllamaCloudApiKey } from "./ollama-cloud-config.js";
import type { OllamaCloudModelUsage, OllamaCloudResult, OllamaCloudWindow } from "./types.js";

const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_ROWS = 100;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeRemoteSingleLineText(text: string): string {
  return sanitizeSingleLineDisplayText(text).replace(/\p{Cf}/gu, "");
}

function sanitizeMessage(text: string, secret?: string, maxLength = 200): string {
  const redacted = secret ? text.split(secret).join("[redacted]") : text;
  const sanitized = sanitizeRemoteSingleLineText(redacted);
  return (sanitized || "unknown").slice(0, maxLength);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Ollama Cloud usage API response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Ollama Cloud usage API response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseWindow(value: unknown): OllamaCloudWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usageFraction = value.usage;
  if (
    typeof usageFraction !== "number" ||
    !Number.isFinite(usageFraction) ||
    usageFraction < 0 ||
    usageFraction > 1
  ) {
    return undefined;
  }

  const usagePercent = usageFraction * 100;
  return {
    usageFraction,
    usagePercent,
    percentRemaining: 100 - usagePercent,
  };
}

function parseModels(value: unknown, rowErrors: string[]): OllamaCloudModelUsage[] {
  if (!Array.isArray(value)) {
    rowErrors.push("Models: expected an array");
    return [];
  }

  const models: OllamaCloudModelUsage[] = [];
  const seenModels = new Set<string>();

  for (const candidate of value) {
    if (!isRecord(candidate)) {
      rowErrors.push("Models: ignored an invalid row");
      continue;
    }

    const model =
      typeof candidate.model === "string"
        ? sanitizeRemoteSingleLineText(candidate.model).slice(0, 160)
        : "";
    const requests = candidate.requests;

    if (!model) {
      rowErrors.push("Models: ignored a row without a model name");
      continue;
    }
    if (typeof requests !== "number" || !Number.isSafeInteger(requests) || requests < 0) {
      rowErrors.push(`Models: ignored invalid request count for ${model}`);
      continue;
    }
    if (seenModels.has(model)) {
      rowErrors.push(`Models: ignored duplicate model ${model}`);
      continue;
    }

    seenModels.add(model);
    models.push({ model, requests });
  }

  return models.sort((left, right) => left.model.localeCompare(right.model));
}

function parseOllamaCloudUsage(payload: unknown): OllamaCloudResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned an unexpected response shape",
    };
  }

  if (Array.isArray(payload.models) && payload.models.length > MAX_MODEL_ROWS) {
    return {
      success: false,
      error: `Ollama Cloud usage API returned more than ${MAX_MODEL_ROWS} model rows`,
    };
  }

  const rowErrors: string[] = [];
  const limits = isRecord(payload.limits) ? payload.limits : undefined;
  const session = parseWindow(limits?.session);
  const weekly = parseWindow(limits?.weekly);

  if (limits?.session !== undefined && !session) {
    rowErrors.push("Session: ignored invalid usage fraction");
  }
  if (limits?.weekly !== undefined && !weekly) {
    rowErrors.push("Weekly: ignored invalid usage fraction");
  }
  if (!limits) {
    rowErrors.push("Limits: expected an object");
  }

  const models = parseModels(payload.models, rowErrors);
  if (!session && !weekly && models.length === 0) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned no usable usage data",
    };
  }

  return {
    success: true,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
    models,
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

export async function queryOllamaCloudQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<OllamaCloudResult> {
  const resolved = await resolveOllamaCloudApiKey();
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(OLLAMA_CLOUD_USAGE_URL, {
      request: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: resolved.key,
        },
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          const snippet = sanitizeMessage(text, resolved.key);
          return {
            success: false,
            error: `Ollama Cloud usage API error ${response.status}: ${snippet}`,
          };
        }

        return parseOllamaCloudUsage(JSON.parse(text) as unknown);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
    };
  }
}

export { parseOllamaCloudUsage as _parseOllamaCloudUsage };
