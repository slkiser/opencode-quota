import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sanitizeUpstreamPluginSnapshot } from "../scripts/lib/upstream-plugin-sanitization.mjs";

async function writeAntigravityConstants(
  pluginRoot: string,
  clientId: string,
  clientSecret: string,
) {
  const constantsDir = path.join(pluginRoot, "dist", "src");
  await mkdir(constantsDir, { recursive: true });
  await writeFile(
    path.join(constantsDir, "constants.js"),
    `export const ANTIGRAVITY_CLIENT_ID = "${clientId}";\nexport const ANTIGRAVITY_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
  await writeFile(
    path.join(constantsDir, "constants.d.ts"),
    `export declare const ANTIGRAVITY_CLIENT_ID = "${clientId}";\nexport declare const ANTIGRAVITY_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
}

async function writeAgySnapshot(pluginRoot: string, clientId: string, clientSecret: string) {
  const distDir = path.join(pluginRoot, "dist");
  const constantsDir = path.join(distDir, "src");
  await mkdir(constantsDir, { recursive: true });
  await writeFile(
    path.join(constantsDir, "constants.d.ts"),
    `export declare const AGY_CLIENT_ID = "${clientId}";\nexport declare const AGY_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
  await writeFile(
    path.join(distDir, "index.js"),
    `var AGY_CLIENT_ID = "${clientId}";\nvar AGY_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
  await writeFile(
    path.join(distDir, "index.js.map"),
    JSON.stringify({
      sourcesContent: [
        `export const AGY_CLIENT_ID = '${clientId}';\nexport const AGY_CLIENT_SECRET = '${clientSecret}';\n`,
      ],
    }),
    "utf8",
  );
}

async function writeGeminiConstants(pluginRoot: string, clientId: string, clientSecret: string) {
  const constantsDir = path.join(pluginRoot, "src");
  await mkdir(constantsDir, { recursive: true });
  await writeFile(
    path.join(constantsDir, "constants.ts"),
    `export const GEMINI_CLIENT_ID = "${clientId}";\nexport const GEMINI_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
}

async function writeGeminiDistBundle(pluginRoot: string, clientId: string, clientSecret: string) {
  const distDir = path.join(pluginRoot, "dist");
  await mkdir(distDir, { recursive: true });

  await writeFile(
    path.join(distDir, "index.js"),
    `var GEMINI_CLIENT_ID = "${clientId}";\nvar GEMINI_CLIENT_SECRET = "${clientSecret}";\n`,
    "utf8",
  );
  await writeFile(
    path.join(distDir, "index.js.map"),
    JSON.stringify({
      mappings: "",
      sources: ["../src/constants.ts"],
      sourcesContent: [
        `export const GEMINI_CLIENT_ID = "${clientId}";\nexport const GEMINI_CLIENT_SECRET = "${clientSecret}";\n`,
      ],
      version: 3,
    }),
    "utf8",
  );
}

async function writeCursorSnapshot(
  pluginRoot: string,
  params: { modelsSource: string; proxySource: string; packageName?: string },
) {
  const distDir = path.join(pluginRoot, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "models.js"), params.modelsSource, "utf8");
  await writeFile(path.join(distDir, "proxy.js"), params.proxySource, "utf8");

  if (params.packageName) {
    await writeFile(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: params.packageName }, null, 2),
      "utf8",
    );
  }
}

const UNSAFE_CURSOR_MODELS_SOURCE = `let cachedModels = null;
export async function getCursorModels(apiKey) {
    if (cachedModels)
        return cachedModels;
    const discovered = await fetchCursorUsableModels(apiKey);
    cachedModels = discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;
    return cachedModels;
}
`;

const SAFE_CURSOR_MODELS_SOURCE = `let cachedModels = null;
export async function getCursorModels(apiKey) {
    if (cachedModels)
        return cachedModels;
    const discovered = await fetchCursorUsableModels(apiKey);
    if (discovered && discovered.length > 0) {
        cachedModels = discovered;
        return cachedModels;
    }
    return FALLBACK_MODELS;
}
`;

const UNSAFE_CURSOR_PROXY_SOURCE = `/** Derive a key for active bridge lookup (tool-call continuations). Model-specific. */
function deriveBridgeKey(modelId, messages) {
    const firstUserMsg = messages.find((m) => m.role === "user");
    const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
    return createHash("sha256")
        .update(\`bridge:\${modelId}:\${firstUserText.slice(0, 200)}\`)
        .digest("hex")
        .slice(0, 16);
}
/** Derive a key for conversation state. Model-independent so context survives model switches. */
function deriveConversationKey(messages) {
    const firstUserMsg = messages.find((m) => m.role === "user");
    const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
    return createHash("sha256")
        .update(\`conv:\${firstUserText.slice(0, 200)}\`)
        .digest("hex")
        .slice(0, 16);
}
`;

const SAFE_CURSOR_PROXY_SOURCE = `function normalizeConversationMessages(messages) {
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
}
`;

const PARTIALLY_SAFE_CURSOR_PROXY_SOURCE = `function normalizeConversationMessages(messages) {
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
    const firstUserMsg = messages.find((m) => m.role === "user");
    const firstUserText = firstUserMsg ? textContent(firstUserMsg.content) : "";
    return createHash("sha256")
        .update(\`conv:\${firstUserText.slice(0, 200)}\`)
        .digest("hex")
        .slice(0, 16);
}
`;

describe("upstream-plugin-sanitization", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("redacts embedded Google OAuth values from antigravity snapshots", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeAntigravityConstants(tempRoot, "SAFE_TEST_CLIENT_ID", "SAFE_TEST_CLIENT_SECRET");

    await sanitizeUpstreamPluginSnapshot("opencode-antigravity-auth", tempRoot);

    await expect(
      readFile(path.join(tempRoot, "dist", "src", "constants.js"), "utf8"),
    ).resolves.toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
    await expect(
      readFile(path.join(tempRoot, "dist", "src", "constants.d.ts"), "utf8"),
    ).resolves.toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
  });

  it("redacts every published AGY OAuth credential copy", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeAgySnapshot(tempRoot, "SAFE_TEST_AGY_CLIENT_ID", "SAFE_TEST_AGY_CLIENT_SECRET");
    await sanitizeUpstreamPluginSnapshot("opencode-agy-auth", tempRoot);
    await sanitizeUpstreamPluginSnapshot("opencode-agy-auth", tempRoot);

    for (const relativePath of ["dist/src/constants.d.ts", "dist/index.js", "dist/index.js.map"]) {
      const content = await readFile(path.join(tempRoot, relativePath), "utf8");
      expect(content).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
      expect(content).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
      expect(content).not.toContain("SAFE_TEST_AGY_CLIENT_ID");
      expect(content).not.toContain("SAFE_TEST_AGY_CLIENT_SECRET");
    }
  });

  it("fails closed when an AGY credential remains in an unexpected published file", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeAgySnapshot(tempRoot, "SAFE_TEST_AGY_CLIENT_ID", "SAFE_TEST_AGY_CLIENT_SECRET");
    await sanitizeUpstreamPluginSnapshot("opencode-agy-auth", tempRoot);
    await writeFile(
      path.join(tempRoot, "unexpected.js"),
      'const duplicate = "GOCSPX-SAFE_TEST_AGY_CLIENT_SECRET";\n',
      "utf8",
    );

    await expect(sanitizeUpstreamPluginSnapshot("opencode-agy-auth", tempRoot)).rejects.toThrow(
      "Found unsanitized AGY OAuth credential",
    );
  });

  it("fails closed when the AGY bundle assignment shape changes", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeAgySnapshot(tempRoot, "SAFE_TEST_AGY_CLIENT_ID", "SAFE_TEST_AGY_CLIENT_SECRET");
    await writeFile(
      path.join(tempRoot, "dist", "index.js"),
      'const renamedClient = "SAFE_TEST_AGY_CLIENT_ID";\n',
      "utf8",
    );

    await expect(sanitizeUpstreamPluginSnapshot("opencode-agy-auth", tempRoot)).rejects.toThrow(
      "Expected AGY_CLIENT_ID",
    );
  });

  it("redacts embedded Google OAuth values from Gemini CLI auth snapshots", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeGeminiConstants(tempRoot, "SAFE_TEST_CLIENT_ID", "SAFE_TEST_CLIENT_SECRET");
    await writeGeminiDistBundle(tempRoot, "SAFE_TEST_CLIENT_ID", "SAFE_TEST_CLIENT_SECRET");

    await sanitizeUpstreamPluginSnapshot("opencode-gemini-auth", tempRoot);

    const constantsSource = await readFile(path.join(tempRoot, "src", "constants.ts"), "utf8");
    expect(constantsSource).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
    expect(constantsSource).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");

    const distSource = await readFile(path.join(tempRoot, "dist", "index.js"), "utf8");
    expect(distSource).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
    expect(distSource).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");

    const sourceMap = await readFile(path.join(tempRoot, "dist", "index.js.map"), "utf8");
    expect(sourceMap).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
    expect(sourceMap).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
    expect(sourceMap).not.toContain("SAFE_TEST_CLIENT_ID");
    expect(sourceMap).not.toContain("SAFE_TEST_CLIENT_SECRET");
  });

  it("fails closed when Gemini OAuth targets are all absent", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await expect(sanitizeUpstreamPluginSnapshot("opencode-gemini-auth", tempRoot)).rejects.toThrow(
      "Expected GEMINI_CLIENT_ID and GEMINI_CLIENT_SECRET",
    );
  });

  it("redacts Gemini CLI auth snapshots when constants use single quotes", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    const constantsDir = path.join(tempRoot, "src");
    await mkdir(constantsDir, { recursive: true });
    await writeFile(
      path.join(constantsDir, "constants.ts"),
      "export const GEMINI_CLIENT_ID = 'SAFE_TEST_CLIENT_ID';\nexport const GEMINI_CLIENT_SECRET = 'SAFE_TEST_CLIENT_SECRET';\n",
      "utf8",
    );

    await sanitizeUpstreamPluginSnapshot("opencode-gemini-auth", tempRoot);

    const constantsSource = await readFile(path.join(tempRoot, "src", "constants.ts"), "utf8");
    expect(constantsSource).toContain(
      "'REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com'",
    );
    expect(constantsSource).toContain("'REDACTED_GOOGLE_OAUTH_CLIENT_SECRET'");
  });

  it("fails closed when an expected secret assignment disappears", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    const constantsDir = path.join(tempRoot, "dist", "src");
    await mkdir(constantsDir, { recursive: true });
    await writeFile(
      path.join(constantsDir, "constants.js"),
      'export const OTHER = "value";\n',
      "utf8",
    );
    await writeFile(
      path.join(constantsDir, "constants.d.ts"),
      'export declare const OTHER = "value";\n',
      "utf8",
    );

    await expect(
      sanitizeUpstreamPluginSnapshot("opencode-antigravity-auth", tempRoot),
    ).rejects.toThrow("Expected ANTIGRAVITY_CLIENT_ID");
  });

  it("rewrites unsafe Cursor OAuth snapshot guards into the safe local form", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, {
      modelsSource: UNSAFE_CURSOR_MODELS_SOURCE,
      proxySource: UNSAFE_CURSOR_PROXY_SOURCE,
    });

    await sanitizeUpstreamPluginSnapshot("opencode-cursor-oauth", tempRoot);

    const modelsSource = await readFile(path.join(tempRoot, "dist", "models.js"), "utf8");
    expect(modelsSource).toContain("if (discovered && discovered.length > 0) {");
    expect(modelsSource).toContain("cachedModels = discovered;");
    expect(modelsSource).toContain("return FALLBACK_MODELS;");
    expect(modelsSource).not.toContain(
      "cachedModels = discovered && discovered.length > 0 ? discovered : FALLBACK_MODELS;",
    );

    const proxySource = await readFile(path.join(tempRoot, "dist", "proxy.js"), "utf8");
    expect(proxySource).toContain('.filter((m) => m.role !== "tool")');
    expect(proxySource).toContain("messages: normalizedMessages");
    expect(proxySource).not.toContain(
      'const firstUserMsg = messages.find((m) => m.role === "user");',
    );
    expect(proxySource).not.toContain("firstUserText.slice(0, 200)");
  });

  it("sanitizes the tracked Cursor snapshot even when the published package name is scoped", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, {
      modelsSource: UNSAFE_CURSOR_MODELS_SOURCE,
      packageName: "@playwo/opencode-cursor-oauth",
      proxySource: UNSAFE_CURSOR_PROXY_SOURCE,
    });

    await sanitizeUpstreamPluginSnapshot("opencode-cursor-oauth", tempRoot);

    await expect(readFile(path.join(tempRoot, "dist", "models.js"), "utf8")).resolves.toContain(
      "if (discovered && discovered.length > 0) {",
    );
    await expect(readFile(path.join(tempRoot, "dist", "proxy.js"), "utf8")).resolves.toContain(
      "messages: normalizedMessages",
    );
  });

  it("leaves already-safe Cursor OAuth snapshot guards unchanged", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, {
      modelsSource: SAFE_CURSOR_MODELS_SOURCE,
      proxySource: SAFE_CURSOR_PROXY_SOURCE,
    });

    await sanitizeUpstreamPluginSnapshot("opencode-cursor-oauth", tempRoot);

    await expect(readFile(path.join(tempRoot, "dist", "models.js"), "utf8")).resolves.toBe(
      SAFE_CURSOR_MODELS_SOURCE,
    );
    await expect(readFile(path.join(tempRoot, "dist", "proxy.js"), "utf8")).resolves.toBe(
      SAFE_CURSOR_PROXY_SOURCE,
    );
  });

  it("fails closed when a Cursor OAuth guard shape changes unexpectedly", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, {
      modelsSource: SAFE_CURSOR_MODELS_SOURCE,
      proxySource: `function deriveBridgeKey(modelId, messages) {
    return modelId + ":" + messages.length;
}
`,
    });

    await expect(sanitizeUpstreamPluginSnapshot("opencode-cursor-oauth", tempRoot)).rejects.toThrow(
      "Expected CURSOR_TRANSCRIPT_BRIDGE_KEY",
    );
  });

  it("fails closed when only one Cursor proxy key derivation is sanitized", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, {
      modelsSource: SAFE_CURSOR_MODELS_SOURCE,
      proxySource: PARTIALLY_SAFE_CURSOR_PROXY_SOURCE,
    });

    await expect(sanitizeUpstreamPluginSnapshot("opencode-cursor-oauth", tempRoot)).rejects.toThrow(
      "Expected CURSOR_TRANSCRIPT_BRIDGE_KEY",
    );
  });
});
