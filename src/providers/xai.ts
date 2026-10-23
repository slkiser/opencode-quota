/**
 * xAI SuperGrok: the shared credits meter of each OpenCode xAI sign-in, the one Grok Build shows
 * (GET https://cli-chat-proxy.grok.com/v1/billing?format=credits). Once it is read, the
 * subscription (GET https://grok.com/rest/subscriptions) may refine the account name. A sign-in
 * OpenCode could not return shows as its own error. OpenCode alone refreshes the OAuth tokens.
 */

import type { ErrorFacts } from "../core/errors.js";
import { classifyWindow } from "../core/windows.js";
import { sanitizeSingleLineDisplaySnippet } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderMatchContext,
} from "../lib/entries.js";
import { clampPercent } from "../lib/format-utils.js";
import { errorWords, failureFacts, requestJson } from "../lib/http.js";
import { isRecord, nonEmptyString } from "../lib/json-guards.js";
import { type CredentialRow, readCredentialRows, readOAuthLogin } from "../lib/opencode-auth.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  deriveResolvedAuthIdentity,
  loginListIdentity,
  type ResolvedAuthIdentity,
} from "../lib/resolved-auth-identity.js";
import {
  type FetchError,
  fetchEachLogin,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  fetchError,
} from "./contract.js";

const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const SUBSCRIPTIONS_TIMEOUT_MS = 2_000;
const HEAVY_OFFER_ID_RE = /^heavy-p\d+m-\d{1,2}-[a-z]{3}\d{4}$/i;
const USER_AGENT = "OpenCode-Quota-Toast/1.0";

type XaiLabel = "xAI Lite" | "xAI SuperGrok" | "xAI Heavy";

type ResolvedXaiOAuth =
  | { state: "none" }
  | { state: "failed"; error: string }
  | { state: "configured"; accessToken: string; expiresAt?: number };

type XaiLogin = {
  row: CredentialRow;
  auth: Exclude<ResolvedXaiOAuth, { state: "none" }>;
};

/** What one sign-in gave: the credits row, or the error to show. */
type XaiLoginFetch = { rows: ProviderRow[]; errors: FetchError[]; fallbackName?: XaiLabel };

function isoOrUndefined(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The credits row's label: the period type xAI sent ("WEEKLY" → "Weekly"). */
function periodLabel(value: unknown): string {
  const raw = nonEmptyString(value)?.toUpperCase() ?? "";
  if (raw.includes("WEEK")) return "Weekly";
  if (raw.includes("MONTH")) return "Monthly";
  if (raw.includes("DAY") || raw.includes("DAILY")) return "Daily";
  return "Period";
}

function resolveXaiOAuth(row: CredentialRow): ResolvedXaiOAuth {
  const login = readOAuthLogin(row);
  if (!login) return { state: "none" };
  if (login.state === "failed") return { state: "failed", error: login.error };
  if (!login.accessToken) return { state: "none" };
  return { state: "configured", accessToken: login.accessToken, expiresAt: login.expiresAt };
}

/**
 * Every OpenCode xAI sign-in, read fresh: OpenCode can replace one while servicing a model
 * request. A sign-in OpenCode could not return stays, so it shows as its own error.
 */
async function readXaiLogins(): Promise<XaiLogin[]> {
  return (await readCredentialRows(["xai"], { methods: ["oauth"] })).flatMap((row) => {
    const auth = resolveXaiOAuth(row);
    return auth.state === "none" ? [] : [{ row, auth }];
  });
}

/** Who xAI is signed in as: every sign-in's access token. */
async function xaiLoginsIdentity(
  logins: readonly XaiLogin[],
): Promise<ResolvedAuthIdentity | null> {
  return loginListIdentity(
    "xai",
    await Promise.all(
      logins.map(async ({ row, auth }) => ({
        identity:
          auth.state === "configured"
            ? await deriveResolvedAuthIdentity({
                providerId: "xai",
                principal: { kind: "credential", value: auth.accessToken },
              })
            : null,
        row,
      })),
    ),
  );
}

/** The credits row, labelled with its period ("Weekly"), with when the period started. */
function parseCreditsRow(payload: unknown): ProviderRow | null {
  if (!isRecord(payload) || !isRecord(payload.config)) {
    throw new Error("xAI credits response returned an unexpected response shape");
  }

  const config = payload.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : null;
  const hasUsage = Object.hasOwn(config, "creditUsagePercent");
  const hasPeriod = Boolean(
    nonEmptyString(period?.type) || nonEmptyString(period?.start) || nonEmptyString(period?.end),
  );
  if (!hasPeriod && !hasUsage) return null;

  // Protobuf JSON omits zero-valued fields, so an absent percentage with a
  // current period means 0% used rather than missing quota.
  const usedPercent = hasUsage ? config.creditUsagePercent : 0;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    throw new Error("xAI credits response returned an invalid usage percentage");
  }

  const startedAtIso = isoOrUndefined(period?.start);
  const endsAtIso = isoOrUndefined(period?.end);
  const observedAtMs = Date.now();
  const inPeriod =
    startedAtIso !== undefined &&
    endsAtIso !== undefined &&
    Date.parse(startedAtIso) < observedAtMs &&
    observedAtMs < Date.parse(endsAtIso);

  const label = periodLabel(period?.type);
  return quotaRow({
    key: "credits",
    label,
    window: classifyWindow(label),
    percentRemaining: clampPercent(100 - usedPercent),
    resetsAt: endsAtIso ?? isoOrUndefined(config.billingPeriodEnd),
    windowStartedAt: inPeriod ? startedAtIso : undefined,
  });
}

function xaiHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-grok-client-surface": "grok-build",
    "x-grok-client-version": "1.0.0",
  };
}

function parseXaiLabel(payload: unknown): XaiLabel {
  const subscriptions =
    isRecord(payload) && Array.isArray(payload.subscriptions) ? payload.subscriptions : [];
  const active = subscriptions.find(
    (subscription) =>
      isRecord(subscription) && subscription.status === "SUBSCRIPTION_STATUS_ACTIVE",
  );
  if (!isRecord(active)) return "xAI SuperGrok";

  const activeOffer = isRecord(active.activeOffer) ? active.activeOffer : null;
  const providerOfferId = nonEmptyString(activeOffer?.providerOfferId);
  if (providerOfferId && HEAVY_OFFER_ID_RE.test(providerOfferId)) return "xAI Heavy";

  const tier = nonEmptyString(active.tier);
  if (tier === "SUBSCRIPTION_TIER_SUPER_GROK_HEAVY") return "xAI Heavy";
  if (tier === "SUBSCRIPTION_TIER_SUPER_GROK_LITE") return "xAI Lite";
  // SUPER_GROK, SUPER_GROK_PRO, and unknown tiers keep the standard label.
  return "xAI SuperGrok";
}

/** Subscription metadata only refines the label, so any failure keeps the standard one. */
async function queryXaiLabel(accessToken: string, requestTimeoutMs?: number): Promise<XaiLabel> {
  const reply = await requestJson(SUBSCRIPTIONS_URL, {
    method: "GET",
    headers: xaiHeaders(accessToken),
    secrets: [accessToken],
    timeoutMs: Math.min(requestTimeoutMs ?? SUBSCRIPTIONS_TIMEOUT_MS, SUBSCRIPTIONS_TIMEOUT_MS),
  });
  if (!reply.ok) return "xAI SuperGrok";
  try {
    return parseXaiLabel(reply.json);
  } catch {
    return "xAI SuperGrok";
  }
}

function safeErrorText(message: string): string {
  return sanitizeSingleLineDisplaySnippet(message, 160);
}

function failedLogin(message: string, facts?: ErrorFacts): XaiLoginFetch {
  return { rows: [], errors: [fetchError(message, facts)] };
}

/** The credits row of one sign-in, named after its subscription. */
async function queryXaiLogin(
  auth: XaiLogin["auth"],
  requestTimeoutMs?: number,
): Promise<XaiLoginFetch> {
  if (auth.state === "failed") {
    return failedLogin(
      `xAI sign-in could not be refreshed: ${auth.error}. Run \`opencode auth login xai\`.`,
    );
  }
  if (auth.expiresAt !== undefined && auth.expiresAt <= Date.now()) {
    return failedLogin(
      "xAI OAuth token expired; use xAI in OpenCode to refresh it or reconnect xAI",
    );
  }

  const reply = await requestJson(CREDITS_URL, {
    method: "GET",
    headers: xaiHeaders(auth.accessToken),
    secrets: [auth.accessToken],
    timeoutMs: requestTimeoutMs,
  });
  if (!reply.ok) {
    const { failure } = reply;
    return failedLogin(
      failure.kind === "http"
        ? `xAI API error ${failure.status}${errorWords(safeErrorText(failure.detail))}`
        : safeErrorText(failure.detail),
      failureFacts(failure),
    );
  }

  let row: ProviderRow | null;
  try {
    row = parseCreditsRow(reply.json);
  } catch (error) {
    return failedLogin(safeErrorText(error instanceof Error ? error.message : String(error)));
  }
  if (!row) return failedLogin("No quota data");
  const label = await queryXaiLabel(auth.accessToken, requestTimeoutMs);
  return { rows: [row], errors: [], fallbackName: label };
}

export const xaiProvider: QuotaProvider = {
  id: "xai",
  cachePolicy: {
    kind: "resolved-auth",
    resolveIdentity: async () => xaiLoginsIdentity(await readXaiLogins()),
  },

  async isAvailable(): Promise<boolean> {
    return (await readXaiLogins()).length > 0;
  },

  matchesCurrentModel(model: string, context?: QuotaProviderMatchContext): boolean {
    if (context?.currentProviderID) {
      return context.currentProviderID.trim().toLowerCase() === "xai";
    }
    return modelProviderMatchesRuntimeId(model, "xai");
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const requestTimeoutMs = ctx.config?.requestTimeoutMs;
    const logins = await readXaiLogins();
    const accounts = await fetchEachLogin({
      providerName: "xAI",
      logins,
      fetchLogin: ({ auth }) => queryXaiLogin(auth, requestTimeoutMs),
    });
    return { attempted: logins.length > 0, accounts, debug: [] };
  },
};
