/**
 * OpenAI-compatible gateway quota fetcher.
 *
 * Polls a self-hosted / OpenAI-compatible gateway's quota endpoint
 * (GET <baseURL><quotaPath>, default `/quota`) with a Bearer key and maps the
 * response into a normalized { tokens, cost } shape. There is no standard
 * remaining-quota endpoint, so this consumes a small, documented vendor-neutral
 * contract by default and is NOT bound to any product:
 *
 *   neutral: { key, tokens:{limit,used,remaining,resets_at},
 *              cost:{currency,limit,used,remaining} }
 *
 * A built-in `openrouter` preset maps the OpenRouter key-info shape
 * ({ data:{ label, usage, limit, limit_remaining } }, dollars only) so
 * OpenRouter-style gateways work too.
 */

import type { QuotaError } from "./types.js";
import { fetchWithTimeout } from "./http.js";

export type GatewayMapping = "neutral" | "openrouter";

export interface GatewayTokenWindow {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetTimeIso?: string;
}

export interface GatewayCostWindow {
  currency: string;
  limit: number | null;
  used: number | null;
  remaining: number | null;
}

export type GatewayQuotaResult =
  | {
      success: true;
      label: string;
      tokens?: GatewayTokenWindow;
      cost?: GatewayCostWindow;
    }
  | QuotaError
  | null;

export interface QueryGatewayQuotaParams {
  baseURL: string;
  apiKey: string;
  /** Path appended to baseURL; defaults to "/quota". */
  quotaPath?: string;
  /** Response shape; defaults to "neutral". */
  mapping?: GatewayMapping;
  /** Display label used when the body carries none. */
  fallbackLabel?: string;
  requestTimeoutMs?: number;
}

const USER_AGENT = "OpenCode-Quota-Toast/1.0";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

type ParsedQuota = { label?: string; tokens?: GatewayTokenWindow; cost?: GatewayCostWindow } | null;

/** Vendor-neutral { key, tokens, cost } contract. */
function parseNeutral(body: unknown): ParsedQuota {
  if (!isRecord(body)) return null;

  let tokens: GatewayTokenWindow | undefined;
  if (isRecord(body.tokens)) {
    const t = body.tokens;
    tokens = {
      limit: num(t.limit),
      used: num(t.used),
      remaining: num(t.remaining),
      resetTimeIso: str(t.resets_at),
    };
  }

  let cost: GatewayCostWindow | undefined;
  if (isRecord(body.cost)) {
    const c = body.cost;
    cost = {
      currency: str(c.currency) ?? "USD",
      limit: num(c.limit),
      used: num(c.used),
      remaining: num(c.remaining),
    };
  }

  if (!tokens && !cost) return null;
  return { label: str(body.key), tokens, cost };
}

/** OpenRouter key-info preset: { data:{ label, usage, limit, limit_remaining } } (dollars). */
function parseOpenRouter(body: unknown): ParsedQuota {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const d = body.data;
  const used = num(d.usage);
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining) ?? (limit !== null && used !== null ? limit - used : null);
  return {
    label: str(d.label) ?? str(d.name),
    cost: { currency: "USD", limit, used, remaining },
  };
}

export async function queryGatewayQuota(
  params: QueryGatewayQuotaParams,
): Promise<GatewayQuotaResult> {
  if (!params.baseURL || !params.apiKey) return null;

  const url = joinUrl(params.baseURL, params.quotaPath ?? "/quota");

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${params.apiKey}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      },
      params.requestTimeoutMs,
    );
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    return { success: false, error: `gateway quota error ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { success: false, error: "gateway quota returned non-JSON" };
  }

  const parsed = (params.mapping ?? "neutral") === "openrouter" ? parseOpenRouter(body) : parseNeutral(body);
  if (!parsed) {
    return { success: false, error: "gateway quota returned an unexpected shape" };
  }

  return {
    success: true,
    label: parsed.label ?? params.fallbackLabel ?? "Gateway",
    tokens: parsed.tokens,
    cost: parsed.cost,
  };
}
