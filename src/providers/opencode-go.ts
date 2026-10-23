import { createHash } from "node:crypto";

import type { DebugDetail } from "../core/types.js";
import {
  API_KEY_VENDORS,
  hasVendorKey,
  readVendorKeys,
  type VendorKeys,
} from "../lib/api-key-resolver.js";
import type { QuotaProvider, QuotaProviderContext } from "../lib/entries.js";
import { selectConnectionCredentialRows } from "../lib/opencode-auth.js";
import {
  consoleLoginIdentity,
  consoleSignInFailure,
  resolveOpenCodeConsoleAuth,
} from "../lib/opencode-console-auth.js";
import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import { composeResolvedAuthIdentities } from "../lib/resolved-auth-identity.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import { vendorKeysIdentity } from "./cache-policies.js";
import {
  type FetchError,
  FIVE_HOUR,
  failedAccount,
  fetchError,
  MONTHLY,
  type ProviderFetchResult,
  type ProviderRow,
  quotaRow,
  WEEKLY,
} from "./contract.js";
import { fetchStoredKeys } from "./key-vendor.js";
import { vendorKeyDetails, vendorKeyState } from "./result-helpers.js";

const LABEL = "OpenCode Go";
const OPENCODE_GO_AUTH = API_KEY_VENDORS["opencode-go"];
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

/**
 * Go's one key list. `opencode` is a legacy alias of the `opencode-go` integration in the
 * credential database (see API_KEY_VENDORS). Alias rows must not become additional
 * connections: prefer native rows and collapse rows holding the same credential (e.g. Zen + Go
 * sharing a workspace key). Console OAuth credentials cannot authorize this API and are skipped.
 */
async function readGoKeys(directory: string): Promise<VendorKeys> {
  return await readVendorKeys(OPENCODE_GO_AUTH, directory, {
    selectRows: (rows) =>
      selectConnectionCredentialRows(
        rows.filter((row) => row.value.type !== "oauth"),
        "opencode-go",
      ),
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
  cachePolicy: {
    kind: "resolved-auth",
    /**
     * The keys' identity; with a usable Console login, that login and its usable keys together,
     * since Go reads the Console first and falls back to the keys. A key login that is empty or
     * not an API key is left out, so it never hides a Console account switch.
     */
    async resolveIdentity(ctx) {
      const keys = await readVendorKeys(OPENCODE_GO_AUTH, ctx.locationDirectory);
      const consoleAuth = await resolveOpenCodeConsoleAuth();
      if (consoleAuth.state !== "configured") return await vendorKeysIdentity("opencode-go", keys);
      const consoleIdentity = await consoleLoginIdentity("opencode-go", consoleAuth.credential);
      if (!consoleIdentity) return null;
      const usableKeysIdentity = await vendorKeysIdentity("opencode-go", {
        ...keys,
        logins: keys.logins.filter((login) => login.auth.state === "configured"),
      });
      return await composeResolvedAuthIdentities({
        providerId: "opencode-go",
        identities: usableKeysIdentity ? [consoleIdentity, usableKeysIdentity] : [consoleIdentity],
      });
    },
  },

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Any Console sign-in counts, even a failed one, so fetch() can show its error when there
    // is no API key.
    if ((await resolveOpenCodeConsoleAuth()).state !== "none") return true;
    if (vendorKeyState(await readGoKeys(ctx.locationDirectory)).state === "configured") return true;
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
      const keys = await readGoKeys(ctx.locationDirectory);
      return await fetchWithApiKey(ctx, keys, [
        ...vendorKeyDetails(OPENCODE_GO_AUTH, keys, ctx.locationDirectory),
        selectedWindowsDetail,
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
      consoleFailure = fetchError(consoleError, consoleResult.facts);
    } else {
      // OpenCode refreshes the Console token when it is read, so an expired one is rare.
      const failure = consoleSignInFailure(consoleAuth);
      consoleError = failure.detail;
      consoleFailure = { message: failure.message };
    }

    // The Console request or sign-in failed, or the sign-in expired: fall back to the API-key
    // path and surface the console error in diagnostics. Without an API key the failure is Go's
    // one error row.
    const keys = await readGoKeys(ctx.locationDirectory);
    return await fetchWithApiKey(
      ctx,
      keys,
      [
        ...vendorKeyDetails(OPENCODE_GO_AUTH, keys, ctx.locationDirectory),
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
  keys: VendorKeys,
  debug: DebugDetail[],
  consoleFailure?: FetchError,
): Promise<ProviderFetchResult> {
  const windows = OPENCODE_GO_WINDOW_ORDER;
  const notSubscribed: ProviderFetchResult = {
    attempted: true,
    accounts: [],
    debug: [...debug, NOT_SUBSCRIBED_DETAIL],
  };

  if (!keys.envOrConfig) {
    const storedKeys = keys.logins.flatMap(({ auth }) =>
      auth.state === "configured" ? [auth.apiKey] : [],
    );
    retainCurrentCredentialFingerprints(new Set(storedKeys.map(fingerprintCredential)));
    if (!hasVendorKey(keys)) {
      return consoleFailure
        ? {
            attempted: true,
            accounts: [{ name: LABEL, rows: [], errors: [consoleFailure] }],
            debug,
          }
        : { attempted: false, accounts: [], debug };
    }

    // A not-subscribed key gives no account at all.
    const { accounts } = await fetchStoredKeys({
      providerName: LABEL,
      keys,
      brokenFirst: true,
      async fetchKey(apiKey) {
        const fingerprint = fingerprintCredential(apiKey);
        if (notSubscribedCredentialFingerprints.has(fingerprint)) return null;
        const result = await queryOpenCodeGoQuota(apiKey, {
          requestTimeoutMs: ctx.config.requestTimeoutMs,
        });
        if (result.success) return { rows: goRows(result, windows), errors: [] };
        if (result.notSubscribed === true) {
          notSubscribedCredentialFingerprints.add(fingerprint);
          return null;
        }
        return { rows: [], errors: [fetchError(result.error, result.facts)] };
      },
    });
    const nothingShown = accounts.every(
      (account) => account.rows.length === 0 && account.errors.length === 0,
    );
    return {
      attempted: true,
      accounts,
      debug: nothingShown && storedKeys.length > 0 ? [...debug, NOT_SUBSCRIBED_DETAIL] : debug,
    };
  }

  const apiKey = keys.envOrConfig.key;
  const fingerprint = fingerprintCredential(apiKey);
  retainCurrentCredentialFingerprints(new Set([fingerprint]));
  if (notSubscribedCredentialFingerprints.has(fingerprint)) return notSubscribed;

  const result = await queryOpenCodeGoQuota(apiKey, {
    requestTimeoutMs: ctx.config.requestTimeoutMs,
  });
  if (!result.success && result.notSubscribed === true) {
    notSubscribedCredentialFingerprints.add(fingerprint);
    return notSubscribed;
  }
  if (!result.success) {
    return {
      attempted: true,
      accounts: [failedAccount(LABEL, result.error, result.facts)],
      debug: [...debug, { key: "live_fetch_error", value: result.error }],
    };
  }

  return {
    attempted: true,
    accounts: [{ name: LABEL, rows: goRows(result, windows), errors: [] }],
    debug,
  };
}
