/** Zhipu provider wrapper. */
import { queryZhipuQuota } from "../lib/zhipu.js";
import { DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS, resolveZhipuAuthCached } from "../lib/zhipu-auth.js";
import { createGlmCodingPlanProvider } from "./glm-coding-plan-provider.js";

export const zhipuProvider = createGlmCodingPlanProvider({
  id: "zhipu",
  providerId: "zhipu",
  errorLabel: "Zhipu",
  authCacheMaxAgeMs: DEFAULT_ZHIPU_AUTH_CACHE_MAX_AGE_MS,
  resolveAuth: resolveZhipuAuthCached,
  queryQuota: queryZhipuQuota,
  matchesCurrentModel(model) {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    return !!provider && (provider.includes("zhipu") || provider === "glm-coding-plan");
  },
});
