import { MODEL_CACHE_FILE, MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "./shared.js";
import { unaryAvailableModels } from "./transport/connect.js";
import { buildRequestedModelParams } from "./protocol/thinking.js";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
/** Dedicated OpenCode provider-option key for a selected Cursor variant. */
export const CURSOR_VARIANT_PARAMETERS_KEY = "cursorVariantParameters";
/** Real Cursor model id used when an OpenCode entry has a synthetic id. */
export const CURSOR_WIRE_MODEL_ID_KEY = "cursorModelId";
export class CursorVariantSelectionError extends Error {
    constructor(message) {
        super(`Cursor variant selection ${message}`);
        this.name = "CursorVariantSelectionError";
    }
}
function isPlainRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function optionalString(record, names) {
    for (const name of names) {
        if (!Object.hasOwn(record, name))
            continue;
        if (record[name] === undefined)
            return undefined;
        return typeof record[name] === "string" ? record[name] : null;
    }
    return undefined;
}
function optionalBoolean(record, names) {
    for (const name of names) {
        if (!Object.hasOwn(record, name))
            continue;
        if (record[name] === undefined)
            return undefined;
        return typeof record[name] === "boolean" ? record[name] : null;
    }
    return undefined;
}
function optionalPositiveNumber(record, names) {
    for (const name of names) {
        if (!Object.hasOwn(record, name))
            continue;
        const value = record[name];
        if (value === undefined)
            return undefined;
        return typeof value === "number" && Number.isFinite(value) && value > 0
            ? value
            : null;
    }
    return undefined;
}
export function normalizeModelParameterValues(value) {
    if (!Array.isArray(value))
        return null;
    const parameters = [];
    for (const parameter of value) {
        if (!isPlainRecord(parameter))
            return null;
        if (!isNonEmptyString(parameter.id) || typeof parameter.value !== "string")
            return null;
        parameters.push({ id: parameter.id, value: parameter.value });
    }
    return parameters;
}
function normalizeVariant(value, fallbackName) {
    if (!isPlainRecord(value))
        return null;
    const parameters = normalizeModelParameterValues(value.parameterValues ?? value.parameter_values ?? []);
    if (!parameters)
        return null;
    const key = optionalString(value, ["key"]);
    const displayName = optionalString(value, ["displayName", "display_name"]);
    const isDefaultNonMax = optionalBoolean(value, ["isDefaultNonMax", "isDefaultNonMaxConfig", "is_default_non_max_config"]);
    const isDefaultMax = optionalBoolean(value, ["isDefaultMax", "isDefaultMaxConfig", "is_default_max_config"]);
    if (key === null ||
        displayName === null ||
        isDefaultNonMax === null ||
        isDefaultMax === null) {
        return null;
    }
    if ((key !== undefined && !isNonEmptyString(key)) ||
        (displayName !== undefined && !isNonEmptyString(displayName))) {
        return null;
    }
    return {
        key: key ?? fallbackName,
        displayName: displayName ?? fallbackName,
        parameterValues: parameters,
        isDefaultNonMax: isDefaultNonMax ?? false,
        isDefaultMax: isDefaultMax ?? false,
    };
}
function normalizeModelInfo(value) {
    if (!isPlainRecord(value) || !isNonEmptyString(value.id))
        return null;
    const rawVariants = value.variants ?? [];
    if (!Array.isArray(rawVariants))
        return null;
    const variants = rawVariants.map((variant) => normalizeVariant(variant, value.id));
    if (variants.some((variant) => variant === null))
        return null;
    const displayName = optionalString(value, ["displayName", "display_name"]);
    const family = optionalString(value, ["family"]);
    const supportsThinking = optionalBoolean(value, ["supportsThinking", "supports_thinking"]);
    const supportsAgent = optionalBoolean(value, ["supportsAgent", "supports_agent"]);
    const supportsImages = optionalBoolean(value, ["supportsImages", "supports_images"]);
    const supportsMaxMode = optionalBoolean(value, ["supportsMaxMode", "supports_max_mode"]);
    const maxContext = optionalPositiveNumber(value, ["maxContext", "contextTokenLimit", "context_token_limit"]);
    const maxContextForMaxMode = optionalPositiveNumber(value, ["maxContextForMaxMode", "contextTokenLimitForMaxMode", "context_token_limit_for_max_mode"]);
    if (displayName === null ||
        family === null ||
        supportsThinking === null ||
        supportsAgent === null ||
        supportsImages === null ||
        supportsMaxMode === null ||
        maxContext === null ||
        maxContextForMaxMode === null) {
        return null;
    }
    return {
        id: value.id,
        ...(displayName === undefined ? {} : { displayName }),
        ...(family === undefined ? {} : { family }),
        ...(supportsThinking === undefined ? {} : { supportsThinking }),
        ...(supportsAgent === undefined ? {} : { supportsAgent }),
        ...(supportsImages === undefined ? {} : { supportsImages }),
        ...(maxContext === undefined ? {} : { maxContext }),
        ...(maxContextForMaxMode === undefined ? {} : { maxContextForMaxMode }),
        ...(supportsMaxMode === undefined ? {} : { supportsMaxMode }),
        variants: variants,
    };
}
export function normalizeModelCache(value) {
    if (!isPlainRecord(value) || !Array.isArray(value.models))
        return null;
    if (typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt))
        return null;
    if (value.schemaVersion !== undefined &&
        (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 0)) {
        return null;
    }
    const models = value.models.map(normalizeModelInfo);
    if (models.some((model) => model === null))
        return null;
    return {
        models: models,
        fetchedAt: value.fetchedAt,
        ...(value.schemaVersion === undefined
            ? {}
            : { schemaVersion: value.schemaVersion }),
    };
}
/**
 * Read only the dedicated variant payload generated by the plugin. OpenCode
 * merges model, agent, and variant options into one providerOptions namespace;
 * treating that whole object as Cursor parameters would leak unrelated options
 * onto the wire.
 */
export function extractCursorVariantParameters(providerOptions) {
    if (!providerOptions || !Object.hasOwn(providerOptions, CURSOR_VARIANT_PARAMETERS_KEY)) {
        return undefined;
    }
    const params = normalizeModelParameterValues(providerOptions[CURSOR_VARIANT_PARAMETERS_KEY]);
    if (!params) {
        throw new CursorVariantSelectionError("is malformed: cursorVariantParameters must be a parameter array");
    }
    return params;
}
export function resolveCursorWireModelId(providerOptions, fallback) {
    const value = providerOptions?.[CURSOR_WIRE_MODEL_ID_KEY];
    return typeof value === "string" && value.trim() ? value : fallback;
}
/** True when resolved params select the long-context (1m) tier. */
export function paramsImplyMaxMode(params) {
    return params.some((parameter) => parameter.id === "context" &&
        parseCursorContextLimit(parameter.value) === 1_000_000);
}
/**
 * Resolve the request-level max_mode bit. An explicit variant pick owns the
 * context tier; otherwise a standalone maxMode hint may select max mode.
 */
export function resolveVariantMaxMode(params, opts = {}) {
    return paramsImplyMaxMode(params) || (opts.picked === undefined && opts.maxMode === true);
}
// Cursor encodes a model's context window as a variant parameter `id: "context"`
// whose value is a tier string — the same 200k / 272k / 300k / 1m the IDE's
// picker shows. The base tier rides on the default non-max variant; the 1M
// tier (when the model supports max mode) rides on the default max variant.
// `context_token_limit` (#15) / `context_token_limit_for_max_mode` (#16) are
// also defined on AvailableModel but the server often leaves them empty — the
// variant param is the primary source (request flags may still populate them).
export function parseCursorContextLimit(value) {
    if (typeof value !== "string")
        return undefined;
    const text = value.trim();
    const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(text);
    if (match) {
        const multiplier = match[2].toLowerCase() === "k" ? 1_000 : 1_000_000;
        const limit = Number(match[1]) * multiplier;
        return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
    }
    const numeric = Number(text);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined;
}
function variantContextTokens(v) {
    const raw = v?.parameterValues.find((p) => p.id === "context")?.value;
    return parseCursorContextLimit(raw);
}
function isLongContextVariant(v) {
    return variantContextTokens(v) === 1_000_000;
}
function positiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
}
// ── Cache helpers ──
export function isCacheFresh(cache, ttlMs = MODEL_CACHE_TTL_MS) {
    if (cache.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION)
        return false;
    return Date.now() - cache.fetchedAt < ttlMs;
}
export function cacheFilePath(cacheDir) {
    return path.join(cacheDir, MODEL_CACHE_FILE);
}
export async function readCache(cacheDir) {
    const filePath = cacheFilePath(cacheDir);
    try {
        const data = await readFile(filePath, "utf-8");
        return normalizeModelCache(JSON.parse(data));
    }
    catch {
        return null;
    }
}
export async function writeCache(cacheDir, cache) {
    const normalized = normalizeModelCache(cache);
    if (!normalized)
        throw new Error("Refusing to write an invalid Cursor model cache");
    const filePath = cacheFilePath(cacheDir);
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${MODEL_CACHE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
        await writeFile(tempPath, JSON.stringify(normalized, null, 2), "utf-8");
        await rename(tempPath, filePath);
    }
    finally {
        await unlink(tempPath).catch(() => { });
    }
}
// ── Map live API response to ModelInfo[] ──
function apiBoolean(record, names) {
    const value = optionalBoolean(record, names);
    if (value === null)
        throw new Error(`AvailableModels returned a non-boolean ${names[0]}`);
    return value ?? false;
}
export function mapAvailableModelsResponse(raw) {
    const entries = raw.models ?? [];
    const models = [];
    for (const entry of entries) {
        if (!isPlainRecord(entry))
            continue;
        const e = entry;
        const name = e.name;
        if (!isNonEmptyString(name))
            continue;
        const variants = [];
        const rawVariants = e.variants ?? [];
        if (!Array.isArray(rawVariants)) {
            throw new Error(`AvailableModels returned invalid variants for ${name}`);
        }
        for (const v of rawVariants) {
            if (!isPlainRecord(v)) {
                throw new Error(`AvailableModels returned an invalid variant for ${name}`);
            }
            const rawParams = (v.parameterValues ?? v.parameter_values ?? []);
            const parameterValues = normalizeModelParameterValues(rawParams);
            if (!parameterValues) {
                throw new Error(`AvailableModels returned invalid parameter values for ${name}`);
            }
            variants.push({
                key: name,
                parameterValues,
                displayName: (v.displayName ?? v.display_name ?? name),
                isDefaultNonMax: apiBoolean(v, ["isDefaultNonMaxConfig", "is_default_non_max_config"]),
                isDefaultMax: apiBoolean(v, ["isDefaultMaxConfig", "is_default_max_config"]),
            });
        }
        // Derive the context window from the variant `context` param (primary
        // source). Base tier ← default non-max variant; max tier ← default max
        // variant. Fall back to the (often empty) proto fields, then undefined.
        // Prefer a non-1m context when isDefaultNonMax is missing so a leading
        // max-mode variant cannot inflate the base window.
        const variantBaseContext = variantContextTokens(variants.find((v) => v.isDefaultNonMax)) ??
            variantContextTokens(variants.find((v) => variantContextTokens(v) !== 1_000_000)) ??
            variantContextTokens(variants.find((v) => v.parameterValues.some((p) => p.id === "context")));
        const variantMaxContext = variantContextTokens(variants.find((v) => v.isDefaultMax));
        const supportsImages = optionalBoolean(e, ["supportsImages", "supports_images"]);
        if (supportsImages === null) {
            throw new Error(`AvailableModels returned invalid supportsImages for ${name}`);
        }
        models.push({
            id: name,
            displayName: (e.clientDisplayName ?? e.client_display_name ?? name),
            supportsThinking: apiBoolean(e, ["supportsThinking", "supports_thinking"]),
            supportsAgent: apiBoolean(e, ["supportsAgent", "supports_agent"]),
            ...(supportsImages === undefined ? {} : { supportsImages }),
            maxContext: variantBaseContext ?? positiveNumber(e.contextTokenLimit ?? e.context_token_limit),
            maxContextForMaxMode: variantMaxContext ??
                positiveNumber(e.contextTokenLimitForMaxMode ?? e.context_token_limit_for_max_mode),
            supportsMaxMode: apiBoolean(e, ["supportsMaxMode", "supports_max_mode"]),
            variants,
        });
    }
    return models;
}
// ── Variant resolution ──
/**
 * Resolve the parameter values to send in `requested_model.parameters` for a
 * given model + the variant opencode selected. Each variant already carries
 * the full `{id,value}` set (per-model vocabulary — effort, fast, thinking,
 * context, …), so we pick the matching variant and return its parameters
 * verbatim — the client never constructs these by hand.
 *
 * `picked` is the user-selected variant paramMap (opencode sends it under
 * `providerOptions.cursor`); when present it wins over effort/maxMode hints
 * so every param the user chose (context, fast, …) is forwarded to Cursor.
 * Hints (`reasoningEffort`, `maxMode`) live beside the dedicated picked array,
 * so the picked values are already isolated and can be matched verbatim.
 */
export function resolveVariantParameters(model, opts = {}) {
    const picked = opts.picked?.map((p) => ({ ...p }));
    if (!model || model.variants.length === 0) {
        if (picked !== undefined) {
            throw new CursorVariantSelectionError(`is stale: model ${JSON.stringify(model?.id ?? "unknown")} has no cached variants`);
        }
        return opts.reasoningEffort ? [{ id: "effort", value: opts.reasoningEffort }] : [];
    }
    const effortOf = (v) => v.parameterValues.find((p) => p.id === "effort" || p.id === "reasoning")?.value;
    const isFast = (v) => v.parameterValues.find((p) => p.id === "fast")?.value === "true";
    const isMaxVariant = (v) => v.isDefaultMax || isLongContextVariant(v);
    const wantMax = opts.maxMode ?? false;
    // Non-fast pool for hint-based resolution only. Exact `picked` matching
    // searches all variants so Fast selections are not silently dropped.
    const pool = model.variants.filter((v) => !isFast(v));
    const scoped = pool.length > 0 ? pool : model.variants;
    // 1. Variant explicitly picked by opencode (verbatim — preserves context, fast, …).
    if (picked !== undefined) {
        const pickedById = new Map(picked.map((parameter) => [parameter.id, parameter.value]));
        const exact = model.variants.find((v) => v.parameterValues.length === picked.length &&
            pickedById.size === picked.length &&
            v.parameterValues.every((parameter) => pickedById.get(parameter.id) === parameter.value));
        if (exact) {
            return buildRequestedModelParams(exact.parameterValues);
        }
        throw new CursorVariantSelectionError(`is stale for model ${JSON.stringify(model.id)}: its exact parameter tuple is unavailable`);
    }
    // When maxMode is requested, prefer max-tier variants for effort matching
    // so "high + max" lands on 1m high rather than the first 300k high.
    const maxScoped = wantMax ? scoped.filter(isMaxVariant) : [];
    const effortPool = maxScoped.length > 0 ? maxScoped : scoped;
    // 2. Effort hint (e.g. user passed reasoningEffort through the CLI).
    if (opts.reasoningEffort) {
        const match = effortPool.find((v) => effortOf(v) === opts.reasoningEffort);
        if (match) {
            return buildRequestedModelParams(match.parameterValues, {
                reasoningEffort: opts.reasoningEffort,
                maxMode: wantMax,
            });
        }
    }
    // 3. Max-mode hint → prefer the default max variant (1m context).
    if (wantMax) {
        const max = scoped.find((v) => v.isDefaultMax) ?? scoped.find(isLongContextVariant);
        if (max)
            return buildRequestedModelParams(max.parameterValues, { maxMode: true });
    }
    // 4. Default non-max variant.
    const byDefault = scoped.find((v) => v.isDefaultNonMax) ?? scoped[0];
    return buildRequestedModelParams(byDefault.parameterValues, {
        reasoningEffort: opts.reasoningEffort,
        maxMode: false,
    });
}
// ── Fetch + cache orchestration ──
export async function fetchModels(token, options = {}) {
    const raw = await unaryAvailableModels(token, options);
    return mapAvailableModelsResponse(raw);
}
const refreshesByDirectory = new Map();
export async function refreshModelCache(cacheDir, fetcher, options = {}) {
    const key = path.resolve(cacheDir);
    const existing = refreshesByDirectory.get(key);
    if (existing) {
        if (!options.forceAfterInflight)
            return existing;
        // An account switch must not join a background refresh authenticated as
        // the previous account. Wait for that write to finish, then run this
        // caller's fetch so its account inventory is authoritative on disk.
        await existing.catch(() => { });
        return refreshModelCache(cacheDir, fetcher, options);
    }
    const refresh = (async () => {
        const models = await fetcher();
        await writeCache(cacheDir, {
            models,
            fetchedAt: Date.now(),
            schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
        });
        return models;
    })();
    refreshesByDirectory.set(key, refresh);
    try {
        return await refresh;
    }
    finally {
        if (refreshesByDirectory.get(key) === refresh)
            refreshesByDirectory.delete(key);
    }
}
export async function discoverModels(token, cacheDir, options = {}) {
    const { forceRefresh = false, ...fetchOptions } = options;
    const cached = await readCache(cacheDir);
    const refresh = () => refreshModelCache(cacheDir, () => fetchModels(token, fetchOptions), { forceAfterInflight: forceRefresh });
    // Cache is fresh → return it; refresh in background
    if (!forceRefresh && cached && isCacheFresh(cached)) {
        // Background refresh (fire and forget)
        void refresh()
            .catch(() => {
            /* background refresh failure is non-fatal */
        });
        return cached.models;
    }
    // Cache exists but expired → try fetch, serve stale on failure
    if (cached) {
        try {
            return await refresh();
        }
        catch (error) {
            if (forceRefresh)
                throw error;
            return cached.models;
        }
    }
    // No cache → must fetch
    return refresh();
}
