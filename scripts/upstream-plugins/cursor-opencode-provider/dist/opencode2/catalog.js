import { pathToFileURL } from "node:url";
import { CURSOR_PROVIDER_ID } from "../shared.js";
import { CURSOR_WIRE_MODEL_ID_KEY } from "../models.js";
import { modelsToConfig } from "../model-config.js";
import { toOpenCode2Costs } from "../pricing.js";
/**
 * In-memory provider registration for the OpenCode 2.0 plugin — the replacement
 * for the classic plugin's `config` hook.
 *
 * Model naming, thinking suffixes, and long-context tiering are NOT reimplemented
 * here: we run the shared `modelsToConfig` and translate its output into the 2.0
 * `Model.Info` shape, so every surface exposes an identical model list.
 */
/** Integration id owning Cursor credentials. Matches the provider id. */
export const CURSOR_INTEGRATION_ID = CURSOR_PROVIDER_ID;
/**
 * `aisdk:` selects OpenCode 2.0's AI SDK path, which is what surfaces the
 * `aisdk.hook("sdk")` / `("language")` extension points we supply the provider
 * through. The suffix is this package's npm name so the host's built-in
 * fallback can still resolve it if our own hook is ever bypassed — that
 * fallback runs `npm.add(pkg)` against the *published* registry into
 * `<host-cache>/packages/<pkg>/node_modules/<pkg>`, ignoring any local
 * `file://` plugin path this process was loaded from.
 *
 * `CURSOR_OPENCODE2_DEV_ENTRY` overrides the suffix with an `aisdk:file://…`
 * spec instead, pointed at a local built entry file (e.g. `dist/index.js`,
 * which exports `createCursor`). The host's fallback recognizes `file://`
 * specs and imports them directly, skipping `npm.add` — the only way to
 * exercise a local build through that fallback path short of publishing.
 * Unset in production; only meant for local `opencode2 run` testing.
 */
export const CURSOR_AISDK_PACKAGE = process.env.CURSOR_OPENCODE2_DEV_ENTRY
    ? `aisdk:${pathToFileURL(process.env.CURSOR_OPENCODE2_DEV_ENTRY).href}`
    : "aisdk:cursor-opencode-provider";
/** Translate one `modelsToConfig` entry into the 2.0 `Model.Info` shape. */
export function modelConfigEntryToInfo(id, entry) {
    const options = entry.options;
    // Long-context and Fast entries get synthetic OpenCode ids (`<id>-1m`,
    // `<id>-fast`, `<id>-1m-fast`) while still addressing the same Cursor model
    // on the wire. V1 smuggled that through provider options; 2.0 has a
    // first-class `modelID` for exactly this.
    const wireId = typeof options?.[CURSOR_WIRE_MODEL_ID_KEY] === "string"
        ? options[CURSOR_WIRE_MODEL_ID_KEY]
        : id;
    const variants = Object.entries((entry.variants ?? {})).map(([variantId, settings]) => ({ id: variantId, settings: { ...settings } }));
    const inputModalities = Array.isArray(entry.modalities?.input)
        ? entry.modalities.input.filter((modality) => typeof modality === "string")
        : ["text"];
    const outputModalities = Array.isArray(entry.modalities?.output)
        ? entry.modalities.output.filter((modality) => typeof modality === "string")
        : ["text"];
    const info = {
        id,
        modelID: wireId,
        providerID: CURSOR_PROVIDER_ID,
        name: entry.name ?? id,
        capabilities: {
            tools: entry.tool_call !== false,
            input: inputModalities,
            output: outputModalities,
        },
        limit: {
            context: entry.limit?.context ?? 200_000,
            output: entry.limit?.output ?? 8192,
        },
        variants,
        status: "active",
        enabled: true,
        time: { released: 0 },
        cost: toOpenCode2Costs(entry.cost),
    };
    if (typeof entry.family === "string" && entry.family.trim())
        info.family = entry.family.trim();
    if (options)
        info.settings = { ...options };
    return info;
}
/** Full model map for the in-memory provider inventory. */
export function modelsToCatalogModelMap(models) {
    const config = modelsToConfig(models);
    const out = {};
    for (const [id, entry] of Object.entries(config)) {
        out[id] = modelConfigEntryToInfo(id, entry);
    }
    return out;
}
/**
 * Publish discovered Cursor models into the live provider inventory.
 *
 * Skip while empty (keeps the last successful inventory through a no-op
 * transform on first register), replace the definition with `editor.add`,
 * then `ctx.provider.reload()`.
 */
export function applyCursorProviderInventory(editor, models, sourceConnection) {
    if (models.length === 0)
        return;
    editor.add({
        info: {
            id: CURSOR_PROVIDER_ID,
            name: "Cursor",
            activation: "enabled",
            package: CURSOR_AISDK_PACKAGE,
            integrationID: CURSOR_INTEGRATION_ID,
        },
        models: Object.values(modelsToCatalogModelMap(models)),
        ...(sourceConnection ? { sourceConnection } : {}),
    });
}
