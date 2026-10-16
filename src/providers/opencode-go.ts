import { createHash } from "node:crypto";

import { safeErrorText } from "../core/redact.js";
import type { DebugDetail } from "../core/types.js";
import {
  API_KEY_VENDORS,
  type ApiKeyLoginDiagnostics,
  getApiKeyLoginDiagnostics,
  readKeyLogins,
  resolveApiKeyLogin,
} from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { selectConnectionCredentialRows } from "../lib/opencode-auth.js";
import { consoleBaseUrl, resolveOpenCodeConsoleAuth } from "../lib/opencode-console-auth.js";
import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import { vendorKeysPolicy } from "./cache-policies.js";
import {
  type FetchError,
  FIVE_HOUR,
  failedAccount,
  fetchKeyLogins,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { statusDetailsFromRecord } from "./result-helpers.js";

const LABEL = "OpenCode Go";
const OPENCODE_GO_AUTH = API_KEY_VENDORS["opencode-go"];
const CONSOLE_LOGIN_HINT = "Run `opencode auth login opencode`.";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_SLOTS = { rolling: FIVE_HOUR, weekly: WEEKLY, monthly: MONTHLY } as const;
const NOT_SUBSCRIBED_DETAIL = { key: "opencode_go_state", value: "not_subscribed" };

/** Keys the API answered "not subscribed" for; not asked again until the stored keys change. */
const notSubscribedCredentialFingerprints = new Set<string>();

export function __resetOpenCodeGoNotSubscribedForTests(): void {
  notSubscribedCredentialFingerprints.clear();
}

function fingerprintCredential(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function retainCurrentCredentialFingerprints(current: ReadonlySet<string>): void {
  for (const fingerprint of notSubscribedCredentialFingerprints) {
    if (!current.has(fingerprint)) notSubscribedCredentialFingerprints.delete(fingerprint);
  }
}

function authStatusDetails(diagnostics: ApiKeyLoginDiagnostics): DebugDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    auth_source: diagnostics.source ?? "(none)",
    auth_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.state === "invalid" ? diagnostics.error : undefined,
  });
}

/** The selected windows of one Go reply, in the order 5h, weekly, monthly. */
function goRows(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: readonly OpenCodeGoWindowKey[],
): ProviderRow[] {
  return OPENCODE_GO_WINDOW_ORDER.filter((window) => selectedWindows.includes(window)).map(
    (window) =>
      quotaRow({
        ...OPENCODE_GO_SLOTS[window],
        percentRemaining: result[window].percentRemaining,
        resetsAt: result[window].resetTimeIso,
      }),
  );
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",
  cachePolicy: vendorKeysPolicy("opencode-go"),

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    // Any Console sign-in counts, even a failed one, so fetch() can show its error when there
    // is no API key.
    if ((await resolveOpenCodeConsoleAuth()).state !== "none") return true;
    const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);
    if (auth.state === "configured") return true;
    notSubscribedCredentialFingerprints.clear();
    return false;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<ProviderFetchResult> {
    const windows = OPENCODE_GO_WINDOW_ORDER;
    const selectedWindowsDetail = { key: "selected_windows", value: windows.join(",") };
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "none") {
      const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
      return await fetchWithApiKey(ctx, diagnostics, [
        ...authStatusDetails(diagnostics),
        selectedWindowsDetail,
      ]);
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the console token when it is read, so this is rare;
      // fall back to the API-key path, which also still accepts workspace API keys.
      return await fetchWithApiKey(ctx, await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH), [
        { key: "console_auth_state", value: "expired" },
        { key: "go_source", value: "legacy_key" },
      ]);
    }

    let consoleError: string;
    let consoleFailure: FetchError;
    if (consoleAuth.state === "configured") {
      const consoleResult = await queryOpenCodeGoConsoleStatus(consoleAuth.credential, {
        requestTimeoutMs: ctx.config.requestTimeoutMs,
      });
      if (consoleResult.success) {
        return {
          attempted: true,
          accounts: [
            { name: LABEL, login: "console:go", rows: goRows(consoleResult, windows), errors: [] },
          ],
          debug: [
            { key: "console_auth_state", value: "configured" },
            { key: "console_server", value: consoleBaseUrl(consoleAuth.credential) },
            { key: "go_source", value: "console" },
            selectedWindowsDetail,
          ],
        };
      }
      if (consoleResult.notSubscribed === true) {
        return {
          attempted: true,
          accounts: [],
          debug: [
            { key: "console_auth_state", value: "configured" },
            NOT_SUBSCRIBED_DETAIL,
            selectedWindowsDetail,
          ],
        };
      }
      consoleError = consoleResult.error;
      consoleFailure = { message: consoleError };
    } else {
      consoleError = safeErrorText(consoleAuth.error);
      consoleFailure = {
        message: `OpenCode Console sign-in failed: ${consoleError}. ${CONSOLE_LOGIN_HINT}`,
      };
    }

    // The Console request or sign-in failed: fall back to the API-key path and surface the
    // console error in diagnostics. Without an API key the failure is Go's one error row.
    const diagnostics = await getApiKeyLoginDiagnostics(OPENCODE_GO_AUTH);
    return await fetchWithApiKey(
      ctx,
      diagnostics,
      [
        ...authStatusDetails(diagnostics),
        { key: "console_auth_state", value: consoleAuth.state },
        { key: "console_error", value: consoleError },
        { key: "go_source", value: "legacy_key" },
        selectedWindowsDetail,
      ],
      consoleFailure,
    );
  },
};

/**
 * The API-key path. `consoleFailure` is set when the Console sign-in or its request failed;
 * without an API key it becomes Go's one error row.
 */
async function fetchWithApiKey(
  ctx: QuotaProviderContext,
  diagnostics: ApiKeyLoginDiagnostics,
  debug: DebugDetail[],
  consoleFailure?: FetchError,
): Promise<ProviderFetchResult> {
  const windows = OPENCODE_GO_WINDOW_ORDER;
  const notSubscribed: ProviderFetchResult = {
    attempted: true,
    accounts: [],
    debug: [...debug, NOT_SUBSCRIBED_DETAIL],
  };
  const auth = await resolveApiKeyLogin(OPENCODE_GO_AUTH);

  if (auth.state === "none") {
    notSubscribedCredentialFingerprints.clear();
    return consoleFailure
      ? {
          attempted: true,
          accounts: [failedAccount(LABEL, consoleFailure.message)],
          debug,
        }
      : { attempted: false, accounts: [], debug };
  }

  if (diagnostics.source === "opencode.db") {
    // `opencode` is a legacy alias of the `opencode-go` integration in the
    // credential database (see API_KEY_VENDORS). Alias rows must not
    // become additional connections: prefer native rows and collapse rows
    // holding the same credential (e.g. Zen + Go sharing a workspace key).
    // Console OAuth credentials cannot authorize this API and are skipped.
    const logins = await readKeyLogins(OPENCODE_GO_AUTH, {
      selectRows: (rows) =>
        selectConnectionCredentialRows(
          rows.filter((row) => row.value.type !== "oauth"),
          "opencode-go",
        ),
    });
    if (logins.length > 0) {
      const keys = logins.flatMap(({ auth: login }) =>
        login.state === "configured" ? [login.apiKey] : [],
      );
      retainCurrentCredentialFingerprints(new Set(keys.map(fingerprintCredential)));
      // A not-subscribed key gives no account at all.
      const accounts = await fetchKeyLogins({
        providerName: LABEL,
        logins,
        brokenFirst: true,
        async fetchLogin({ auth: login }) {
          const fingerprint = fingerprintCredential(login.apiKey);
          if (notSubscribedCredentialFingerprints.has(fingerprint)) return null;
          const result = await queryOpenCodeGoQuota(login.apiKey, {
            requestTimeoutMs: ctx.config.requestTimeoutMs,
          });
          if (result.success) return { rows: goRows(result, windows), errors: [] };
          if (result.notSubscribed === true) {
            notSubscribedCredentialFingerprints.add(fingerprint);
            return null;
          }
          return { rows: [], errors: [{ message: result.error }] };
        },
      });
      const nothingShown = accounts.every(
        (account) => account.rows.length === 0 && account.errors.length === 0,
      );
      return {
        attempted: true,
        accounts,
        debug: nothingShown && keys.length > 0 ? [...debug, NOT_SUBSCRIBED_DETAIL] : debug,
      };
    }
  }

  if (auth.state === "invalid") {
    notSubscribedCredentialFingerprints.clear();
    return { attempted: true, accounts: [failedAccount(LABEL, auth.error)], debug };
  }

  const fingerprint = fingerprintCredential(auth.apiKey);
  retainCurrentCredentialFingerprints(new Set([fingerprint]));
  if (notSubscribedCredentialFingerprints.has(fingerprint)) return notSubscribed;

  const result = await queryOpenCodeGoQuota(auth.apiKey, {
    requestTimeoutMs: ctx.config.requestTimeoutMs,
  });
  if (!result.success && result.notSubscribed === true) {
    notSubscribedCredentialFingerprints.add(fingerprint);
    return notSubscribed;
  }
  if (!result.success) {
    return {
      attempted: true,
      accounts: [failedAccount(LABEL, result.error)],
      debug: [...debug, { key: "live_fetch_error", value: result.error }],
    };
  }

  return {
    attempted: true,
    accounts: [{ name: LABEL, rows: goRows(result, windows), errors: [] }],
    debug: [
      ...debug,
      ...OPENCODE_GO_WINDOW_ORDER.map((window) => {
        const usage = result[window];
        return {
          key: `${window}_usage`,
          value: `status=${usage.status} percent_used=${usage.usagePercent} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso}`,
        };
      }),
    ],
  };
}
