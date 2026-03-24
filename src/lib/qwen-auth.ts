import type { AuthData } from "./types.js";
import { readAuthFileCached } from "./opencode-auth.js";

export const DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS = 5_000;

export type ResolvedQwenLocalPlan =
  | { state: "none" }
  | { state: "qwen_free"; accessToken: string };

function getQwenOAuthAccessToken(auth: AuthData | null | undefined): string | null {
  const qwen = auth?.["qwen-code"] ?? auth?.["opencode-qwencode-auth"];
  if (!qwen || qwen.type !== "oauth") {
    return null;
  }

  const access = typeof qwen.access === "string" ? qwen.access.trim() : "";
  return access || null;
}

export function hasQwenOAuthAuth(auth: AuthData | null | undefined): boolean {
  return getQwenOAuthAccessToken(auth) !== null;
}

export async function hasQwenOAuthAuthCached(params?: {
  maxAgeMs?: number;
}): Promise<boolean> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS),
  });
  return hasQwenOAuthAuth(auth);
}

export function resolveQwenLocalPlan(auth: AuthData | null | undefined): ResolvedQwenLocalPlan {
  const accessToken = getQwenOAuthAccessToken(auth);
  if (!accessToken) {
    return { state: "none" };
  }

  return { state: "qwen_free", accessToken };
}

export async function resolveQwenLocalPlanCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedQwenLocalPlan> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_QWEN_AUTH_CACHE_MAX_AGE_MS),
  });
  return resolveQwenLocalPlan(auth);
}

export function isQwenCodeModelId(model?: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("qwen-code/");
}
