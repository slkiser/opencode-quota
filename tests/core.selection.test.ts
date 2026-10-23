import { describe, expect, it } from "vite-plus/test";

import { matchesQuotaProviderCurrentSelection } from "../src/core/selection.js";
import type { QuotaProviderDefinition } from "../src/lib/quota-providers.js";
import { quotaProvidersProvider } from "../src/providers/quota-providers.js";

const definition: QuotaProviderDefinition = {
  id: "my-gateway-quota",
  providerId: "my-gateway",
  label: "My Gateway",
  mode: "remote-api",
  url: "https://gateway.example/v1/quota",
  format: "quota-v1",
};

function servesSessionWithoutModel(quotaProviders: QuotaProviderDefinition[]): boolean {
  return matchesQuotaProviderCurrentSelection({
    provider: quotaProvidersProvider,
    currentProviderID: "my-gateway",
    enabledProviders: "auto",
    quotaProviders,
  });
}

describe("custom providers serving a session without a model", () => {
  it("match through a definition that is on", () => {
    expect(servesSessionWithoutModel([definition])).toBe(true);
  });

  it("never match through a switched-off definition", () => {
    expect(servesSessionWithoutModel([{ ...definition, enabled: false }])).toBe(false);
  });
});
