import { queryGlmCodingPlanQuota } from "./glm-coding-plan.js";
import { resolveZaiAuthCached } from "./zai-auth.js";

const ZAI_QUOTA = {
  label: "Z.ai",
  endpoint: "https://api.z.ai/api/monitor/usage/quota/limit",
  httpErrorPrefix: "Z.ai API error",
  apiErrorPrefix: "Z.ai API error",
  envelope: "zai",
  resolveAuth: resolveZaiAuthCached,
} as const;

export function queryZaiQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(ZAI_QUOTA, options);
}
