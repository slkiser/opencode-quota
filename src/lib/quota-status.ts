import { stat } from "fs/promises";

import { getAuthPath, getAuthPaths } from "./opencode-auth.js";
import { getGoogleTokenCachePath } from "./google-token-cache.js";
import { getAntigravityAccountsCandidatePaths, readAntigravityAccounts } from "./google.js";
import { getFirmwareKeyDiagnostics } from "./firmware.js";
import { getChutesKeyDiagnostics } from "./chutes.js";
import {
  getPricingSnapshotMeta,
  listProviders,
  getProviderModelCount,
} from "./modelsdev-pricing.js";
import { getPackageVersion } from "./version.js";
import {
  getOpenCodeMessageDir,
  getOpenCodeSessionDir,
  listSessionIDsFromMessageStorage,
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

  lines.push(`Quota Status (opencode-quota${version ? ` v${version}` : ""})`);
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

  const msgDir = getOpenCodeMessageDir();
  const sesDir = getOpenCodeSessionDir();
  lines.push(
    `- opencode storage message: ${msgDir}${(await pathExists(msgDir)) ? "" : " (missing)"}`,
  );
  lines.push(
    `- opencode storage session: ${sesDir}${(await pathExists(sesDir)) ? "" : " (missing)"}`,
  );

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

  // === pricing snapshot ===
  const meta = getPricingSnapshotMeta();
  lines.push("");
  lines.push("pricing_snapshot:");
  lines.push(`- source: ${meta.source}`);
  lines.push(`- generatedAt: ${new Date(meta.generatedAt).toISOString()}`);
  lines.push(`- units: ${meta.units}`);
  const providers = listProviders();
  lines.push(`- providers: ${providers.join(",")}`);
  for (const p of providers) {
    lines.push(`  - ${p}: models=${fmtInt(getProviderModelCount(p))}`);
  }

  // === storage scan ===
  const sessionIDs = await listSessionIDsFromMessageStorage();
  lines.push("");
  lines.push("storage:");
  lines.push(`- sessions_in_message_storage: ${fmtInt(sessionIDs.length)}`);

  // === unknown pricing ===
  // We intentionally report unknowns for *all time* so users can see what needs mapping.
  const agg = await aggregateUsage({});
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
