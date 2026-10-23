const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEB_SEARCH_TIMEOUT_MS = 25_000;
function exaMcpUrl() {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey)
        return EXA_MCP_URL;
    const url = new URL(EXA_MCP_URL);
    url.searchParams.set("exaApiKey", apiKey);
    return url.href;
}
function mcpText(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const result = value.result;
    if (!result || typeof result !== "object")
        return undefined;
    const content = result.content;
    if (!Array.isArray(content))
        return undefined;
    for (const item of content) {
        if (item &&
            typeof item === "object" &&
            item.type === "text" &&
            typeof item.text === "string") {
            return item.text;
        }
    }
    return undefined;
}
export function parseOpenCodeWebSearchResponse(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    try {
        const text = mcpText(JSON.parse(trimmed));
        if (text)
            return text;
    }
    catch {
        // MCP may respond as an SSE stream instead of one JSON object.
    }
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data: "))
            continue;
        try {
            const text = mcpText(JSON.parse(line.slice(6)));
            if (text)
                return text;
        }
        catch {
            // Ignore non-JSON SSE events.
        }
    }
    return undefined;
}
function tryParseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function publishedMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
function asWebSearchResult(row) {
    if (!row || typeof row !== "object")
        return undefined;
    const record = row;
    const url = typeof record.url === "string" ? record.url
        : typeof record.href === "string" ? record.href
            : undefined;
    if (!url)
        return undefined;
    const title = typeof record.title === "string" ? record.title : undefined;
    const content = typeof record.content === "string" ? record.content
        : typeof record.text === "string" ? record.text
            : typeof record.snippet === "string" ? record.snippet
                : undefined;
    const published = publishedMs(record.publishedDate ?? record.published ?? record.date);
    return {
        url,
        ...(title ? { title } : {}),
        ...(content ? { content } : {}),
        time: published !== undefined ? { published } : {},
    };
}
function parseExaTextResults(text) {
    return text.split(/\n\n---\n\n/).flatMap((block) => {
        const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
        if (!url)
            return [];
        const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
        const publishedText = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
        const published = publishedText && publishedText !== "N/A"
            ? publishedMs(publishedText)
            : undefined;
        const content = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim();
        return [{
                url,
                ...(title && title !== "N/A" ? { title } : {}),
                ...(content ? { content } : {}),
                time: published === undefined ? {} : { published },
            }];
    });
}
/**
 * Turn an Exa MCP text blob into OpenCode 2.0 `websearch` results
 * (`{ url, title?, content?, time }`). Unknown shapes yield an empty list.
 */
export function parseExaWebSearchResults(raw) {
    const text = parseOpenCodeWebSearchResponse(raw) ?? raw.trim();
    if (!text)
        return [];
    const parsed = tryParseJson(text);
    const rows = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object"
            ? Array.isArray(parsed.results)
                ? parsed.results
                : Array.isArray(parsed.data)
                    ? parsed.data
                    : []
            : [];
    if (rows.length > 0) {
        return rows.flatMap((row) => {
            const result = asWebSearchResult(row);
            return result ? [result] : [];
        });
    }
    return parseExaTextResults(text);
}
export async function fetchOpenCodeWebSearchText(args, signal, fetchImpl = fetch) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted)
        abort();
    else
        signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Web search timed out")), WEB_SEARCH_TIMEOUT_MS);
    try {
        const response = await fetchImpl(exaMcpUrl(), {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                    name: "web_search_exa",
                    arguments: {
                        query: args.query,
                        type: args.type ?? "auto",
                        numResults: args.numResults ?? 8,
                        livecrawl: args.livecrawl ?? "fallback",
                        contextMaxCharacters: args.contextMaxCharacters,
                    },
                },
            }),
            signal: controller.signal,
        });
        const raw = await response.text();
        if (!response.ok)
            throw new Error(`Web search failed (${response.status}): ${raw.slice(0, 500)}`);
        return parseOpenCodeWebSearchResponse(raw) ?? "No search results found. Please try a different query.";
    }
    finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}
export async function executeOpenCodeWebSearch(args, context, fetchImpl = fetch) {
    await context.ask({
        permission: "websearch",
        patterns: [args.query],
        always: ["*"],
        metadata: {
            query: args.query,
            numResults: args.numResults,
            livecrawl: args.livecrawl,
            type: args.type,
            contextMaxCharacters: args.contextMaxCharacters,
            provider: "exa",
        },
    });
    const output = await fetchOpenCodeWebSearchText(args, context.abort, fetchImpl);
    return {
        title: `Exa Web Search: ${args.query}`,
        output,
        metadata: { provider: "exa" },
    };
}
