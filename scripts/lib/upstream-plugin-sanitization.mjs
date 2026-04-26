import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REDACTED_GOOGLE_OAUTH_CLIENT_ID = "REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
const REDACTED_GOOGLE_OAUTH_CLIENT_SECRET = "REDACTED_GOOGLE_OAUTH_CLIENT_SECRET";
const CURSOR_SAFE_MODELS_BLOCK = `export async function getCursorModels(apiKey) {
    if (cachedModels)
        return cachedModels;
    const discovered = await fetchCursorUsableModels(apiKey);
    if (discovered && discovered.length > 0) {
        cachedModels = discovered;
        return cachedModels;
    }
    return FALLBACK_MODELS;
}`;
const CURSOR_SAFE_PROXY_BLOCK = `function normalizeConversationMessages(messages) {
    return messages
        .filter((m) => m.role !== "tool")
        .map((m) => ({
        role: m.role,
        content: textContent(m.content),
    }))
        .filter((m) => m.content || m.role === "user" || m.role === "system");
}
/** Derive a key for active bridge lookup (tool-call continuations). Model-specific. */
function deriveBridgeKey(modelId, messages) {
    const normalizedMessages = normalizeConversationMessages(messages);
    return createHash("sha256")
        .update(JSON.stringify({
        modelId,
        messages: normalizedMessages,
    }))
        .digest("hex")
        .slice(0, 16);
}
/** Derive a key for conversation state. Model-independent so context survives model switches. */
function deriveConversationKey(messages) {
    const normalizedMessages = normalizeConversationMessages(messages);
    return createHash("sha256")
        .update(JSON.stringify({
        messages: normalizedMessages,
    }))
        .digest("hex")
        .slice(0, 16);
}`;

const SNAPSHOT_SANITIZERS = Object.freeze({
  "opencode-antigravity-auth": Object.freeze([
    {
      relativePath: "dist/src/constants.d.ts",
      replacements: [
        {
          label: "ANTIGRAVITY_CLIENT_ID",
          pattern: /(export declare const ANTIGRAVITY_CLIENT_ID = )"[^"]+";/,
          replacement: `$1"${REDACTED_GOOGLE_OAUTH_CLIENT_ID}";`,
        },
        {
          label: "ANTIGRAVITY_CLIENT_SECRET",
          pattern: /(export declare const ANTIGRAVITY_CLIENT_SECRET = )"[^"]+";/,
          replacement: `$1"${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}";`,
        },
      ],
    },
    {
      relativePath: "dist/src/constants.js",
      replacements: [
        {
          label: "ANTIGRAVITY_CLIENT_ID",
          pattern: /(export const ANTIGRAVITY_CLIENT_ID = )"[^"]+";/,
          replacement: `$1"${REDACTED_GOOGLE_OAUTH_CLIENT_ID}";`,
        },
        {
          label: "ANTIGRAVITY_CLIENT_SECRET",
          pattern: /(export const ANTIGRAVITY_CLIENT_SECRET = )"[^"]+";/,
          replacement: `$1"${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}";`,
        },
      ],
    },
  ]),
  "opencode-gemini-auth": Object.freeze([
    {
      relativePath: "src/constants.ts",
      replacements: [
        {
          label: "GEMINI_CLIENT_ID",
          pattern: /(export const GEMINI_CLIENT_ID = )(["'])[^"']+\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_ID}$2;`,
        },
        {
          label: "GEMINI_CLIENT_SECRET",
          pattern: /(export const GEMINI_CLIENT_SECRET = )(["'])[^"']+\2;/,
          replacement: `$1$2${REDACTED_GOOGLE_OAUTH_CLIENT_SECRET}$2;`,
        },
      ],
    },
  ]),
  "opencode-cursor-oauth": Object.freeze([
    {
      relativePath: "dist/models.js",
      replacements: [
        {
          label: "CURSOR_DISCOVERY_CACHE_FALLBACK",
          alreadySanitizedPattern:
            /if \(discovered && discovered\.length > 0\) {\s+cachedModels = discovered;\s+return cachedModels;\s+}\s+return FALLBACK_MODELS;/,
          pattern:
            /export async function getCursorModels\(apiKey\) {\s+if \(cachedModels\)\s+return cachedModels;\s+const discovered = await fetchCursorUsableModels\(apiKey\);\s+cachedModels = discovered && discovered\.length > 0 \? discovered : FALLBACK_MODELS;\s+return cachedModels;\s+}/,
          replacement: CURSOR_SAFE_MODELS_BLOCK,
        },
      ],
    },
    {
      relativePath: "dist/proxy.js",
      replacements: [
        {
          label: "CURSOR_TRANSCRIPT_BRIDGE_KEY",
          alreadySanitizedPattern:
            /function deriveBridgeKey\(modelId, messages\) {\s+const normalizedMessages = (?:normalizeConversationMessages\(messages\)|messages\s+\.filter\(\(m\) => m\.role !== "tool"\)[\s\S]+?\.filter\(\(m\) => m\.content \|\| m\.role === "user" \|\| m\.role === "system"\));\s+return createHash\("sha256"\)\s+\.update\(JSON\.stringify\({\s+modelId,\s+messages: normalizedMessages,\s+}\)\)\s+\.digest\("hex"\)\s+\.slice\(0, 16\);\s+}\s+\/\*\* Derive a key for conversation state\. Model-independent so context survives model switches\. \*\/\s+function deriveConversationKey\(messages\) {\s+const normalizedMessages = (?:normalizeConversationMessages\(messages\)|messages\s+\.filter\(\(m\) => m\.role !== "tool"\)[\s\S]+?\.filter\(\(m\) => m\.content \|\| m\.role === "user" \|\| m\.role === "system"\));\s+return createHash\("sha256"\)\s+\.update\(JSON\.stringify\({\s+messages: normalizedMessages,\s+}\)\)\s+\.digest\("hex"\)\s+\.slice\(0, 16\);\s+}/,
          pattern:
            /\/\*\* Derive a key for active bridge lookup \(tool-call continuations\)\. Model-specific\. \*\/\s+function deriveBridgeKey\(modelId, messages\) {\s+const firstUserMsg = messages\.find\(\(m\) => m\.role === "user"\);\s+const firstUserText = firstUserMsg \? textContent\(firstUserMsg\.content\) : "";\s+return createHash\("sha256"\)\s+\.update\(`bridge:\$\{modelId\}:\$\{firstUserText\.slice\(0, 200\)\}`\)\s+\.digest\("hex"\)\s+\.slice\(0, 16\);\s+}\s+\/\*\* Derive a key for conversation state\. Model-independent so context survives model switches\. \*\/\s+function deriveConversationKey\(messages\) {\s+const firstUserMsg = messages\.find\(\(m\) => m\.role === "user"\);\s+const firstUserText = firstUserMsg \? textContent\(firstUserMsg\.content\) : "";\s+return createHash\("sha256"\)\s+\.update\(`conv:\$\{firstUserText\.slice\(0, 200\)\}`\)\s+\.digest\("hex"\)\s+\.slice\(0, 16\);\s+}/,
          replacement: CURSOR_SAFE_PROXY_BLOCK,
        },
      ],
    },
  ]),
});

export async function sanitizeUpstreamPluginSnapshot(pluginId, pluginRoot) {
  const sanitizers = SNAPSHOT_SANITIZERS[pluginId] ?? [];

  for (const sanitizer of sanitizers) {
    const filePath = path.join(pluginRoot, sanitizer.relativePath);
    let content = await readFile(filePath, "utf8");

    for (const replacement of sanitizer.replacements) {
      if (replacement.alreadySanitizedPattern?.test(content)) {
        continue;
      }

      if (!replacement.pattern.test(content)) {
        throw new Error(
          `Expected ${replacement.label} in ${filePath} while sanitizing ${pluginId} snapshot.`,
        );
      }

      content = content.replace(replacement.pattern, replacement.replacement);
    }

    await writeFile(filePath, content, "utf8");
  }
}
