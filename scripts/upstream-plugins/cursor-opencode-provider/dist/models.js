import { MODEL_CACHE_FILE, MODEL_CACHE_SCHEMA_VERSION, MODEL_CACHE_TTL_MS } from "./shared.js";
import { unaryAvailableModels } from "./transport/connect.js";
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
    const ids = new Set();
    for (const parameter of value) {
        if (!isPlainRecord(parameter))
            return null;
        if (!isNonEmptyString(parameter.id) || typeof parameter.value !== "string")
            return null;
        if (ids.has(parameter.id))
            return null;
        ids.add(parameter.id);
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
    const isMaxMode = optionalBoolean(value, ["isMaxMode", "is_max_mode"]);
    if (key === null ||
        displayName === null ||
        isDefaultNonMax === null ||
        isDefaultMax === null ||
        isMaxMode === null) {
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
        ...(isMaxMode === undefined ? {} : { isMaxMode }),
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
    const supportsNonMaxMode = optionalBoolean(value, ["supportsNonMaxMode", "supports_non_max_mode"]);
    const maxContext = optionalPositiveNumber(value, ["maxContext", "contextTokenLimit", "context_token_limit"]);
    const maxContextForMaxMode = optionalPositiveNumber(value, ["maxContextForMaxMode", "contextTokenLimitForMaxMode", "context_token_limit_for_max_mode"]);
    if (displayName === null ||
        family === null ||
        supportsThinking === null ||
        supportsAgent === null ||
        supportsImages === null ||
        supportsMaxMode === null ||
        supportsNonMaxMode === null ||
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
        ...(supportsNonMaxMode === undefined ? {} : { supportsNonMaxMode }),
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
/**
 * True when resolved params select the long-context (1m) tier. Fallback for
 * variants without Cursor's `isMaxMode` marker.
 */
export function paramsImplyMaxMode(params) {
    return params.some((parameter) => parameter.id === "context" &&
        parseCursorContextLimit(parameter.value) === 1_000_000);
}
function sameParameterTuple(a, b) {
    const byId = new Map(b.map((parameter) => [parameter.id, parameter.value]));
    return (a.length === b.length &&
        new Set(a.map((parameter) => parameter.id)).size === a.length &&
        byId.size === b.length &&
        a.every((parameter) => byId.get(parameter.id) === parameter.value));
}
/** Cursor's per-variant max-mode marker, else the 1m-context fallback. */
function variantIsMaxMode(v) {
    return v.isMaxMode ?? paramsImplyMaxMode(v.parameterValues);
}
/**
 * Resolve the request-level max_mode bit. Like Cursor CLI, a cataloged variant
 * requires max mode when Cursor marks it `isMaxMode` (Grok 4.7's 500k tier as
 * well as 1m tiers) or the model does not support non-max mode. An explicit
 * variant pick owns the context tier; otherwise a standalone maxMode hint may
 * select max mode.
 */
export function resolveVariantMaxMode(params, opts = {}) {
    if (opts.model?.supportsNonMaxMode === false)
        return true;
    const marked = opts.model?.variants.find((v) => sameParameterTuple(v.parameterValues, params))?.isMaxMode;
    return (marked ?? paramsImplyMaxMode(params)) || (opts.picked === undefined && opts.maxMode === true);
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
/** Same parameters as `target` except the ignored ids. */
function isTwinOf(v, target, ignored) {
    return (v.parameterValues.length === target.parameterValues.length &&
        sameParameterTuple(v.parameterValues.filter((p) => !ignored.includes(p.id)), target.parameterValues.filter((p) => !ignored.includes(p.id))));
}
/**
 * Find Cursor's declared default within a catalog subset, retaining its effort:
 * the declared variant, else its speed twin, else its twin in another context
 * tier (a 500k entry when the declared max default is 1m).
 */
export function findDefaultVariant(model, candidates, maxMode) {
    const isDeclared = (v) => maxMode ? v.isDefaultMax : v.isDefaultNonMax;
    const declared = model.variants.find(isDeclared);
    return candidates.find(isDeclared) ??
        (declared === undefined
            ? undefined
            : candidates.find((v) => isTwinOf(v, declared, ["fast"])) ??
                candidates.find((v) => isTwinOf(v, declared, ["fast", "context"])));
}
/** Send an advertised tuple verbatim; never rewrite one of its values. */
function copyParameters(parameters) {
    return parameters.map((parameter) => ({ ...parameter }));
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
            const isMaxMode = optionalBoolean(v, ["isMaxMode", "is_max_mode"]);
            if (isMaxMode === null) {
                throw new Error(`AvailableModels returned a non-boolean isMaxMode for ${name}`);
            }
            variants.push({
                key: name,
                parameterValues,
                displayName: (v.displayName ?? v.display_name ?? name),
                isDefaultNonMax: apiBoolean(v, ["isDefaultNonMaxConfig", "is_default_non_max_config"]),
                isDefaultMax: apiBoolean(v, ["isDefaultMaxConfig", "is_default_max_config"]),
                ...(isMaxMode === undefined ? {} : { isMaxMode }),
            });
        }
        // Derive the context window from the variant `context` param (primary
        // source). Base tier ← default non-max variant; max tier ← default max
        // variant. Fall back to the (often empty) proto fields, then undefined.
        // Prefer a non-max context when isDefaultNonMax is missing so a leading
        // max-mode variant cannot inflate the base window.
        const variantBaseContext = variantContextTokens(variants.find((v) => v.isDefaultNonMax)) ??
            variantContextTokens(variants.find((v) => !variantIsMaxMode(v) && variantContextTokens(v) !== undefined &&
                variantContextTokens(v) !== 1_000_000)) ??
            variantContextTokens(variants.find((v) => v.parameterValues.some((p) => p.id === "context")));
        const variantMaxContext = variantContextTokens(variants.find((v) => v.isDefaultMax)) ??
            variantContextTokens(variants.find((v) => variantIsMaxMode(v) && variantContextTokens(v) !== undefined));
        const supportsImages = optionalBoolean(e, ["supportsImages", "supports_images"]);
        if (supportsImages === null) {
            throw new Error(`AvailableModels returned invalid supportsImages for ${name}`);
        }
        const supportsNonMaxMode = optionalBoolean(e, ["supportsNonMaxMode", "supports_non_max_mode"]);
        if (supportsNonMaxMode === null) {
            throw new Error(`AvailableModels returned invalid supportsNonMaxMode for ${name}`);
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
            ...(supportsNonMaxMode === undefined ? {} : { supportsNonMaxMode }),
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
    const effortOf = (v) => v.parameterValues.find((p) => p.id === "effort" || p.id === "reasoning" || p.id === "reasoning_effort")?.value;
    const isFast = (v) => v.parameterValues.find((p) => p.id === "fast")?.value === "true";
    const wantMax = (opts.maxMode ?? false) || model.supportsNonMaxMode === false;
    // 1. Variant explicitly picked by opencode (verbatim — preserves context, fast, …).
    if (picked !== undefined) {
        const exact = model.variants.find((v) => sameParameterTuple(v.parameterValues, picked));
        if (exact) {
            return copyParameters(exact.parameterValues);
        }
        throw new CursorVariantSelectionError(`is stale for model ${JSON.stringify(model.id)}: its exact parameter tuple is unavailable`);
    }
    // Choose the tier before preferring non-Fast variants. Otherwise a Fast-only
    // max tier disappears, or a leading max variant steals an effort-only hint.
    // isDefaultMax is a preference, not a requirement to run in max mode.
    const tier = model.variants.filter((v) => variantIsMaxMode(v) === wantMax);
    const candidates = tier.length > 0 ? tier : model.variants;
    const nonFast = candidates.filter((v) => !isFast(v));
    const scoped = nonFast.length > 0 ? nonFast : candidates;
    // Cursor can declare a Fast variant as a default (Grok, GPT max defaults);
    // the tier default retains the declared default's effort when its speed
    // twin is needed (same parameters except `fast`).
    const byDefault = (wantMax
        ? findDefaultVariant(model, scoped, true) ?? scoped.find(variantIsMaxMode)
        : undefined) ?? findDefaultVariant(model, scoped, false) ?? scoped[0];
    // 2. Effort hint (e.g. user passed reasoningEffort through the CLI). Like
    // Cursor CLI, break ties toward the tier default so the hint changes only
    // effort, not thinking or other parameters (Claude lists thinking=false first).
    if (opts.reasoningEffort) {
        const shared = (v) => v.parameterValues.filter((parameter) => byDefault.parameterValues.some((d) => d.id === parameter.id && d.value === parameter.value)).length;
        const match = scoped
            .filter((v) => effortOf(v) === opts.reasoningEffort)
            .reduce((best, v) => best && shared(best) >= shared(v) ? best : v, undefined);
        if (match) {
            return copyParameters(match.parameterValues);
        }
    }
    // 3. Max-mode hint → the default max variant (the max tier).
    // 4. Otherwise the default non-max variant, else the first candidate.
    // An unsupported effort must not synthesize a tuple Cursor never advertised.
    return copyParameters(byDefault.parameterValues);
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
