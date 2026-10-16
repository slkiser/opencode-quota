export declare const CURSOR_API_HOST = "api2.cursor.sh";
export declare const CURSOR_WEBSITE_HOST = "cursor.com";
/**
 * Production OAuth client id Cursor's IDE sends on `POST /oauth/token`
 * (Cursor 3.17.19 `workbench.desktop.main.js`, `cursorCreds.authClientId` for
 * `backendUrl` `https://api2.cursor.sh`). The IDE's non-production id is not
 * used: a custom `CURSOR_API_BASE_URL` keeps this one.
 */
export declare const CURSOR_OAUTH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
export declare const FALLBACK_CLIENT_VERSION = "cli-2026.07.09-a3815c0";
export declare const CURSOR_PROVIDER_ID = "cursor";
/** Private provider option injected by the OpenCode plugin for summary turns. */
export declare const CURSOR_COMPACTION_OPTION = "opencodeCompaction";
/** OpenCode host rebuilt its history without a provider compaction turn. */
export declare const CURSOR_HISTORY_REWRITE_OPTION = "opencodeHistoryRewrite";
/** Current OpenCode primary agent; used to invalidate incompatible checkpoints. */
export declare const CURSOR_HOST_AGENT_OPTION = "opencodeHostAgent";
export declare const TOKEN_EXPIRY_THRESHOLD_S = 300;
export declare const RUN_PATH = "/agent.v1.AgentService/Run";
export declare const AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
export declare const SERVER_CONFIG_PATH = "/aiserver.v1.ServerConfigService/GetServerConfig";
export declare const MODEL_CACHE_FILE = "cursor-models.json";
/** Bumped when the on-disk model cache shape/semantics change (forces refetch). */
export declare const MODEL_CACHE_SCHEMA_VERSION = 3;
export declare const MODEL_CACHE_TTL_MS = 86400000;
export declare const CONVERSATION_CACHE_DIR = "cursor-conversations";
export declare const CONVERSATION_CACHE_SCHEMA_VERSION = 4;
export declare const CONVERSATION_CACHE_TTL_MS = 86400000;
export declare const VERSION_CACHE_FILE = "cursor-client-version.json";
export declare const CONTENT_TYPE_CONNECT_PROTO = "application/connect+proto";
export declare const CONNECT_PROTOCOL_VERSION = "1";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ContextOption = "200k" | "272k" | "300k" | "1m";
