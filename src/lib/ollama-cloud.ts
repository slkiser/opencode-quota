/**
 * Ollama Cloud usage API client.
 *
 * Fetches session and weekly usage fractions from the authenticated Ollama
 * Cloud usage endpoint.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveOllamaCloudApiKey } from "./ollama-cloud-config.js";
import type { OllamaCloudResult, OllamaCloudWindow } from "./types.js";

const OLLAMA_CLOUD_USAGE_URL = "https://ollama.com/api/usage";
const MAX_RESPONSE_BYTES = 256 * 1024;

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

function parseOllamaCloudUsage(payload: unknown): OllamaCloudResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned an unexpected response shape",
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

  if (!session && !weekly) {
    return {
      success: false,
      error: "Ollama Cloud usage API returned no usable usage data",
    };
  }

  return {
    success: true,
    ...(session ? { session } : {}),
    ...(weekly ? { weekly } : {}),
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
