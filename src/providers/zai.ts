import {
  DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
  getZaiAuthDiagnostics,
  resolveZaiAuthCached,
} from "../lib/zai-auth.js";
/** Z.ai provider wrapper. */
import { queryZaiQuota } from "../lib/zai.js";
import { createGlmCodingPlanProvider } from "./glm-coding-plan-provider.js";

export const zaiProvider = createGlmCodingPlanProvider({
  id: "zai",
  providerId: "zai",
  errorLabel: "Z.ai",
  authCacheMaxAgeMs: DEFAULT_ZAI_AUTH_CACHE_MAX_AGE_MS,
  resolveAuth: resolveZaiAuthCached,
  getAuthDiagnostics: getZaiAuthDiagnostics,
  queryQuota: queryZaiQuota,
  matchesCurrentModel(model) {
    const lower = model.toLowerCase();
    const provider = lower.split("/")[0];
    if (provider && (provider.includes("zai") || provider.includes("glm"))) {
      return true;
    }
    return lower.includes("glm");
  },
});
