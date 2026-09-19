export type KimiQuotaEndpointId = "global" | "china";

export interface KimiQuotaEndpoint {
  id: KimiQuotaEndpointId;
  label: string;
  apiBaseUrl: string;
  quotaUrl: string;
}

export const KIMI_QUOTA_ENDPOINTS: Readonly<Record<KimiQuotaEndpointId, KimiQuotaEndpoint>> = {
  global: {
    id: "global",
    label: "Kimi Code",
    apiBaseUrl: "https://api.kimi.ai/coding/v1",
    quotaUrl: "https://api.kimi.ai/coding/v1/usages",
  },
  china: {
    id: "china",
    label: "Kimi Code (CN)",
    apiBaseUrl: "https://api.kimi.com/coding/v1",
    quotaUrl: "https://api.kimi.com/coding/v1/usages",
  },
};

export function getKimiQuotaEndpoint(id: KimiQuotaEndpointId): KimiQuotaEndpoint {
  return KIMI_QUOTA_ENDPOINTS[id];
}
