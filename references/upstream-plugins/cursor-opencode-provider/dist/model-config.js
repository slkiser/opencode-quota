import { CURSOR_VARIANT_PARAMETERS_KEY, CURSOR_WIRE_MODEL_ID_KEY, parseCursorContextLimit, } from "./models.js";
import { applyCursorModelCost, hasCursorFastPricing } from "./pricing.js";
import { getDocumentedCursorModelContext, resolveCursorModelSupportsImages, } from "./model-metadata.js";
/**
 * Cursor `ModelInfo` → OpenCode model-config mapping.
 *
 * Host-neutral on purpose: both the classic/1.18 plugins and the OpenCode 2.0
 * plugin derive their catalogs from here, so model naming, thinking suffixes,
 * and long-context tiering stay identical across every surface. Do not import
 * a host plugin API into this module.
 */
/**
 * Strip characters and markup that break rendering in the OpenCode TUI/GUI from
 * a model or variant display name:
 *   • HTML tags (e.g. `<span style="…">Medium</span>`) — the IDE colours variant
 *     suffixes with a CSS var that doesn't exist in OpenCode, so the raw markup
 *     would show as literal text. We drop the tags and keep the inner text
 *     ("Medium").
 *   • HTML/markup chars (`< > & " ' \``), parentheses.
 *   • Tabs/newlines collapse to single spaces.
 * Dots and unicode letters are preserved so names stay readable.
 * Fixes https://github.com/oakimov/cursor-opencode-provider/issues/2.
 */
function stripMarkupTags(value) {
    const chunks = [];
    let cursor = 0;
    while (cursor < value.length) {
        const start = value.indexOf("<", cursor);
        if (start === -1) {
            chunks.push(value.slice(cursor));
            break;
        }
        chunks.push(value.slice(cursor, start));
        const end = value.indexOf(">", start + 1);
        if (end === -1) {
            chunks.push(value.slice(start));
            break;
        }
        cursor = end + 1;
    }
    return chunks.join("");
}
function safeLabel(value) {
    return (stripMarkupTags(value)
        .replace(/[()<>&"'`]/g, "")
        .replace(/\s+/g, " ")
        .trim() || "default");
}
function baseName(mi) {
    return safeLabel(mi.displayName ?? mi.id);
}
function modelInfoVariants(mi, variants) {
    if (variants.length === 0)
        return undefined;
    const entries = {};
    const usedKeys = new Set();
    const baseName = safeLabel(mi.displayName ?? mi.id);
    // Each variant's key is `safeLabel(displayName)` (the IDE's own label, e.g.
    // "Opus 4.8 1M High Fast Thinking") so the picker matches what the user
    // sees in Cursor. Two variants can sanitize to the same name when the IDE
    // wraps a differentiator in `<span>…</span>` (e.g. Composer's "Fast"
    // suffix collapses to the bare model name after stripping). To guarantee
    // every variant stays pickable:
    //   1. If the sanitized displayName matches the model name itself, suffix
    //      it with distinguishing params (or "default") so it never collides
    //      with the model entry in the variant panel.
    //   2. If two variants still collide, tag the later one with its params.
    // Suffixes must stay free of `()` / markup chars — same constraint as
    // safeLabel (issue #2); use spaced tokens, not parenthetical tags.
    const tagDims = (p) => {
        const labels = [];
        for (const d of p) {
            if (d.id === "fast" && d.value === "true")
                labels.push("Fast");
            else if (d.id === "thinking" && d.value === "true")
                labels.push("Thinking");
            else if (d.id === "context")
                labels.push(d.value);
        }
        if (labels.length > 0)
            return ` ${labels.join(" ")}`;
        // No params at all — still disambiguate from the model name itself.
        if (p.length === 0)
            return "";
        return " default";
    };
    for (const v of variants) {
        const sanitized = safeLabel(v.displayName || v.key || "default");
        let key = sanitized;
        // Never let a variant key equal the model name — that would make the
        // variant entry indistinguishable from the model entry in pickers that
        // collapse them.
        if (key === baseName && !usedKeys.has(key)) {
            key = `${baseName}${tagDims(v.parameterValues) || " default"}`;
        }
        else if (usedKeys.has(key)) {
            key = `${sanitized}${tagDims(v.parameterValues)}`;
        }
        let n = 2;
        while (usedKeys.has(key))
            key = `${sanitized}${tagDims(v.parameterValues)} ${n++}`;
        usedKeys.add(key);
        entries[key] = {
            [CURSOR_VARIANT_PARAMETERS_KEY]: v.parameterValues.map((p) => ({ ...p })),
        };
    }
    return entries;
}
function isLongContextVariant(v) {
    return v.parameterValues.some((p) => p.id === "context" && parseCursorContextLimit(p.value) === 1_000_000);
}
function isFastVariant(v) {
    return v.parameterValues.some((p) => p.id === "fast" && p.value === "true");
}
function variantsForTier(mi, tier) {
    return mi.variants.filter((v) => isLongContextVariant(v) === (tier === "long"));
}
/**
 * Display names shared by both a thinking and a non-thinking model. A thinking
 * model with such a name needs a "Thinking" tag to disambiguate it from its
 * non-thinking twin (Cursor's Claude/Fable/Sonnet families). Models whose names
 * are already unique — including Cursor's GPT family, where the reasoning tier
 * ("None"/"Low"/"High"…) is baked into the name — are excluded, so they aren't
 * tagged redundantly.
 */
export function thinkingSuffixBaseNames(models) {
    const flags = new Map();
    for (const m of models) {
        const base = baseName(m);
        const entry = flags.get(base) ?? { hasThinking: false, hasNonThinking: false };
        if (m.supportsThinking)
            entry.hasThinking = true;
        else
            entry.hasNonThinking = true;
        flags.set(base, entry);
    }
    const ambiguous = new Set();
    for (const [base, f] of flags)
        if (f.hasThinking && f.hasNonThinking)
            ambiguous.add(base);
    return ambiguous;
}
/**
 * models.dev-style family for a Cursor model id: the id without its version
 * segments and context/speed suffixes (`claude-haiku-4-5` → `claude-haiku`,
 * `gemini-3.8-flash` → `gemini-flash`, `gpt-5.6-luna` → `gpt-luna`).
 * Kimi keeps its major generation (`kimi-k2.7-code` → `kimi-k2`). OpenCode
 * picks its small title model by family and falls back to the session model when
 * no entry has one. Cursor Auto (`default`) is not a model family.
 */
export function cursorModelFamily(id) {
    if (id === "default")
        return undefined;
    const base = id.replace(/(?:-(?:1m|fast))+$/, "");
    const kimi = /^kimi-(k\d+)(?:[.p]\d+)*(?:-code(?:-highspeed)?)?$/.exec(base);
    if (kimi)
        return `kimi-${kimi[1]}`;
    const family = base
        .split("-")
        .filter((part) => !/^\d+(?:[.p]\d+)*$/.test(part))
        .join("-");
    return family || undefined;
}
export function modelInfoToConfig(mi, options = {}) {
    const contextTier = options.contextTier ?? "base";
    const variants = options.variants ?? variantsForTier(mi, contextTier);
    let name = baseName(mi);
    if (options.thinkingSuffix)
        name += " Thinking";
    if (options.fast)
        name += " Fast";
    if (contextTier === "long")
        name += " 1M";
    // OpenCode's context limit is static per model entry, while Cursor's context
    // tier is a variant parameter. Long-context choices are therefore emitted as
    // separate OpenCode entries by modelsToConfig.
    const documentedContext = getDocumentedCursorModelContext(mi.id);
    // Cursor Auto (`default`) has no static maxContext on the model list, but
    // live checkpoints report 256k for the base tier — the previous 200k
    // fallback made the host context meter disagree with Cursor.
    const fallbackContext = mi.id === "default" ? 256_000 : 200_000;
    const context = contextTier === "long"
        ? (mi.maxContextForMaxMode ?? documentedContext?.maxContextForMaxMode ?? 1_000_000)
        : (mi.maxContext ?? documentedContext?.maxContext ?? fallbackContext);
    // OpenCode's overflow/compaction/UI use limit.context; generation and
    // thinking budgets use limit.output. models.dev 1M peers advertise
    // 64k–128k output — a tiny cap makes long-context sessions feel broken
    // even when the 1M input window is correct.
    const output = contextTier === "long" ? 128_000 : 32_000;
    const supportsImages = resolveCursorModelSupportsImages(mi.id, mi.supportsImages);
    const config = {
        name,
        attachment: supportsImages,
        reasoning: mi.supportsThinking ?? false,
        tool_call: mi.supportsAgent ?? true,
        temperature: false,
        modalities: {
            input: supportsImages ? ["text", "image"] : ["text"],
            output: ["text"],
        },
        limit: {
            context,
            output,
        },
    };
    // Optional cache metadata may supply a family; the live AvailableModels
    // schema has no family field. Empty metadata must not block derivation.
    const reported = typeof mi.family === "string" ? mi.family.trim() : "";
    const family = reported || cursorModelFamily(mi.id);
    if (family)
        config.family = family;
    const variantConfig = modelInfoVariants(mi, variants);
    if (variantConfig)
        config.variants = variantConfig;
    if (contextTier === "long" || options.fast) {
        const defaultVariant = contextTier === "long"
            ? (variants.find((v) => v.isDefaultMax) ?? variants[0])
            : (variants.find((v) => v.isDefaultNonMax) ?? variants[0]);
        if (defaultVariant) {
            config.options = {
                [CURSOR_WIRE_MODEL_ID_KEY]: mi.id,
                [CURSOR_VARIANT_PARAMETERS_KEY]: defaultVariant.parameterValues.map((p) => ({ ...p })),
            };
        }
    }
    return config;
}
function speedGroups(variants, splitFast) {
    if (!splitFast)
        return variants.length > 0 ? [{ fast: false, variants }] : [];
    const slow = variants.filter((variant) => !isFastVariant(variant));
    const fast = variants.filter((variant) => isFastVariant(variant));
    const groups = [];
    if (slow.length > 0)
        groups.push({ fast: false, variants: slow });
    if (fast.length > 0)
        groups.push({ fast: true, variants: fast });
    return groups;
}
function uniqueCatalogId(usedIds, modelId, suffix) {
    let id = `${modelId}${suffix}`;
    if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
    }
    let n = 2;
    while (true) {
        const candidate = suffix === "-fast"
            ? `${modelId}-fast-${n}`
            : suffix === "-1m-fast"
                ? `${modelId}-1m-${n}-fast`
                : `${modelId}-1m-${n}`;
        if (!usedIds.has(candidate)) {
            usedIds.add(candidate);
            return candidate;
        }
        n++;
    }
}
export function modelsToConfig(models) {
    const ambiguous = thinkingSuffixBaseNames(models);
    const out = {};
    const usedIds = new Set(models.map((m) => m.id));
    for (const m of models) {
        const thinkingSuffix = !!m.supportsThinking && ambiguous.has(baseName(m));
        const splitFast = hasCursorFastPricing(m.id);
        const groups = [];
        for (const contextTier of ["base", "long"]) {
            const suffixFor = (fast) => contextTier === "long" ? (fast ? "-1m-fast" : "-1m") : (fast ? "-fast" : "");
            for (const group of speedGroups(variantsForTier(m, contextTier), splitFast)) {
                groups.push({
                    contextTier,
                    fast: group.fast,
                    variants: group.variants,
                    suffix: suffixFor(group.fast),
                });
            }
        }
        if (groups.length === 0) {
            out[m.id] = applyCursorModelCost(m.id, modelInfoToConfig(m, { thinkingSuffix, contextTier: "base" }));
            continue;
        }
        const primaryIndex = groups.findIndex((group) => group.suffix === "");
        const primary = primaryIndex >= 0 ? primaryIndex : 0;
        for (const [index, group] of groups.entries()) {
            const catalogId = index === primary
                ? m.id
                : uniqueCatalogId(usedIds, m.id, group.suffix || "-fast");
            const pricingId = group.fast ? `${m.id}-fast` : (group.contextTier === "long" ? `${m.id}-1m` : m.id);
            const config = modelInfoToConfig(m, {
                thinkingSuffix,
                contextTier: group.contextTier,
                variants: group.variants,
                fast: group.fast,
            });
            if (catalogId !== m.id && !config.options) {
                const defaultVariant = (group.contextTier === "long"
                    ? group.variants.find((v) => v.isDefaultMax)
                    : group.variants.find((v) => v.isDefaultNonMax)) ?? group.variants[0];
                if (defaultVariant) {
                    config.options = {
                        [CURSOR_WIRE_MODEL_ID_KEY]: m.id,
                        [CURSOR_VARIANT_PARAMETERS_KEY]: defaultVariant.parameterValues.map((p) => ({ ...p })),
                    };
                }
            }
            out[catalogId] = applyCursorModelCost(pricingId, config);
        }
    }
    return out;
}
