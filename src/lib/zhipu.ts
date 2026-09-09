import { queryGlmCodingPlanQuota } from "./glm-coding-plan.js";
import { resolveZhipuAuthCached } from "./zhipu-auth.js";

const ZHIPU_QUOTA = {
  label: "Zhipu",
  endpoint: "https://bigmodel.cn/api/monitor/usage/quota/limit",
  httpErrorPrefix: "Zhipu API error",
  envelope: "zhipu",
  resolveAuth: resolveZhipuAuthCached,
} as const;

export function queryZhipuQuota(options: { requestTimeoutMs?: number; apiKey?: string } = {}) {
  return queryGlmCodingPlanQuota(ZHIPU_QUOTA, options);
}
