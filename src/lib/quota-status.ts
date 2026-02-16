import { stat } from "fs/promises";

import { getAuthPath, getAuthPaths } from "./opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./opencode-runtime-paths.js";
import { getGoogleTokenCachePath } from "./google-token-cache.js";
import { getAntigravityAccountsCandidatePaths, readAntigravityAccounts } from "./google.js";
import { getFirmwareKeyDiagnostics } from "./firmware.js";
import { getChutesKeyDiagnostics } from "./chutes.js";
import {
  getPricingSnapshotMeta,
  listProviders,
  getProviderModelCount,
  hasProvider as snapshotHasProvider,
} from "./modelsdev-pricing.js";
import { getProviders } from "../providers/registry.js";
import { getPackageVersion } from "./version.js";
import {
  getOpenCodeDbPath,
  getOpenCodeDbPathCandidates,
  getOpenCodeDbStats,
} from "./opencode-storage.js";
import { aggregateUsage } from "./quota-stats.js";

/** Session token fetch error info for status report */
export interface SessionTokenError {
  sessionID: string;
  error: string;
  checkedPath?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function fmtInt(n: number): string {
  return Math.trunc(n).toLocaleString("en-US");
}

function tokensTotal(t: {
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}): number {
  return t.input + t.output + t.reasoning + t.cache_read + t.cache_write;
}

type PricingCoverageByProvider = {
  pricedKeysSeen: number;
  mappedMissingKeysSeen: number;
  unpricedKeysSeen: number;
};

function computePricingCoverageFromAgg(agg: Awaited<ReturnType<typeof aggregateUsage>>): {
  byProvider: Map<string, PricingCoverageByProvider>;
  totals: { pricedKeysSeen: number; mappedMissingKeysSeen: number; unpricedKeysSeen: number };
} {
  const byProvider = new Map<string, PricingCoverageByProvider>();
  let pricedKeysSeen = 0;
  let mappedMissingKeysSeen = 0;
  let unpricedKeysSeen = 0;

  // Priced keys seen in history
  for (const row of agg.byModel) {
    const p = row.key.provider;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.pricedKeysSeen += 1;
    byProvider.set(p, existing);
    pricedKeysSeen += 1;
  }

  // Keys that mapped to an official provider/model but were missing pricing
  for (const row of agg.unknown) {
    const p = row.key.mappedProvider;
    if (!p || !row.key.mappedModel) continue;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.mappedMissingKeysSeen += 1;
    byProvider.set(p, existing);
    mappedMissingKeysSeen += 1;
  }

  // Mapped keys that we explicitly consider unpriced
  for (const row of agg.unpriced) {
    const p = row.key.mappedProvider;
    const existing = byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    existing.unpricedKeysSeen += 1;
    byProvider.set(p, existing);
    unpricedKeysSeen += 1;
  }

  return { byProvider, totals: { pricedKeysSeen, mappedMissingKeysSeen, unpricedKeysSeen } };
}

function supportedProviderPricingRow(params: {
  id: string;
  agg: Awaited<ReturnType<typeof aggregateUsage>>;
  snapshotProviders: string[];
}): { id: string; pricing: "yes" | "partial" | "no"; notes: string } {
  const id = params.id;

  if (id === "firmware") {
    return {
      id,
      pricing: "no",
      notes: "credits-based quota (not token-priced)",
    };
  }

  // Providers that correspond directly to models.dev providers.
  if (params.snapshotProviders.includes(id)) {
    return { id, pricing: "yes", notes: "models.dev snapshot provider" };
  }

  // Connector to snapshot provider; treat as priced if snapshot has OpenAI pricing.
  // Copilot is an OpenCode provider but token costs still map into official model pricing.
  if (id === "copilot") {
    return snapshotHasProvider("openai")
      ? { id, pricing: "yes", notes: "connector (priced via models.dev openai)" }
      : { id, pricing: "partial", notes: "connector (pricing snapshot missing openai)" };
  }

  // Connector provider; maps to models.dev provider ids depending on model.
  if (id === "google-antigravity") {
    return snapshotHasProvider("google") || snapshotHasProvider("anthropic")
      ? { id, pricing: "yes", notes: "connector (priced via models.dev google/anthropic)" }
      : { id, pricing: "partial", notes: "connector (pricing snapshot missing google/anthropic)" };
  }

  // Connector providers: pricing exists when model IDs can be mapped into snapshot pricing keys.
  // Use local history as the source of truth.
  const hasAnyUsage = params.agg.bySourceProvider.some((p) => p.providerID === id);
  const hasAnyUnknown = params.agg.unknown.some((u) => u.key.sourceProviderID === id);

  // Note: agg.byModel is already mapped to official pricing keys, not source provider IDs.
  // So for connector providers we infer pricing availability based on whether we saw usage at all
  // and whether it was mappable.
  if (!hasAnyUsage && !hasAnyUnknown) {
    return { id, pricing: "no", notes: "no local usage observed" };
  }

  if (hasAnyUnknown) {
    return {
      id,
      pricing: "partial",
      notes: "some models not in snapshot (see unpriced_models / unknown_pricing)",
    };
  }

  return {
    id,
    pricing: "yes",
    notes: "model IDs map into snapshot pricing",
  };
}

export async function buildQuotaStatusReport(params: {
  configSource: string;
  configPaths: string[];
  enabledProviders: string[] | "auto";
  onlyCurrentModel: boolean;
  currentModel?: string;
  /** Whether a session was available for model lookup */
  sessionModelLookup?: "ok" | "not_found" | "no_session";
  providerAvailability: Array<{
    id: string;
    enabled: boolean;
    available: boolean;
    matchesCurrentModel?: boolean;
  }>;
  googleRefresh?: {
    attempted: boolean;
    total?: number;
    successCount?: number;
    failures?: Array<{ email?: string; error: string }>;
  };
  sessionTokenError?: SessionTokenError;
}): Promise<string> {
  const lines: string[] = [];

  const version = await getPackageVersion();
  const v = version ?? "unknown";

  lines.push(`Quota Status (opencode-quota v${v}) (/quota_status)`);
  lines.push("");

  // === toast diagnostics ===
  lines.push("toast:");
  lines.push(
    `- configSource: ${params.configSource}${params.configPaths.length ? ` (${params.configPaths.join(" | ")})` : ""}`,
  );
  lines.push(
    `- enabledProviders: ${params.enabledProviders === "auto" ? "(auto)" : params.enabledProviders.length ? params.enabledProviders.join(",") : "(none)"}`,
  );
  lines.push(`- onlyCurrentModel: ${params.onlyCurrentModel ? "true" : "false"}`);
  const modelDisplay = params.currentModel
    ? params.currentModel
    : params.sessionModelLookup === "not_found"
      ? "(error: session.get returned no modelID)"
      : params.sessionModelLookup === "no_session"
        ? "(no session available)"
        : "(unknown)";
  lines.push(`- currentModel: ${modelDisplay}`);
  lines.push("- providers:");
  for (const p of params.providerAvailability) {
    const bits: string[] = [];
    bits.push(p.enabled ? "enabled" : "disabled");
    bits.push(p.available ? "available" : "unavailable");
    if (p.matchesCurrentModel !== undefined) {
      bits.push(`matchesCurrentModel=${p.matchesCurrentModel ? "yes" : "no"}`);
    }
    lines.push(`  - ${p.id}: ${bits.join(" ")}`);
  }

  lines.push("");
  lines.push("paths:");

  const runtime = getOpencodeRuntimeDirs();
  lines.push(`- opencode data: ${runtime.dataDir}`);
  lines.push(`- opencode config: ${runtime.configDir}`);
  lines.push(`- opencode cache: ${runtime.cacheDir}`);
  lines.push(`- opencode state: ${runtime.stateDir}`);
  const authCandidates = getAuthPaths();
  const authPresent: string[] = [];
  await Promise.all(
    authCandidates.map(async (p) => {
      try {
        await stat(p);
        authPresent.push(p);
      } catch {
        // ignore missing/unreadable
      }
    }),
  );
  lines.push(`- auth.json (preferred): ${getAuthPath()}`);
  lines.push(
    `- auth.json (candidates): ${authCandidates.length ? authCandidates.join(" | ") : "(none)"}`,
  );
  lines.push(`- auth.json (present): ${authPresent.length ? authPresent.join(" | ") : "(none)"}`);

  // Firmware API key diagnostics
  let firmwareDiag: { configured: boolean; source: string | null; checkedPaths: string[] } = {
    configured: false,
    source: null,
    checkedPaths: [],
  };
  try {
    firmwareDiag = await getFirmwareKeyDiagnostics();
  } catch {
    // ignore
  }
  lines.push(`- firmware api key configured: ${firmwareDiag.configured ? "true" : "false"}`);
  if (firmwareDiag.source) {
    lines.push(`- firmware api key source: ${firmwareDiag.source}`);
  }
  if (firmwareDiag.checkedPaths.length > 0) {
    lines.push(`- firmware api key checked: ${firmwareDiag.checkedPaths.join(" | ")}`);
  }

  // Chutes API key diagnostics
  let chutesDiag: { configured: boolean; source: string | null; checkedPaths: string[] } = {
    configured: false,
    source: null,
    checkedPaths: [],
  };
  try {
    chutesDiag = await getChutesKeyDiagnostics();
  } catch {
    // ignore
  }
  lines.push(`- chutes api key configured: ${chutesDiag.configured ? "true" : "false"}`);
  if (chutesDiag.source) {
    lines.push(`- chutes api key source: ${chutesDiag.source}`);
  }
  if (chutesDiag.checkedPaths.length > 0) {
    lines.push(`- chutes api key checked: ${chutesDiag.checkedPaths.join(" | ")}`);
  }

  const googleTokenCachePath = getGoogleTokenCachePath();
  lines.push(
    `- google token cache: ${googleTokenCachePath}${(await pathExists(googleTokenCachePath)) ? "" : " (missing)"}`,
  );

  const candidates = getAntigravityAccountsCandidatePaths();
  const presentCandidates: string[] = [];
  await Promise.all(
    candidates.map(async (p) => {
      if (await pathExists(p)) presentCandidates.push(p);
    }),
  );
  const selected = presentCandidates[0] ?? null;
  lines.push(`- antigravity accounts (selected): ${selected ?? "(none)"}`);
  lines.push(
    `- antigravity accounts (candidates): ${candidates.length ? candidates.join(" | ") : "(none)"}`,
  );
  lines.push(
    `- antigravity accounts (present): ${presentCandidates.length ? presentCandidates.join(" | ") : "(none)"}`,
  );

  const dbCandidates = getOpenCodeDbPathCandidates();
  const dbSelected = getOpenCodeDbPath();
  const dbPresent: string[] = [];
  await Promise.all(
    dbCandidates.map(async (p) => {
      if (await pathExists(p)) dbPresent.push(p);
    }),
  );

  lines.push(`- opencode db (preferred): ${dbSelected}`);
  lines.push(
    `- opencode db (candidates): ${dbCandidates.length ? dbCandidates.join(" | ") : "(none)"}`,
  );
  lines.push(`- opencode db (present): ${dbPresent.length ? dbPresent.join(" | ") : "(none)"}`);

  if (params.googleRefresh?.attempted) {
    lines.push("");
    lines.push("google_token_refresh:");
    if (
      typeof params.googleRefresh.total === "number" &&
      typeof params.googleRefresh.successCount === "number"
    ) {
      lines.push(`- refreshed: ${params.googleRefresh.successCount}/${params.googleRefresh.total}`);
    } else {
      lines.push("- attempted");
    }
    for (const f of params.googleRefresh.failures ?? []) {
      lines.push(`- ${f.email ?? "Unknown"}: ${f.error}`);
    }
  }

  let accountCount = 0;
  try {
    const accounts = await readAntigravityAccounts();
    accountCount = accounts?.length ?? 0;
  } catch {
    accountCount = 0;
  }
  lines.push("");
  lines.push(`google accounts: count=${accountCount}`);

  // === session token errors ===
  if (params.sessionTokenError) {
    lines.push("");
    lines.push("session_tokens_error:");
    lines.push(`- session_id: ${params.sessionTokenError.sessionID}`);
    lines.push(`- error: ${params.sessionTokenError.error}`);
    if (params.sessionTokenError.checkedPath) {
      lines.push(`- checked_path: ${params.sessionTokenError.checkedPath}`);
    }
  }

  // === storage scan ===
  const dbStats = await getOpenCodeDbStats();
  lines.push("");
  lines.push("storage:");
  lines.push(`- sessions_in_db: ${fmtInt(dbStats.sessionCount)}`);
  lines.push(`- messages_in_db: ${fmtInt(dbStats.messageCount)}`);
  lines.push(`- assistant_messages_in_db: ${fmtInt(dbStats.assistantMessageCount)}`);

  // === pricing snapshot ===
  // We intentionally compute all-time usage once so that pricing coverage and unknown_pricing
  // are consistent and do not require multiple storage scans.
  const agg = await aggregateUsage({});
  const meta = getPricingSnapshotMeta();
  const providers = listProviders();
  const coverage = computePricingCoverageFromAgg(agg);

  lines.push("");
  lines.push("pricing_snapshot:");
  lines.push(`- source: ${meta.source}`);
  lines.push(`- generatedAt: ${new Date(meta.generatedAt).toISOString()}`);
  lines.push(`- units: ${meta.units}`);
  lines.push(`- providers: ${providers.join(",")}`);
  lines.push(
    `- coverage_seen: priced_keys=${fmtInt(coverage.totals.pricedKeysSeen)} mapped_but_missing=${fmtInt(coverage.totals.mappedMissingKeysSeen)} unpriced_keys=${fmtInt(coverage.totals.unpricedKeysSeen)}`,
  );
  for (const p of providers) {
    const c = coverage.byProvider.get(p) ?? {
      pricedKeysSeen: 0,
      mappedMissingKeysSeen: 0,
      unpricedKeysSeen: 0,
    };
    lines.push(
      `  - ${p}: models=${fmtInt(getProviderModelCount(p))} priced_models_seen=${fmtInt(c.pricedKeysSeen)} mapped_but_missing_models_seen=${fmtInt(c.mappedMissingKeysSeen)} unpriced_models_seen=${fmtInt(c.unpricedKeysSeen)}`,
    );
  }

  // === supported providers pricing ===
  const supported = getProviders().map((p) => p.id);
  lines.push("");
  lines.push("supported_providers_pricing:");
  for (const id of supported) {
    const row = supportedProviderPricingRow({ id, agg, snapshotProviders: providers });
    lines.push(`- ${row.id}: pricing=${row.pricing} (${row.notes})`);
  }

  // === unpriced models ===
  // Mapped keys that are deterministically not token-priced by our snapshot.
  lines.push("");
  lines.push("unpriced_models:");
  if (agg.unpriced.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      `- keys: ${fmtInt(agg.unpriced.length)} tokens_total=${fmtInt(tokensTotal(agg.totals.unpriced))}`,
    );
    for (const row of agg.unpriced.slice(0, 25)) {
      const src = `${row.key.sourceProviderID}/${row.key.sourceModelID}`;
      const mapped = `${row.key.mappedProvider}/${row.key.mappedModel}`;
      lines.push(
        `- ${src} mapped=${mapped} tokens=${fmtInt(tokensTotal(row.tokens))} msgs=${fmtInt(row.messageCount)} reason=${row.key.reason}`,
      );
    }
    if (agg.unpriced.length > 25) {
      lines.push(`- ... (${fmtInt(agg.unpriced.length - 25)} more)`);
    }
  }

  // === unknown pricing ===
  // We intentionally report unknowns for *all time* so users can see what needs mapping.
  lines.push("");
  lines.push("unknown_pricing:");
  if (agg.unknown.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      `- keys: ${fmtInt(agg.unknown.length)} tokens_total=${fmtInt(tokensTotal(agg.totals.unknown))}`,
    );
    for (const row of agg.unknown.slice(0, 25)) {
      const src = `${row.key.sourceProviderID}/${row.key.sourceModelID}`;
      const mapped =
        row.key.mappedProvider && row.key.mappedModel
          ? `${row.key.mappedProvider}/${row.key.mappedModel}`
          : "(none)";
      lines.push(
        `- ${src} mapped=${mapped} tokens=${fmtInt(tokensTotal(row.tokens))} msgs=${fmtInt(row.messageCount)}`,
      );
    }
    if (agg.unknown.length > 25) {
      lines.push(`- ... (${fmtInt(agg.unknown.length - 25)} more)`);
    }
  }

  return lines.join("\n");
}
