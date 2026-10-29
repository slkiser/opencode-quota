/**
 * The v6 quota data model: rows with stable ids, one snapshot per provider, and one error
 * vocabulary. The server builds these; the TUI, Web text and the CLI only read them. Every
 * value is plain JSON, because snapshots travel over the RPC and are saved to disk.
 */
import type { QuotaExportProvider } from "../lib/quota-export-types.js";
import type { ClientSettings, Settings } from "../settings/schema.js";

/** What a row's number means (ADR 0001: the 7 legacy result types become 5). */
export type RowType = "quota" | "budget" | "usage" | "balance" | "status";

/** How the number was acquired (ADR 0001: the 5 legacy methods become 4). */
export type RowMethod = "remote_api" | "dashboard_scrape" | "local_cli" | "local_estimation";

export type RowAuthority = "provider_reported" | "locally_derived";

/** The period a quota row covers; drives short labels, preferred windows and reset notices. */
export type QuotaWindow =
  | "rpm"
  | "hour"
  | "five_hour"
  | "session"
  | "day"
  | "week"
  | "month"
  | "year"
  | "mcp"
  | "code_review";

/** A count unit is singular, for example "request"; the text adds the plural. */
export type AmountUnit =
  | { kind: "currency"; code: string }
  | { kind: "count"; unit: string }
  | { kind: "custom"; symbol: string };

/** An exact number: `decimal` is a canonical decimal string such as "12.5" or "-3". */
export type Amount = { decimal: string; unit: AmountUnit };

export type QuotaRow = {
  /** `${providerId}.${key}`, for example "anthropic.weekly_fable"; the hide/rename/order key. */
  id: string;
  providerId: string;
  /** Account or plan shown after the provider name, for example "work" or "SuperGrok". */
  account?: string;
  /** Default label, for example "5h", "Weekly", "Fable", "Balance". */
  label: string;
  type: RowType;
  method: RowMethod;
  authority: RowAuthority;
  window?: QuotaWindow;
  prominence: "primary" | "supplementary";
  /** Raw percent left; display rounds and clamps. May be below 0 when over quota. */
  percentRemaining?: number;
  used?: Amount;
  limit?: Amount;
  remaining?: Amount;
  /** The value of a usage or balance row. */
  amount?: Amount;
  /** The value of a yes/no status row. */
  flag?: boolean;
  /** Text value, for example "Unlimited" or a custom provider's own summary. */
  text?: string;
  /** ISO time the window resets. */
  resetsAt?: string;
  /** ISO time the window started (pace marker and runs-out estimate). */
  windowStartedAt?: string;
};

export type QuotaErrorCode =
  | "not_configured"
  | "login_expired"
  | "no_plan"
  | "rate_limited"
  | "timeout"
  | "network"
  | "provider_error"
  | "bad_response"
  | "no_data"
  | "local_tool"
  | "internal";

export type QuotaError = {
  code: QuotaErrorCode;
  /** HTTP status, when the provider answered with one. */
  status?: number;
  /** When the provider said to try again. */
  retryAtMs?: number;
  /** The local program involved, for `local_tool`, for example "Claude CLI". */
  tool?: string;
  /** For `local_tool`: true when the program is missing rather than failing. */
  missing?: boolean;
  /** The provider's own message, scrubbed; no report shows it. */
  detail?: string;
};

export type DebugDetail = { key: string; value: string };

export type ProviderSnapshot = {
  providerId: string;
  /** Registration label, for example "Anthropic" or "Copilot". */
  label: string;
  /** The last good rows; a failed refresh keeps them. */
  rows: QuotaRow[];
  /** When `rows` were fetched. */
  okAtMs?: number;
  /** When the last attempt ended. */
  checkedAtMs?: number;
  /** Why the last attempt failed. */
  error?: QuotaError;
  refreshing: boolean;
  /**
   * Provider facts for /quota_status. Like `exportPart`, from the last check in this server
   * process: the store keeps both in memory only, never in the snapshot file, and a client
   * snapshot holds neither.
   */
  debug?: DebugDetail[];
  /** This provider's part of the export file. */
  exportPart?: QuotaExportProvider;
};

/** A quota window that reset since the last check; each TUI shows it once (by `id`). */
export type ResetNotice = {
  id: string;
  rowId: string;
  providerId: string;
  account?: string;
  label: string;
  window: QuotaWindow;
  percentRemaining: number;
  atMs: number;
};

/** One model's input tokens in a session: new input, cache reads and cache writes. */
export type SessionModelInput = {
  modelID: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Tokens a session used so far (with its subagents when the words say "tree"). */
export type SessionTokens = {
  input: number;
  cachedInput: number;
  output: number;
  /** Each model with input tokens, for the sidebar's low cache line; absent when none had any. */
  models?: SessionModelInput[];
};

/** The words every surface uses, on every client (TUI, Web, Desktop, CLI). */
export type Words = Settings["words"];

/** A session's model: its id and OpenCode's provider id. */
export type SessionModel = { id?: string; providerID?: string };

export type QuotaSnapshot = {
  version: 6;
  /** Opaque credential-source scope; only snapshots of the same scope share provider rows. */
  sourceScope?: string;
  /** The session whose current model and credential source this snapshot describes. */
  sessionID?: string;
  /** Enabled and available providers, in registration order. */
  providers: ProviderSnapshot[];
  /** With a session: the providers serving its current model (the "current model only" filter). */
  currentModelProviderIds?: string[];
  /**
   * With a session: for a provider whose rows serve different models (the custom providers,
   * one definition each), the row id prefixes that serve its current model, by provider id.
   * Every row is still checked; under "current model only" just these show.
   */
  currentModelRowPrefixes?: Record<string, string[]>;
  /** With a session: the tokens it used so far. */
  sessionTokens?: SessionTokens;
  /**
   * The OpenCode provider id each custom definition serves, by the prefix of its row ids
   * (`quota-providers.custom.<definition id>.`); absent without custom definitions.
   */
  customRowProviders?: Record<string, string>;
  /**
   * The server's words, for the text the server and CLI print (absent means the default words).
   * The TUI takes its words from its settings store instead.
   */
  words?: Words;
  /** All editable file settings, refreshed with every settings change. */
  settings?: ClientSettings;
  /** This server converted v5 settings into the file; a TUI announces it once. */
  settingsConverted?: boolean;
  resetNotices: ResetNotice[];
  generatedAtMs: number;
  /** Random for each server start; revisions compare only within one server. */
  serverId: string;
  /** Grows with every snapshot the server builds: of two, the higher revision is newer. */
  revision: number;
};
