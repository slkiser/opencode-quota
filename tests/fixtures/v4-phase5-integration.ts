import type { RemoteApiQuotaProviderDefinition } from "../../src/lib/quota-providers.js";

export const PHASE5_SECRET_CANARIES = {
  accountingKey: "phase5-accounting-secret-canary",
  openRouterKey: "phase5-openrouter-secret-canary",
  failingKey: "phase5-failing-secret-canary",
  failureBody: "phase5-private-http-body-canary",
} as const;

export const PHASE5_QUOTA_PROVIDERS = [
  {
    id: "team-accounting",
    providerId: "team-gateway",
    label: "Team Accounting",
    url: "https://team-gateway.example/accounting",
    mode: "remote-api",
    format: "accounting-v1",
    apiKeyEnv: "PHASE5_TEAM_ACCOUNTING_KEY",
  },
  {
    id: "openrouter-primary",
    providerId: "openrouter",
    label: "OpenRouter Primary",
    url: "https://openrouter.example/api/v1/key",
    mode: "remote-api",
    format: "openrouter-key-v1",
    apiKeyEnv: "PHASE5_OPENROUTER_KEY",
  },
  {
    id: "failing-accounting",
    providerId: "failing-gateway",
    label: "Failing Accounting",
    url: "https://failing-gateway.example/accounting",
    mode: "remote-api",
    format: "accounting-v1",
    apiKeyEnv: "PHASE5_FAILING_KEY",
  },
] as const satisfies readonly RemoteApiQuotaProviderDefinition[];

export const PHASE5_RUNTIME_PROVIDER_IDS = [
  "team-gateway",
  "openrouter",
  "failing-gateway",
] as const;

export const PHASE5_ACCOUNTING_RESPONSE = {
  version: "accounting-v1",
  entries: [
    {
      kind: "percent",
      name: "Monthly",
      resultType: "quota",
      percentRemaining: 64,
      label: "Monthly:",
      right: "64/100",
      resetTimeIso: "2099-08-01T00:00:00.000Z",
      observedAtIso: "2026-07-13T08:00:00.000Z",
    },
    {
      kind: "value",
      name: "Balance",
      resultType: "balance",
      value: "$12.34",
      label: "Balance:",
      observedAtIso: "2026-07-13T08:00:00.000Z",
    },
  ],
} as const;

export const PHASE5_OPENROUTER_RESPONSE = {
  data: {
    usage: 2,
    limit: 10,
    limit_remaining: 8,
  },
} as const;

export function phase5JsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function assertPhase5FixtureOrder(output: string): void {
  const accountingIndex = output.indexOf("Team Accounting");
  const openRouterIndex = output.indexOf("OpenRouter Primary");
  const failureIndex = output.indexOf("Failing Accounting");

  if (accountingIndex < 0 || openRouterIndex < 0 || failureIndex < 0) {
    throw new Error("Phase 5 fixture output is missing a configured source");
  }
  if (!(accountingIndex < openRouterIndex && openRouterIndex < failureIndex)) {
    throw new Error("Phase 5 fixture output did not preserve configured source order");
  }
}

export function assertPhase5CanariesRedacted(output: string): void {
  for (const canary of Object.values(PHASE5_SECRET_CANARIES)) {
    if (output.includes(canary)) {
      throw new Error(`Phase 5 fixture leaked secret canary: ${canary}`);
    }
  }
}
