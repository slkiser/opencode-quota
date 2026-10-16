var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/plugin-v2.ts
import { Integration, Plugin } from "@opencode/plugin";

// src/constants.ts
var GEMINI_CLIENT_ID = "REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
var GEMINI_CLIENT_SECRET = "REDACTED_GOOGLE_OAUTH_CLIENT_SECRET";
var GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];
var GEMINI_REDIRECT_URI = "http://localhost:8085/oauth2callback";
var GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
var GEMINI_PROVIDER_ID = "google";

// src/plugin/oauth-authorize.ts
import { spawn } from "child_process";

// node_modules/jose/dist/node/esm/runtime/base64url.js
import { Buffer as Buffer2 } from "buffer";

// node_modules/jose/dist/node/esm/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;

// node_modules/jose/dist/node/esm/runtime/base64url.js
function normalize(input) {
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder.decode(encoded);
  }
  return encoded;
}
var encode = (input) => Buffer2.from(input).toString("base64url");
var decode = (input) => new Uint8Array(Buffer2.from(normalize(input), "base64url"));

// node_modules/jose/dist/node/esm/util/base64url.js
var base64url_exports = {};
__export(base64url_exports, {
  decode: () => decode2,
  encode: () => encode2
});
var encode2 = encode;
var decode2 = decode;

// node_modules/@openauthjs/openauth/dist/esm/pkce.js
function generateVerifier(length) {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return base64url_exports.encode(buffer);
}
async function generateChallenge(verifier, method) {
  if (method === "plain")
    return verifier;
  const encoder2 = new TextEncoder();
  const data = encoder2.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64url_exports.encode(new Uint8Array(hash));
}
async function generatePKCE(length = 64) {
  if (length < 43 || length > 128) {
    throw new Error("Code verifier length must be between 43 and 128 characters");
  }
  const verifier = generateVerifier(length);
  const challenge = await generateChallenge(verifier, "S256");
  return {
    verifier,
    challenge,
    method: "S256"
  };
}

// src/gemini/oauth.ts
import { randomBytes } from "crypto";

// src/plugin/debug.ts
import { createWriteStream } from "fs";
import { join } from "path";
import { cwd, env } from "process";
var DEBUG_FLAG = env.OPENCODE_GEMINI_DEBUG ?? "";
var MAX_BODY_PREVIEW_CHARS = 2e3;
var debugEnabled = DEBUG_FLAG.trim() === "1";
var logFilePath = debugEnabled ? defaultLogFilePath() : void 0;
var logWriter = createLogWriter(logFilePath);
var requestCounter = 0;
function isGeminiDebugEnabled() {
  return debugEnabled;
}
function logGeminiDebugMessage(message) {
  if (!debugEnabled) {
    return;
  }
  logDebug(`[Gemini Debug] ${message}`);
}
function formatDebugBodyPreview(text) {
  if (!text) {
    return void 0;
  }
  return truncateForLog(text);
}
function startGeminiDebugRequest(meta) {
  if (!debugEnabled) {
    return null;
  }
  const id = `GEMINI-${++requestCounter}`;
  const method = meta.method ?? "GET";
  logDebug(`[Gemini Debug ${id}] ${method} ${meta.resolvedUrl}`);
  if (meta.originalUrl && meta.originalUrl !== meta.resolvedUrl) {
    logDebug(`[Gemini Debug ${id}] Original URL: ${meta.originalUrl}`);
  }
  if (meta.projectId) {
    logDebug(`[Gemini Debug ${id}] Project: ${meta.projectId}`);
  }
  logDebug(`[Gemini Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`);
  logDebug(`[Gemini Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`);
  const bodyPreview = formatBodyPreview(meta.body);
  if (bodyPreview) {
    logDebug(`[Gemini Debug ${id}] Body Preview: ${bodyPreview}`);
  }
  return { id, streaming: meta.streaming, startedAt: Date.now() };
}
function logGeminiDebugResponse(context, response, meta = {}) {
  if (!debugEnabled || !context) {
    return;
  }
  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Gemini Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`
  );
  logDebug(
    `[Gemini Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers)
    )}`
  );
  const traceId = getHeaderValue(meta.headersOverride ?? response.headers, "x-cloudaicompanion-trace-id");
  if (traceId) {
    logDebug(`[Gemini Debug ${context.id}] Trace ID: ${traceId}`);
  }
  if (meta.note) {
    logDebug(`[Gemini Debug ${context.id}] Note: ${meta.note}`);
  }
  if (meta.error) {
    logDebug(`[Gemini Debug ${context.id}] Error: ${formatError(meta.error)}`);
  }
  if (meta.body) {
    logDebug(
      `[Gemini Debug ${context.id}] Response Body Preview: ${truncateForLog(meta.body)}`
    );
  }
}
function maskHeaders(headers) {
  if (!headers) {
    return {};
  }
  const result = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (key.toLowerCase() === "authorization") {
      result[key] = "[redacted]";
    } else {
      result[key] = value;
    }
  });
  return result;
}
function getHeaderValue(headers, key) {
  const target = key.toLowerCase();
  if (headers instanceof Headers) {
    const value = headers.get(key);
    return value ?? void 0;
  }
  if (Array.isArray(headers)) {
    for (const [headerKey, headerValue] of headers) {
      if (headerKey.toLowerCase() === target) {
        return headerValue;
      }
    }
    return void 0;
  }
  const record = headers;
  for (const [headerKey, headerValue] of Object.entries(record)) {
    if (headerKey.toLowerCase() === target) {
      return headerValue ?? void 0;
    }
  }
  return void 0;
}
function formatBodyPreview(body) {
  if (body == null) {
    return void 0;
  }
  if (typeof body === "string") {
    return truncateForLog(body);
  }
  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }
  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}
function truncateForLog(text) {
  if (text.length <= MAX_BODY_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${text.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}
function logDebug(line) {
  logWriter(line);
}
function formatError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function defaultLogFilePath() {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return join(cwd(), `gemini-debug-${timestamp}.log`);
}
function createLogWriter(filePath) {
  if (!filePath) {
    return () => {
    };
  }
  const stream = createWriteStream(filePath, { flags: "a" });
  return (line) => {
    stream.write(`${line}
`);
  };
}

// src/fetch.ts
function geminiFetch(input, init) {
  const proxy = process.env.OPENCODE_GEMINI_AUTH_PROXY;
  if (!proxy) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init ?? {},
    proxy
  });
}

// src/gemini/oauth.ts
async function authorizeGemini() {
  const pkce = await generatePKCE();
  const state = randomBytes(32).toString("hex");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GEMINI_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", GEMINI_REDIRECT_URI);
  url.searchParams.set("scope", GEMINI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.hash = "opencode";
  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state
  };
}
async function exchangeGeminiWithVerifier(code, verifier) {
  try {
    return await exchangeGeminiWithVerifierInternal(code, verifier);
  } catch (error) {
    return {
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
async function exchangeGeminiWithVerifierInternal(code, verifier) {
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("OAuth exchange: POST https://oauth2.googleapis.com/token");
  }
  const tokenResponse = await geminiFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: GEMINI_REDIRECT_URI,
      code_verifier: verifier
    })
  });
  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    if (isGeminiDebugEnabled()) {
      logGeminiDebugMessage(
        `OAuth exchange response: ${tokenResponse.status} ${tokenResponse.statusText}`
      );
      const preview = formatDebugBodyPreview(errorText);
      if (preview) {
        logGeminiDebugMessage(`OAuth exchange error body: ${preview}`);
      }
    }
    return { type: "failed", error: errorText };
  }
  const tokenPayload = await tokenResponse.json();
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth exchange success: expires_in=${tokenPayload.expires_in}s refresh_token=${tokenPayload.refresh_token ? "yes" : "no"}`
    );
  }
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("OAuth userinfo: GET https://www.googleapis.com/oauth2/v1/userinfo");
  }
  const userInfoResponse = await geminiFetch(
    "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`
      }
    }
  );
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth userinfo response: ${userInfoResponse.status} ${userInfoResponse.statusText}`
    );
  }
  const userInfo = userInfoResponse.ok ? await userInfoResponse.json() : {};
  const refreshToken = tokenPayload.refresh_token;
  if (!refreshToken) {
    return { type: "failed", error: "Missing refresh token in response" };
  }
  return {
    type: "success",
    refresh: refreshToken,
    access: tokenPayload.access_token,
    expires: Date.now() + tokenPayload.expires_in * 1e3,
    email: userInfo.email
  };
}

// src/plugin/activity-request-id.ts
function createGeminiActivityRequestId() {
  return Math.random().toString(36).substring(7);
}

// src/plugin/user-agent.ts
import { readFileSync } from "fs";
import { dirname, join as join2 } from "path";
import { fileURLToPath } from "url";

// src/plugin/gemini-cli-version.ts
var GEMINI_CLI_VERSION = "0.44.0-nightly.20260521.g57c42a5c4";

// src/plugin/user-agent.ts
var GEMINI_CLI_UA_NAME = "GeminiCLI";
var GEMINI_CLI_DEFAULT_MODEL = "gemini-code-assist";
var GEMINI_CLI_DEFAULT_SURFACE = "terminal";
var cachedGeminiCliVersion;
function getGeminiCliVersion() {
  if (cachedGeminiCliVersion) {
    return cachedGeminiCliVersion;
  }
  const explicitVersion = process.env.OPENCODE_GEMINI_CLI_VERSION?.trim();
  if (explicitVersion) {
    cachedGeminiCliVersion = explicitVersion;
    return cachedGeminiCliVersion;
  }
  if (GEMINI_CLI_VERSION.trim()) {
    cachedGeminiCliVersion = GEMINI_CLI_VERSION.trim();
    return cachedGeminiCliVersion;
  }
  const envVersion = process.env.npm_package_version?.trim();
  if (envVersion) {
    cachedGeminiCliVersion = envVersion;
    return cachedGeminiCliVersion;
  }
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join2(moduleDir, "../../package.json"),
    join2(moduleDir, "../package.json"),
    join2(process.cwd(), "package.json")
  ];
  for (const packagePath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        cachedGeminiCliVersion = parsed.version.trim();
        return cachedGeminiCliVersion;
      }
    } catch {
      continue;
    }
  }
  cachedGeminiCliVersion = "0.0.0";
  return cachedGeminiCliVersion;
}
function buildGeminiCliUserAgent(model) {
  const modelSegment = model?.trim() || GEMINI_CLI_DEFAULT_MODEL;
  const platformSegment = `${process.platform}; ${process.arch}; ${getGeminiCliSurface()}`;
  return `${GEMINI_CLI_UA_NAME}/${getGeminiCliVersion()}/${modelSegment} (${platformSegment})`;
}
function getGeminiCliSurface() {
  return process.env.GEMINI_CLI_SURFACE?.trim() || process.env.SURFACE?.trim() || GEMINI_CLI_DEFAULT_SURFACE;
}

// src/plugin/project/types.ts
var FREE_TIER_ID = "free-tier";
var LEGACY_TIER_ID = "legacy-tier";
var CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI"
};
var ProjectIdRequiredError = class extends Error {
  constructor() {
    super(
      "Google Gemini requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, then set `provider.google.options.projectId` in your Opencode config (or set OPENCODE_GEMINI_PROJECT_ID / GOOGLE_CLOUD_PROJECT)."
    );
  }
};
var AccountValidationRequiredError = class extends Error {
  validationUrl;
  validationLearnMoreUrl;
  constructor(message, validationUrl, validationLearnMoreUrl) {
    const parts = [message.trim()];
    if (validationUrl) {
      parts.push(`Complete validation: ${validationUrl}`);
    }
    if (validationLearnMoreUrl) {
      parts.push(`Learn more: ${validationLearnMoreUrl}`);
    }
    super(parts.join("\n"));
    this.name = "AccountValidationRequiredError";
    this.validationUrl = validationUrl;
    this.validationLearnMoreUrl = validationLearnMoreUrl;
  }
};

// src/plugin/project/utils.ts
function buildMetadata(projectId, includeDuetProject = true) {
  const metadata = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType
  };
  if (projectId && includeDuetProject) {
    metadata.duetProject = projectId;
  }
  return metadata;
}
function normalizeProjectId(value) {
  if (!value) {
    return void 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : void 0;
  }
  if (typeof value === "object" && typeof value.id === "string") {
    const trimmed = value.id.trim();
    return trimmed ? trimmed : void 0;
  }
  return void 0;
}
function pickOnboardTier(allowedTiers) {
  if (allowedTiers && allowedTiers.length > 0) {
    for (const tier of allowedTiers) {
      if (tier?.isDefault) {
        return tier;
      }
    }
    return allowedTiers[0] ?? { id: LEGACY_TIER_ID, userDefinedCloudaicompanionProject: true };
  }
  return { id: LEGACY_TIER_ID, userDefinedCloudaicompanionProject: true };
}
function buildIneligibleTierMessage(tiers) {
  if (!tiers || tiers.length === 0) {
    return void 0;
  }
  const reasons = tiers.map((tier) => tier?.reasonMessage?.trim()).filter((message) => !!message);
  return reasons.length > 0 ? reasons.join(", ") : void 0;
}
function throwIfValidationRequired(tiers) {
  if (!tiers || tiers.length === 0) {
    return;
  }
  const validationTier = tiers.find((tier) => {
    const reasonCode = tier?.reasonCode?.trim().toUpperCase();
    return reasonCode === "VALIDATION_REQUIRED" && !!tier.validationUrl?.trim();
  });
  if (!validationTier) {
    return;
  }
  throw new AccountValidationRequiredError(
    validationTier.reasonMessage?.trim() || "Verify your account to continue.",
    validationTier.validationUrl?.trim(),
    validationTier.validationLearnMoreUrl?.trim()
  );
}
function isVpcScError(payload) {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const error = payload.error;
  if (!error || typeof error !== "object") {
    return false;
  }
  const details = error.details;
  if (!Array.isArray(details)) {
    return false;
  }
  return details.some((detail) => {
    if (!detail || typeof detail !== "object") {
      return false;
    }
    return detail.reason === "SECURITY_POLICY_VIOLATED";
  });
}
function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// src/plugin/project/api.ts
async function loadManagedProject(accessToken, projectId, userAgentModel) {
  try {
    const metadata = buildMetadata(projectId);
    const requestBody = { metadata };
    if (projectId) {
      requestBody.cloudaicompanionProject = projectId;
    }
    const url = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
    const headers = buildCodeAssistHeaders(accessToken, userAgentModel);
    const debugContext = startGeminiDebugRequest({
      originalUrl: url,
      resolvedUrl: url,
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      streaming: false,
      projectId
    });
    const response = await geminiFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    });
    const responseBody = await readResponseTextIfNeeded(response, !!debugContext);
    if (debugContext) {
      logGeminiDebugResponse(debugContext, response, { body: responseBody });
    }
    if (!response.ok) {
      if (responseBody && isVpcScError(parseJsonSafe(responseBody))) {
        return { currentTier: { id: "standard-tier" } };
      }
      return null;
    }
    if (responseBody) {
      return parseJsonSafe(responseBody);
    }
    return await response.json();
  } catch (error) {
    console.error("Failed to load Gemini managed project:", error);
    return null;
  }
}
async function onboardManagedProject(accessToken, tierId, projectId, userAgentModel, attempts = 10, delayMs = 5e3) {
  const isFreeTier = tierId === FREE_TIER_ID;
  const metadata = buildMetadata(projectId, !isFreeTier);
  const requestBody = { tierId, metadata };
  if (!isFreeTier) {
    if (!projectId) {
      throw new ProjectIdRequiredError();
    }
    requestBody.cloudaicompanionProject = projectId;
  }
  const baseUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal`;
  const onboardUrl = `${baseUrl}:onboardUser`;
  try {
    const response = await fetchWithDebug(
      onboardUrl,
      "POST",
      buildCodeAssistHeaders(accessToken, userAgentModel),
      requestBody,
      projectId
    );
    if (!response.ok) {
      return void 0;
    }
    let payload = await response.json();
    if (!payload.done && payload.name) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(delayMs);
        const operationUrl = `${baseUrl}/${payload.name}`;
        const opResponse = await fetchWithDebug(
          operationUrl,
          "GET",
          buildCodeAssistHeaders(accessToken, userAgentModel),
          void 0,
          projectId
        );
        if (!opResponse.ok) {
          return void 0;
        }
        payload = await opResponse.json();
        if (payload.done) {
          break;
        }
      }
    }
    const managedProjectId = payload.response?.cloudaicompanionProject?.id;
    if (payload.done && managedProjectId) {
      return managedProjectId;
    }
    if (payload.done && projectId) {
      return projectId;
    }
  } catch (error) {
    console.error("Failed to onboard Gemini managed project:", error);
    return void 0;
  }
  return void 0;
}
function buildCodeAssistHeaders(accessToken, userAgentModel) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": buildGeminiCliUserAgent(userAgentModel),
    "x-activity-request-id": createGeminiActivityRequestId()
  };
}
async function fetchWithDebug(url, method, headers, body, projectId) {
  const debugContext = startGeminiDebugRequest({
    originalUrl: url,
    resolvedUrl: url,
    method,
    headers,
    body: body ? JSON.stringify(body) : void 0,
    streaming: false,
    projectId
  });
  const response = await geminiFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : void 0
  });
  if (debugContext) {
    const responseBody = await readResponseTextIfNeeded(response, true);
    logGeminiDebugResponse(debugContext, response, { body: responseBody });
  }
  return response;
}
async function readResponseTextIfNeeded(response, needed) {
  if (!needed && response.ok) {
    return void 0;
  }
  try {
    return await response.clone().text();
  } catch {
    return void 0;
  }
}

// src/plugin/auth.ts
var ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1e3;
function parseRefreshParts(refresh) {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || void 0,
    managedProjectId: managedProjectId || void 0
  };
}
function formatRefreshParts(parts) {
  if (!parts.refreshToken) {
    return "";
  }
  if (!parts.projectId && !parts.managedProjectId) {
    return parts.refreshToken;
  }
  const projectSegment = parts.projectId ?? "";
  const managedSegment = parts.managedProjectId ?? "";
  return `${parts.refreshToken}|${projectSegment}|${managedSegment}`;
}

// src/plugin/project/context.ts
var projectContextResultCache = /* @__PURE__ */ new Map();
var projectContextPendingCache = /* @__PURE__ */ new Map();
function invalidateProjectContextCache(refresh) {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
  const prefix = `${refresh}|cfg:`;
  for (const key of projectContextPendingCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextPendingCache.delete(key);
    }
  }
  for (const key of projectContextResultCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextResultCache.delete(key);
    }
  }
}
async function resolveProjectContextFromAccessToken(auth, accessToken, configuredProjectId, persistAuth, userAgentModel) {
  const parts = parseRefreshParts(auth.refresh);
  const configuredProject = configuredProjectId?.trim();
  const projectId = configuredProject || parts.projectId;
  if (!configuredProject && (projectId || parts.managedProjectId)) {
    return {
      auth,
      effectiveProjectId: projectId || parts.managedProjectId || ""
    };
  }
  const loadPayload = await loadManagedProject(accessToken, projectId, userAgentModel);
  if (!loadPayload) {
    throw new ProjectIdRequiredError();
  }
  const managedProjectId = normalizeProjectId(loadPayload.cloudaicompanionProject);
  if (managedProjectId) {
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, managedProjectId);
    if (persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId: managedProjectId };
  }
  const currentTierId = loadPayload.currentTier?.id;
  if (!currentTierId) {
    throwIfValidationRequired(loadPayload.ineligibleTiers);
  }
  if (currentTierId) {
    if (projectId) {
      return { auth, effectiveProjectId: projectId };
    }
    const ineligibleMessage = buildIneligibleTierMessage(loadPayload.ineligibleTiers);
    if (ineligibleMessage) {
      throw new Error(ineligibleMessage);
    }
    throw new ProjectIdRequiredError();
  }
  const tier = pickOnboardTier(loadPayload.allowedTiers);
  const tierId = tier.id ?? LEGACY_TIER_ID;
  if (tierId !== FREE_TIER_ID && !projectId) {
    throw new ProjectIdRequiredError();
  }
  const onboardedProjectId = await onboardManagedProject(
    accessToken,
    tierId,
    projectId,
    userAgentModel
  );
  if (onboardedProjectId) {
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, onboardedProjectId);
    if (persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId: onboardedProjectId };
  }
  if (projectId) {
    return { auth, effectiveProjectId: projectId };
  }
  throw new ProjectIdRequiredError();
}
function withProjectAuth(auth, refreshToken, projectId, managedProjectId) {
  return {
    ...auth,
    refresh: formatRefreshParts({
      refreshToken,
      projectId,
      managedProjectId
    })
  };
}

// src/plugin/provider.ts
function resolveConfiguredProjectId(input = {}) {
  const env2 = input.env ?? process.env;
  return normalizeProjectId2(env2.OPENCODE_GEMINI_PROJECT_ID) ?? resolveConfiguredProjectIdFromProvider(input.provider) ?? normalizeProjectId2(input.configProjectId) ?? resolveConfiguredProjectIdFromConfig(input.config) ?? normalizeProjectId2(env2.GOOGLE_CLOUD_PROJECT) ?? normalizeProjectId2(env2.GOOGLE_CLOUD_PROJECT_ID);
}
function resolveConfiguredProjectIdFromProvider(provider) {
  if (!provider || typeof provider !== "object") {
    return void 0;
  }
  return normalizeProjectId2(provider.options?.projectId);
}
function resolveConfiguredProjectIdFromConfig(config) {
  if (!config?.provider || typeof config.provider !== "object") {
    return void 0;
  }
  const providerConfig = config.provider[GEMINI_PROVIDER_ID];
  return normalizeProjectId2(providerConfig?.options?.projectId);
}
function normalizeProjectId2(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed || void 0;
}

// src/plugin/server.ts
import { createServer } from "http";
var redirectUri = new URL(GEMINI_REDIRECT_URI);
var callbackPath = redirectUri.pathname || "/";
async function startOAuthListener({ timeoutMs = 5 * 60 * 1e3 } = {}) {
  const port = redirectUri.port ? Number.parseInt(redirectUri.port, 10) : redirectUri.protocol === "https:" ? 443 : 80;
  const origin = `${redirectUri.protocol}//${redirectUri.host}`;
  const callbackQueue = [];
  const callbackWaiters = [];
  let terminalError;
  const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Opencode Gemini OAuth</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "Roboto", "Google Sans", arial, sans-serif;
        background: #f1f3f4;
        color: #202124;
      }
      main {
        width: min(448px, calc(100% - 3rem));
        background: #ffffff;
        border-radius: 28px;
        padding: 2.5rem 2.75rem;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.3), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
      }
      .logo {
        width: 40px;
        height: 40px;
        display: inline-flex;
      }
      .logo svg {
        width: 100%;
        height: 100%;
      }
      .brand {
        font-size: 1.1rem;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 1.75rem;
        font-size: 1.05rem;
        line-height: 1.6;
        color: #3c4043;
      }
      .note {
        margin: 1.5rem 0 0;
        font-size: 0.92rem;
        color: #5f6368;
      }
      .action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.65rem 1.85rem;
        border-radius: 999px;
        background: #1a73e8;
        color: #ffffff;
        font-weight: 500;
        font-size: 0.95rem;
        letter-spacing: 0.02em;
        text-decoration: none;
        transition: box-shadow 0.2s ease, transform 0.2s ease;
      }
      .action:hover {
        transform: translateY(-1px);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(60, 64, 67, 0.15);
      }
      .action:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.3);
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #131314;
          color: #e8eaed;
        }
        main {
          background: #202124;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4);
        }
        p {
          color: #e8eaed;
        }
        .note {
          color: #bdc1c6;
        }
        .action {
          background: #8ab4f8;
          color: #202124;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 46 46" xmlns="http://www.w3.org/2000/svg" role="img">
            <title>Gemini linked to Opencode</title>
            <path fill="#4285F4" d="M43.6 23.5c0-1.5-.1-3-.4-4.4H23v8.3h11.6c-.5 2.8-2 5.1-4.2 6.7v5.5h6.8c4-3.7 6.4-9.1 6.4-16.1z"/>
            <path fill="#34A853" d="M23 45c5.8 0 10.6-1.9 14.1-5.2l-6.8-5.5c-1.9 1.3-4.3 2-7.3 2-5.6 0-10.4-3.7-12.1-8.7H3.8v5.6C7.3 39.9 14.6 45 23 45z"/>
            <path fill="#FBBC04" d="M10.9 28.6c-.5-1.3-.8-2.7-.8-4.1 0-1.5.3-2.8.8-4.1v-5.6H3.8C2.3 17.7 1.5 20.2 1.5 24s.8 6.3 2.3 9.2l6.9-5.6z"/>
            <path fill="#EA4335" d="M23 9.5c3.2 0 6 .9 8.3 2.7l6.2-6.2C33.6 2.2 28.8 0 23 0 14.6 0 7.3 5.1 3.8 12.4l7.1 5.6c1.7-5 6.5-8.5 12.1-8.5z"/>
          </svg>
        </span>
        <span class="brand">Gemini linked to Opencode</span>
      </header>
      <h1>You're connected to Opencode</h1>
      <p>Your Google account is now linked to Opencode. You can close this window and continue in the CLI.</p>
      <a class="action" href="javascript:window.close()">Close window</a>
      <p class="note">Need to reconnect later? Re-run the authentication command in Opencode.</p>
    </main>
  </body>
</html>`;
  const deliverCallback = (url) => {
    const waiter = callbackWaiters.shift();
    if (waiter) {
      waiter.resolve(url);
      return;
    }
    callbackQueue.push(url);
  };
  const failPendingWaiters = (error) => {
    if (terminalError) {
      return;
    }
    terminalError = error;
    while (callbackWaiters.length > 0) {
      callbackWaiters.shift()?.reject(error);
    }
  };
  const timeoutHandle = setTimeout(() => {
    failPendingWaiters(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();
  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request");
      return;
    }
    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    const hasCode = !!url.searchParams.get("code");
    const hasState = !!url.searchParams.get("state");
    const hasError = !!url.searchParams.get("error");
    if (!hasError && (!hasCode || !hasState)) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Ignoring incomplete OAuth callback. Return to the Google sign-in flow.");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(successResponse);
    deliverCallback(url);
  });
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("error", handleError);
      reject(error);
    };
    server.once("error", handleError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });
  server.on("error", (error) => {
    failPendingWaiters(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    waitForCallback: async () => {
      if (callbackQueue.length > 0) {
        return callbackQueue.shift();
      }
      if (terminalError) {
        throw terminalError;
      }
      return await new Promise((resolve, reject) => {
        callbackWaiters.push({ resolve, reject });
      });
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        failPendingWaiters(new Error("OAuth listener closed before callback"));
        resolve();
      });
    })
  };
}

// src/plugin/oauth-authorize.ts
function createOAuthAuthorizeMethod(options) {
  return async () => {
    const maybeHydrateProjectId = async (result) => {
      if (result.type !== "success" || !result.access) {
        return result;
      }
      const configuredProjectId = resolveConfiguredProjectId({
        configProjectId: await options?.getConfiguredProjectId?.()
      });
      try {
        const authSnapshot = {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires
        };
        const projectContext = await resolveProjectContextFromAccessToken(
          authSnapshot,
          result.access,
          configuredProjectId,
          void 0,
          await options?.getUserAgentModel?.()
        );
        if (projectContext.auth.refresh !== result.refresh && isGeminiDebugEnabled()) {
          logGeminiDebugMessage(
            `OAuth project resolved during auth: ${projectContext.effectiveProjectId || "none"}`
          );
        }
        return projectContext.auth.refresh !== result.refresh ? { ...result, refresh: projectContext.auth.refresh } : result;
      } catch (error) {
        if (isGeminiDebugEnabled()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Gemini OAuth] Project resolution skipped: ${message}`);
        }
        return result;
      }
    };
    const isHeadless = !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.OPENCODE_HEADLESS);
    let listener = null;
    if (!isHeadless) {
      try {
        listener = await startOAuthListener();
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        console.log(
          `Warning: Couldn't start the local callback listener${detail}. You'll need to paste the callback URL or authorization code.`
        );
      }
    } else {
      console.log(
        "Headless environment detected. You'll need to paste the callback URL or authorization code."
      );
    }
    const authorization = await authorizeGemini();
    if (!isHeadless) {
      openBrowserUrl(authorization.url);
    }
    if (listener) {
      return {
        url: authorization.url,
        instructions: "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
        method: "auto",
        callback: async () => {
          try {
            while (true) {
              const callbackUrl = await listener.waitForCallback();
              const callbackError = callbackUrl.searchParams.get("error");
              const callbackErrorDescription = callbackUrl.searchParams.get("error_description");
              if (callbackError) {
                return {
                  type: "failed",
                  error: callbackErrorDescription || callbackError
                };
              }
              const code = callbackUrl.searchParams.get("code");
              const state = callbackUrl.searchParams.get("state");
              if (!code || !state) {
                continue;
              }
              if (state !== authorization.state) {
                if (isGeminiDebugEnabled()) {
                  logGeminiDebugMessage("Ignoring OAuth callback with mismatched state");
                }
                continue;
              }
              const exchangeResult = await exchangeGeminiWithVerifier(code, authorization.verifier);
              if (shouldIgnoreMalformedAuthCode(exchangeResult)) {
                if (isGeminiDebugEnabled()) {
                  logGeminiDebugMessage("Ignoring malformed OAuth callback code and waiting for the next redirect");
                }
                continue;
              }
              return await maybeHydrateProjectId(exchangeResult);
            }
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error.message : "Unknown error"
            };
          } finally {
            try {
              await listener?.close();
            } catch {
            }
          }
        }
      };
    }
    return {
      url: authorization.url,
      instructions: "Complete OAuth in your browser, then paste the full redirected URL (e.g., http://localhost:8085/oauth2callback?code=...&state=...) or just the authorization code.",
      method: "code",
      callback: async (callbackUrl) => {
        try {
          const { code, state } = parseOAuthCallbackInput(callbackUrl);
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          if (state && state !== authorization.state) {
            return { type: "failed", error: "State mismatch in callback input (possible CSRF attempt)" };
          }
          return await maybeHydrateProjectId(
            await exchangeGeminiWithVerifier(code, authorization.verifier)
          );
        } catch (error) {
          return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error"
          };
        }
      }
    };
  };
}
function parseOAuthCallbackInput(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") || void 0,
        state: url.searchParams.get("state") || void 0
      };
    } catch {
      return {};
    }
  }
  const candidate = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    const code = params.get("code") || void 0;
    const state = params.get("state") || void 0;
    if (code || state) {
      return { code, state };
    }
  }
  return { code: trimmed };
}
function openBrowserUrl(url) {
  try {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true
    });
    child.unref?.();
  } catch {
  }
}
function shouldIgnoreMalformedAuthCode(result) {
  if (result.type !== "failed") {
    return false;
  }
  return /invalid_grant/i.test(result.error) && /malformed auth code/i.test(result.error);
}

// src/plugin/request/prepare.ts
import { randomUUID as randomUUID3 } from "crypto";

// src/plugin/request-helpers/types.ts
var GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";
var CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com"
];

// src/plugin/request-helpers/thinking.ts
function normalizeThinkingConfig(config) {
  if (!config || typeof config !== "object") {
    return void 0;
  }
  const record = config;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;
  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : void 0;
  const thinkingLevel = typeof levelRaw === "string" && levelRaw.trim().length > 0 ? levelRaw.trim().toLowerCase() : void 0;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : void 0;
  if (thinkingBudget === void 0 && thinkingLevel === void 0 && includeThoughts === void 0) {
    return void 0;
  }
  const thinkingEnabled = thinkingBudget !== void 0 && thinkingBudget > 0 || thinkingLevel !== void 0;
  const finalIncludeThoughts = thinkingEnabled ? includeThoughts ?? false : false;
  const normalized = {};
  if (thinkingBudget !== void 0) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== void 0) {
    normalized.thinkingLevel = thinkingLevel;
  }
  normalized.includeThoughts = finalIncludeThoughts;
  return normalized;
}

// src/plugin/request-helpers/parsing.ts
function parseGeminiApiBody(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item) => typeof item === "object" && item !== null);
      return firstObject && typeof firstObject === "object" ? firstObject : null;
    }
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function extractUsageMetadata(body) {
  const usage = body.response && typeof body.response === "object" ? body.response.usageMetadata : void 0;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const asRecord = usage;
  const toNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount)
  };
}

// src/plugin/request-helpers/errors.ts
function rewriteGeminiPreviewAccessError(body, status, requestedModel) {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }
  const error = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0 ? trimmedMessage : "Gemini 3 preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${GEMINI_PREVIEW_LINK} before using Gemini 3 models.`;
  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage
    }
  };
}
function enhanceGeminiErrorResponse(body, status) {
  const error = body.error;
  if (!error) {
    return null;
  }
  const details = Array.isArray(error.details) ? error.details : [];
  const retryAfterMs = extractRetryDelay(details, error.message) ?? void 0;
  if (status === 403) {
    const validationInfo = extractValidationInfo(details);
    if (validationInfo) {
      const message = [
        error.message ?? "Account validation required for Gemini Code Assist.",
        validationInfo.link ? `Complete validation: ${validationInfo.link}` : void 0,
        validationInfo.learnMore ? `Learn more: ${validationInfo.learnMore}` : void 0
      ].filter(Boolean).join(" ");
      return {
        body: {
          ...body,
          error: {
            ...error,
            message
          }
        },
        retryAfterMs
      };
    }
  }
  if (status === 429) {
    const quotaInfo = extractQuotaInfo(details);
    if (quotaInfo) {
      const message = quotaInfo.retryable ? `Rate limit exceeded. ${retryAfterMs ? "Please retry shortly." : "Please retry."}` : "Quota exhausted for this account. Please wait for your quota to reset or upgrade your plan.";
      return {
        body: {
          ...body,
          error: {
            ...error,
            message
          }
        },
        retryAfterMs
      };
    }
  }
  return retryAfterMs !== void 0 ? { retryAfterMs } : null;
}
function needsPreviewAccessOverride(status, body, requestedModel) {
  if (status !== 404) {
    return false;
  }
  if (isGeminiThreeModel(requestedModel)) {
    return true;
  }
  return isGeminiThreeModel(typeof body.error?.message === "string" ? body.error.message : "");
}
function isGeminiThreeModel(target) {
  return !!target && /gemini[\s-]?3/i.test(target);
}
function extractValidationInfo(details) {
  const errorInfo = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
  );
  if (!errorInfo || errorInfo.reason !== "VALIDATION_REQUIRED" || !errorInfo.domain || !CLOUDCODE_DOMAINS.includes(errorInfo.domain)) {
    return null;
  }
  const helpDetail = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.Help"
  );
  let link;
  let learnMore;
  if (helpDetail?.links && helpDetail.links.length > 0) {
    link = helpDetail.links[0]?.url;
    const learnMoreLink = helpDetail.links.find((candidate) => {
      if (!candidate?.url) {
        return false;
      }
      if (candidate.description?.toLowerCase().trim() === "learn more") {
        return true;
      }
      try {
        return new URL(candidate.url).hostname === "support.google.com";
      } catch {
        return false;
      }
    });
    learnMore = learnMoreLink?.url;
  }
  if (!link && errorInfo.metadata?.validation_link) {
    link = errorInfo.metadata.validation_link;
  }
  return link || learnMore ? { link, learnMore } : null;
}
function extractQuotaInfo(details) {
  const errorInfo = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
  );
  if (errorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return { retryable: true };
  }
  if (errorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { retryable: false };
  }
  const quotaFailure = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
  );
  if (!quotaFailure?.violations?.length) {
    return null;
  }
  const description = quotaFailure.violations.map((violation) => violation.description?.toLowerCase() ?? "").join(" ");
  if (description.includes("daily") || description.includes("per day")) {
    return { retryable: false };
  }
  return { retryable: true };
}
function extractRetryDelay(details, errorMessage) {
  const retryInfo = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }
  if (!errorMessage) {
    return null;
  }
  const retryMatch = errorMessage.match(/Please retry in ([0-9.]+(?:ms|s))/);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }
  const resetMatch = errorMessage.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (resetMatch?.[1]) {
    return parseRetryDelayValue(resetMatch[1]);
  }
  return null;
}
function parseRetryDelayValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const ms = Number(trimmed.slice(0, -2));
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (match?.[1]) {
      const seconds2 = Number(match[1]);
      return Number.isFinite(seconds2) && seconds2 > 0 ? Math.round(seconds2 * 1e3) : null;
    }
    return null;
  }
  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1e3 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}

// src/plugin/request/identifiers.ts
import { randomUUID } from "crypto";

// src/plugin/request/shared.ts
var REQUEST_MODEL_FALLBACKS = {
  "gemini-2.5-flash-image": "gemini-2.5-flash"
};
function toRequestUrlString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const candidate = value.url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}
function isGenerativeLanguageRequest(input) {
  return toRequestUrlString(input).includes("generativelanguage.googleapis.com");
}
function parseGenerativeLanguageRequest(input) {
  const match = toRequestUrlString(input).match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return void 0;
  }
  const [, requestedModel = "", action = ""] = match;
  return {
    requestedModel,
    effectiveModel: REQUEST_MODEL_FALLBACKS[requestedModel] ?? requestedModel,
    action
  };
}
function isRecord(value) {
  return !!value && typeof value === "object";
}
function readString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function pickString(...values) {
  for (const value of values) {
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return void 0;
}
function injectResponseIdFromTrace(body) {
  const traceId = readString(body.traceId);
  if (!traceId) {
    return body;
  }
  const response = body.response;
  if (!isRecord(response)) {
    return body;
  }
  if (readString(response.responseId)) {
    return body;
  }
  return {
    ...body,
    response: {
      ...response,
      responseId: traceId
    }
  };
}

// src/plugin/request/identifiers.ts
var PROCESS_SESSION_ID = randomUUID();
function resolveUserPromptId(payload, request) {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : void 0;
  return pickString(
    payload.user_prompt_id,
    payload.userPromptId,
    payload.prompt_id,
    payload.promptId,
    payload.request_id,
    payload.requestId,
    request?.user_prompt_id,
    request?.userPromptId,
    request?.prompt_id,
    request?.promptId,
    request?.request_id,
    request?.requestId,
    extra?.user_prompt_id,
    extra?.userPromptId,
    extra?.prompt_id,
    extra?.promptId,
    extra?.request_id,
    extra?.requestId
  ) ?? randomUUID();
}
function resolveSessionId(payload, request) {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : void 0;
  return pickString(
    request?.session_id,
    request?.sessionId,
    payload.session_id,
    payload.sessionId,
    extra?.session_id,
    extra?.sessionId
  ) ?? PROCESS_SESSION_ID;
}
function stripPromptIdentifierAliases(payload) {
  delete payload.user_prompt_id;
  delete payload.userPromptId;
  delete payload.prompt_id;
  delete payload.promptId;
  delete payload.request_id;
  delete payload.requestId;
}
function stripSessionIdentifierAliases(payload) {
  delete payload.sessionId;
}
function normalizeWrappedIdentifiers(wrapped) {
  const request = isRecord(wrapped.request) ? { ...wrapped.request } : {};
  const userPromptId = resolveUserPromptId(wrapped, request);
  const sessionId = resolveSessionId(wrapped, request);
  request.session_id = sessionId;
  stripSessionIdentifierAliases(request);
  wrapped.request = request;
  wrapped.user_prompt_id = userPromptId;
  stripPromptIdentifierAliases(wrapped);
  return { userPromptId, sessionId };
}
function normalizeRequestPayloadIdentifiers(payload) {
  const userPromptId = resolveUserPromptId(payload);
  const sessionId = resolveSessionId(payload);
  payload.session_id = sessionId;
  stripSessionIdentifierAliases(payload);
  stripPromptIdentifierAliases(payload);
  return { userPromptId, sessionId };
}

// src/plugin/request/openai.ts
import { randomUUID as randomUUID2 } from "crypto";
function makeFunctionCallId(name) {
  return `${name}__${randomUUID2()}`;
}
function transformOpenAIToolCalls(requestPayload) {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const msgObj = message;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }
    const parts = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }
      const fn = toolCall.function;
      if (!fn || typeof fn !== "object") {
        continue;
      }
      const name = fn.name;
      const args = parseJsonObject(fn.arguments);
      const resolvedName = name ?? "";
      parts.push({
        functionCall: {
          name: resolvedName,
          args,
          id: makeFunctionCallId(resolvedName)
        },
        thoughtSignature: "skip_thought_signature_validator"
      });
    }
    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}
function addThoughtSignaturesToFunctionCalls(requestPayload) {
  const processContents = (contents) => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }
    for (const content of contents) {
      if (!content || typeof content !== "object") {
        continue;
      }
      const parts = content.parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }
      for (const part of parts) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part;
        if (partObj.functionCall) {
          if (!partObj.thoughtSignature) {
            partObj.thoughtSignature = "skip_thought_signature_validator";
          }
          const fc = partObj.functionCall;
          if (!fc.id) {
            fc.id = makeFunctionCallId(fc.name || "");
          }
        }
      }
    }
  };
  processContents(requestPayload.contents);
  if (requestPayload.request && typeof requestPayload.request === "object") {
    processContents(requestPayload.request.contents);
  }
}
function parseJsonObject(value) {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

// src/plugin/request/prepare.ts
var STREAM_ACTION = "streamGenerateContent";
function prepareGeminiRequest(input, init, accessToken, projectId, thinkingConfigDefaults) {
  const baseInit = { ...init };
  const headers = new Headers(init?.headers ?? {});
  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false
    };
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  const requestTarget = parseGenerativeLanguageRequest(input);
  if (!requestTarget) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false
    };
  }
  const { requestedModel: rawModel, effectiveModel, action: rawAction } = requestTarget;
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;
  let body = baseInit.body;
  let activityRequestId = createGeminiActivityRequestId();
  if (typeof baseInit.body === "string" && baseInit.body) {
    const transformed = transformRequestBody(
      baseInit.body,
      projectId,
      effectiveModel,
      rawModel,
      thinkingConfigDefaults
    );
    if (transformed.body) {
      body = transformed.body;
    }
  }
  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }
  headers.set("User-Agent", buildGeminiCliUserAgent(effectiveModel));
  headers.set("x-activity-request-id", activityRequestId);
  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body
    },
    streaming,
    requestedModel: rawModel
  };
}
function transformRequestBody(body, projectId, effectiveModel, requestedModel, thinkingConfigDefaults) {
  const fallbackId = randomUUID3();
  try {
    const parsedBody = JSON.parse(body);
    const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;
    if (isWrapped) {
      const wrappedBody2 = {
        ...parsedBody,
        model: effectiveModel
      };
      const { userPromptId: userPromptId2 } = normalizeWrappedIdentifiers(wrappedBody2);
      return { body: JSON.stringify(wrappedBody2), userPromptId: userPromptId2 };
    }
    const requestPayload = { ...parsedBody };
    transformOpenAIToolCalls(requestPayload);
    addThoughtSignaturesToFunctionCalls(requestPayload);
    normalizeThinking(
      requestPayload,
      resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel),
      thinkingConfigDefaults?.provider
    );
    normalizeSystemInstruction(requestPayload);
    normalizeCachedContent(requestPayload);
    stripThoughtPartsFromHistory(requestPayload);
    if ("model" in requestPayload) {
      delete requestPayload.model;
    }
    const { userPromptId } = normalizeRequestPayloadIdentifiers(requestPayload);
    const wrappedBody = {
      project: projectId,
      model: effectiveModel,
      user_prompt_id: userPromptId,
      request: requestPayload
    };
    return { body: JSON.stringify(wrappedBody), userPromptId };
  } catch (error) {
    console.error("Failed to transform Gemini request body:", error);
    return { userPromptId: fallbackId };
  }
}
function resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel) {
  if (!thinkingConfigDefaults?.models) {
    return void 0;
  }
  return thinkingConfigDefaults.models[requestedModel] ?? thinkingConfigDefaults.models[effectiveModel];
}
function normalizeThinking(requestPayload, modelThinkingConfig, providerThinkingConfig) {
  const rawGenerationConfig = requestPayload.generationConfig;
  const hasRootThinkingConfig = Object.prototype.hasOwnProperty.call(requestPayload, "thinkingConfig");
  const hasRequestThinkingConfig = hasRootThinkingConfig || !!rawGenerationConfig && Object.prototype.hasOwnProperty.call(rawGenerationConfig, "thinkingConfig");
  const sourceThinkingConfig = hasRootThinkingConfig ? requestPayload.thinkingConfig : hasRequestThinkingConfig ? rawGenerationConfig?.thinkingConfig : modelThinkingConfig ?? providerThinkingConfig;
  const normalizedThinking = normalizeThinkingConfig(sourceThinkingConfig);
  if (hasRootThinkingConfig) {
    delete requestPayload.thinkingConfig;
  }
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    } else {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
    return;
  }
  if (hasRequestThinkingConfig && rawGenerationConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }
}
function normalizeSystemInstruction(requestPayload) {
  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }
}
function normalizeCachedContent(requestPayload) {
  const extraBody = requestPayload.extra_body && typeof requestPayload.extra_body === "object" ? requestPayload.extra_body : void 0;
  const cachedContentFromExtra = extraBody?.cached_content ?? extraBody?.cachedContent;
  const cachedContent = requestPayload.cached_content ?? requestPayload.cachedContent ?? cachedContentFromExtra;
  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }
  delete requestPayload.cached_content;
  if (!extraBody) {
    return;
  }
  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete requestPayload.extra_body;
  }
}
function stripThoughtPartsFromHistory(requestPayload) {
  const contents = requestPayload.contents;
  if (!Array.isArray(contents)) {
    return;
  }
  const sanitizedContents = [];
  for (const content of contents) {
    if (!content || typeof content !== "object") {
      sanitizedContents.push(content);
      continue;
    }
    const record = content;
    const parts = Array.isArray(record.parts) ? record.parts : void 0;
    if (!parts) {
      sanitizedContents.push(content);
      continue;
    }
    const filteredParts = parts.filter((part) => {
      if (!part || typeof part !== "object") {
        return true;
      }
      return part.thought !== true;
    });
    if (filteredParts.length === 0 && record.role === "model") {
      continue;
    }
    sanitizedContents.push({
      ...record,
      parts: filteredParts
    });
  }
  requestPayload.contents = sanitizedContents;
}

// src/plugin/request/response.ts
async function transformGeminiResponse(response, streaming, debugContext, requestedModel) {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");
  if (!isJsonResponse && !isEventStreamResponse) {
    logGeminiDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)"
    });
    return response;
  }
  try {
    const headers = new Headers(response.headers);
    if (streaming && response.ok && isEventStreamResponse && response.body) {
      logGeminiDebugResponse(debugContext, response, {
        note: "Streaming SSE payload (body omitted)",
        headersOverride: headers
      });
      return new Response(transformStreamingPayloadStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    const text = await response.text();
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers
    };
    const parsed = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null;
    const enhanced = !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null;
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1e3).toString();
      headers.set("Retry-After", retryAfterSec);
      headers.set("retry-after-ms", String(enhanced.retryAfterMs));
    }
    const previewPatched = parsed ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel) : null;
    const effectiveBodyRaw = previewPatched ?? enhanced?.body ?? parsed ?? void 0;
    const effectiveBody = effectiveBodyRaw && typeof effectiveBodyRaw === "object" ? injectResponseIdFromTrace(effectiveBodyRaw) : effectiveBodyRaw;
    attachUsageHeaders(headers, effectiveBody);
    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered)" : void 0,
      headersOverride: headers
    });
    if (!parsed) {
      return new Response(text, init);
    }
    if (effectiveBody && typeof effectiveBody === "object" && "response" in effectiveBody) {
      return new Response(JSON.stringify(effectiveBody.response), init);
    }
    if (previewPatched) {
      return new Response(JSON.stringify(previewPatched), init);
    }
    return new Response(text, init);
  } catch (error) {
    logGeminiDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Gemini response"
    });
    console.error("Failed to transform Gemini response:", error);
    return response;
  }
}
function attachUsageHeaders(headers, effectiveBody) {
  if (!effectiveBody || typeof effectiveBody !== "object") {
    return;
  }
  const usage = extractUsageMetadata(effectiveBody);
  if (usage?.cachedContentTokenCount === void 0) {
    return;
  }
  headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
  if (usage.totalTokenCount !== void 0) {
    headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
  }
  if (usage.promptTokenCount !== void 0) {
    headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
  }
  if (usage.candidatesTokenCount !== void 0) {
    headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
  }
}
function transformStreamingPayloadStream(stream) {
  const decoder2 = new TextDecoder();
  const encoder2 = new TextEncoder();
  let buffer = "";
  let reader = null;
  return new ReadableStream({
    start(controller) {
      reader = stream.getReader();
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            buffer += decoder2.decode();
            if (buffer.length > 0) {
              controller.enqueue(encoder2.encode(transformStreamingLine(buffer)));
            }
            controller.close();
            return;
          }
          buffer += decoder2.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const hasCr = line.endsWith("\r");
            const rawLine = hasCr ? line.slice(0, -1) : line;
            const transformed = transformStreamingLine(rawLine);
            controller.enqueue(encoder2.encode(`${transformed}${hasCr ? "\r\n" : "\n"}`));
            newlineIndex = buffer.indexOf("\n");
          }
          pump();
        }).catch((error) => {
          controller.error(error);
        });
      };
      pump();
    },
    cancel(reason) {
      if (reader) {
        reader.cancel(reason).catch(() => {
        });
      }
    }
  });
}
function transformStreamingLine(line) {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }
  try {
    const parsed = JSON.parse(json);
    const patched = injectResponseIdFromTrace(parsed);
    if (patched.response !== void 0) {
      return `data: ${JSON.stringify(patched.response)}`;
    }
  } catch {
    return line;
  }
  return line;
}

// src/plugin/cache.ts
var authCache = /* @__PURE__ */ new Map();
function normalizeRefreshKey(refresh) {
  const key = refresh?.trim();
  return key ? key : void 0;
}
function storeCachedAuth(auth) {
  const key = normalizeRefreshKey(auth.refresh);
  if (!key) {
    return;
  }
  authCache.set(key, auth);
}
function clearCachedAuth(refresh) {
  if (!refresh) {
    authCache.clear();
    return;
  }
  const key = normalizeRefreshKey(refresh);
  if (key) {
    authCache.delete(key);
  }
}

// src/plugin/retry/quota.ts
async function parseRetryDelayFromBody(response) {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }
  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail) => isObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue2(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }
  if (typeof payload.message === "string") {
    return parseRetryDelayFromMessage(payload.message);
  }
  return null;
}
function parseRetryDelayValue2(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const milliseconds = Number(trimmed.slice(0, -2));
      return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (!match?.[1]) {
      return null;
    }
    const seconds2 = Number(match[1]);
    return Number.isFinite(seconds2) && seconds2 > 0 ? Math.round(seconds2 * 1e3) : null;
  }
  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1e3 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}
function parseRetryDelayFromMessage(message) {
  const retryMatch = message.match(/Please retry in ([0-9.]+(?:ms|s))/i);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue2(retryMatch[1]);
  }
  const afterMatch = message.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (afterMatch?.[1]) {
    return parseRetryDelayValue2(afterMatch[1]);
  }
  return null;
}
async function parseErrorBody(response) {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const normalized = normalizeErrorEnvelope(parsed);
  if (!normalized || !isObject(normalized.error)) {
    return null;
  }
  const error = normalized.error;
  return {
    message: typeof error.message === "string" ? error.message : void 0,
    details: Array.isArray(error.details) ? error.details : void 0
  };
}
function isObject(value) {
  return !!value && typeof value === "object";
}
function normalizeErrorEnvelope(parsed) {
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    return isObject(first) ? first : null;
  }
  return isObject(parsed) ? parsed : null;
}

// src/plugin/retry/helpers.ts
var DEFAULT_MAX_ATTEMPTS = 3;
var DEFAULT_INITIAL_DELAY_MS = 5e3;
var DEFAULT_MAX_DELAY_MS = 3e4;
var RETRYABLE_NETWORK_CODES = /* @__PURE__ */ new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_BAD_RECORD_MAC",
  "EPROTO"
]);
function isRetryableStatus(status) {
  return status === 429 || status >= 500 && status < 600;
}
function isRetryableNetworkError(error) {
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}
async function resolveRetryDelayMs(response, attempt, quotaDelayMs) {
  const retryAfterMsHeader = parseRetryAfterMs(response.headers.get("retry-after-ms"));
  if (retryAfterMsHeader !== null) {
    return clampDelay(retryAfterMsHeader);
  }
  const retryAfterHeader = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterHeader !== null) {
    return clampDelay(retryAfterHeader);
  }
  if (quotaDelayMs !== void 0) {
    return clampDelay(quotaDelayMs);
  }
  const bodyDelay = await parseRetryDelayFromBody(response);
  if (bodyDelay !== null) {
    return clampDelay(bodyDelay);
  }
  return getExponentialDelayWithJitter(attempt);
}
function getExponentialDelayWithJitter(attempt) {
  const base = Math.min(DEFAULT_MAX_DELAY_MS, DEFAULT_INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return clampDelay(base + jitter);
}
function wait2(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function getNetworkErrorCode(error) {
  const readCode = (value) => {
    if (!value || typeof value !== "object") {
      return void 0;
    }
    if ("code" in value && typeof value.code === "string") {
      return value.code;
    }
    return void 0;
  };
  const direct = readCode(error);
  if (direct) {
    return direct;
  }
  let cursor = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!cursor || typeof cursor !== "object" || !("cause" in cursor)) {
      break;
    }
    cursor = cursor.cause;
    const code = readCode(cursor);
    if (code) {
      return code;
    }
  }
  return void 0;
}
function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.round(parsed);
}
function parseRetryAfter(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1e3));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return null;
}
function clampDelay(delayMs) {
  if (!Number.isFinite(delayMs)) {
    return DEFAULT_MAX_DELAY_MS;
  }
  return Math.min(Math.max(0, Math.round(delayMs)), DEFAULT_MAX_DELAY_MS);
}

// src/plugin/token.ts
var refreshInFlight = /* @__PURE__ */ new Map();
function parseOAuthErrorPayload(text) {
  if (!text) {
    return {};
  }
  try {
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }
    let code;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }
    const description = payload.error_description;
    if (description) {
      return { code, description };
    }
    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }
    return { code };
  } catch {
    return { description: text };
  }
}
async function refreshAccessToken(auth, client) {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return void 0;
  }
  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) {
    return pending;
  }
  const refreshPromise = refreshAccessTokenInternal(auth, client, parts);
  refreshInFlight.set(parts.refreshToken, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(parts.refreshToken);
  }
}
async function refreshAccessTokenInternal(auth, client, parts) {
  try {
    const response = await fetchTokenRefresh(parts.refreshToken);
    if (!response.ok) {
      let errorText;
      try {
        errorText = await response.text();
      } catch {
        errorText = void 0;
      }
      if (isGeminiDebugEnabled()) {
        logGeminiDebugMessage(
          `OAuth refresh response: ${response.status} ${response.statusText}`
        );
        const preview = formatDebugBodyPreview(errorText);
        if (preview) {
          logGeminiDebugMessage(`OAuth refresh error body: ${preview}`);
        }
      }
      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Gemini token refresh failed (${response.status} ${response.statusText})`;
      console.warn(`[Gemini OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);
      if (code === "invalid_grant") {
        console.warn(
          "[Gemini OAuth] Google revoked the stored refresh token. Run `opencode auth login` and reauthenticate the Google provider."
        );
        clearCachedAuth(auth.refresh);
        invalidateProjectContextCache(auth.refresh);
        try {
          const clearedAuth = {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: "",
              projectId: parts.projectId,
              managedProjectId: parts.managedProjectId
            })
          };
          await client.auth.set({
            path: { id: GEMINI_PROVIDER_ID },
            body: clearedAuth
          });
        } catch (storeError) {
          console.error("Failed to clear stored Gemini OAuth credentials:", storeError);
        }
      }
      return void 0;
    }
    const payload = await response.json();
    if (isGeminiDebugEnabled()) {
      const rotated = payload.refresh_token && payload.refresh_token !== parts.refreshToken;
      logGeminiDebugMessage(
        `OAuth refresh success: expires_in=${payload.expires_in}s refresh_rotated=${rotated ? "yes" : "no"}`
      );
    }
    const refreshedParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId
    };
    const updatedAuth = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1e3,
      refresh: formatRefreshParts(refreshedParts)
    };
    clearCachedAuth(auth.refresh);
    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);
    if (refreshedParts.refreshToken !== parts.refreshToken) {
      try {
        await client.auth.set({
          path: { id: GEMINI_PROVIDER_ID },
          body: updatedAuth
        });
      } catch (storeError) {
        console.error("Failed to persist refreshed Gemini OAuth credentials:", storeError);
      }
    }
    return updatedAuth;
  } catch (error) {
    console.error("Failed to refresh Gemini access token due to an unexpected error:", error);
    return void 0;
  }
}
async function fetchTokenRefresh(refreshToken) {
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET
    })
  };
  let attempt = 1;
  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    if (isGeminiDebugEnabled()) {
      logGeminiDebugMessage(`OAuth refresh attempt ${attempt}: POST ${tokenUrl}`);
    }
    try {
      const response = await geminiFetch(tokenUrl, init);
      if (!isRetryableStatus(response.status) || attempt >= DEFAULT_MAX_ATTEMPTS) {
        return response;
      }
      const delayMs = await resolveRetryDelayMs(response, attempt);
      if (delayMs > 0) {
        await wait2(delayMs);
      }
      attempt += 1;
      continue;
    } catch (error) {
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw error;
      }
      await wait2(getExponentialDelayWithJitter(attempt));
      attempt += 1;
    }
  }
  return geminiFetch(tokenUrl, init);
}

// src/plugin-v2.ts
var GEMINI_OAUTH_METHOD_ID = Integration.MethodID.make("gemini-cli");
var noPersistClient = {
  auth: { set: async () => {
  } }
};
async function setupV2(ctx) {
  const requests = /* @__PURE__ */ new WeakMap();
  const getConfiguredProjectId = () => resolveV2ConfiguredProjectId(ctx);
  const authorize = createOAuthAuthorizeMethod({ getConfiguredProjectId });
  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: GEMINI_PROVIDER_ID,
      method: {
        id: GEMINI_OAUTH_METHOD_ID,
        type: "oauth",
        label: "OAuth with Google (Gemini CLI)"
      },
      authorize: async () => {
        const authorization = await authorize();
        return authorization.method === "auto" ? {
          url: authorization.url,
          instructions: authorization.instructions,
          mode: "auto",
          callback: authorization.callback().then(toV2Credential)
        } : {
          url: authorization.url,
          instructions: authorization.instructions,
          mode: "code",
          callback: (code) => authorization.callback(code).then(toV2Credential)
        };
      },
      refresh: async (credential) => {
        const refreshed = await refreshAccessToken(credential, noPersistClient);
        if (!refreshed?.access || refreshed.expires === void 0) {
          throw new Error("Gemini OAuth token refresh failed");
        }
        return { ...credential, ...refreshed };
      },
      label: (credential) => typeof credential.metadata?.email === "string" ? credential.metadata.email : void 0
    });
  });
  await ctx.session.hook("http.request", async (event) => {
    if (!isGenerativeLanguageRequest(event.request)) {
      return;
    }
    const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
    const credential = connection ? await ctx.integration.connection.resolve(connection) : void 0;
    if (!isV2Credential(credential) || credential.methodID !== GEMINI_OAUTH_METHOD_ID) {
      return;
    }
    const project = await resolveProjectContextFromAccessToken(
      credential,
      credential.access,
      await getConfiguredProjectId(),
      void 0,
      event.model.id
    );
    const original = event.request;
    const body = original.method === "GET" || original.method === "HEAD" ? void 0 : await original.clone().text();
    const transformed = prepareGeminiRequest(
      original,
      { method: original.method, headers: original.headers, body, signal: original.signal },
      credential.access,
      project.effectiveProjectId
    );
    const request = new Request(transformed.request, transformed.init);
    requests.set(request, {
      streaming: transformed.streaming,
      requestedModel: transformed.requestedModel
    });
    event.request = request;
  }, { providerID: GEMINI_PROVIDER_ID });
  await ctx.session.hook("http.response", async (event) => {
    const request = requests.get(event.request);
    if (!request) return;
    event.response = await transformGeminiResponse(
      event.response,
      request.streaming,
      null,
      request.requestedModel
    );
  }, { providerID: GEMINI_PROVIDER_ID });
}
async function resolveV2ConfiguredProjectId(ctx) {
  const override = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim();
  if (override) return override;
  const provider = await ctx.provider.get({ providerID: GEMINI_PROVIDER_ID });
  return resolveConfiguredProjectId({
    provider: { options: provider.data.settings }
  });
}
function toV2Credential(result) {
  if (result.type !== "success") throw new Error(result.error);
  return {
    type: "oauth",
    methodID: GEMINI_OAUTH_METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: result.email ? { email: result.email } : void 0
  };
}
function isV2Credential(value) {
  return !!value && typeof value === "object" && value.type === "oauth" && typeof value.methodID === "string";
}
var plugin_v2_default = Plugin.define({
  id: "opencode.provider.google-gemini-cli",
  setup: setupV2
});
export {
  plugin_v2_default as default
};
//# sourceMappingURL=server.js.map