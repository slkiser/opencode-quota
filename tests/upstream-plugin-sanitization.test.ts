import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { sanitizeUpstreamPluginSnapshot } from "../scripts/lib/upstream-plugin-sanitization.mjs";

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

async function writeCursorSnapshot(pluginRoot: string, pricingSource: string) {
  const distDir = path.join(pluginRoot, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "pricing-data.js"), pricingSource, "utf8");
}

const CURSOR_PRICING_SOURCE = `export const CURSOR_MODEL_COSTS = {
    "claude-opus-5": {
        "input": 5,
        "output": 25
    }
};
`;

describe("upstream-plugin-sanitization", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
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

  it("redacts Google OAuth values from the Gemini CLI auth server bundle", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeGeminiDistBundle(tempRoot, "SAFE_TEST_CLIENT_ID", "SAFE_TEST_CLIENT_SECRET");
    const distDir = path.join(tempRoot, "dist");
    await writeFile(
      path.join(distDir, "server.js"),
      'var GEMINI_CLIENT_ID = "SAFE_TEST_CLIENT_ID";\nvar GEMINI_CLIENT_SECRET = "SAFE_TEST_CLIENT_SECRET";\n',
      "utf8",
    );
    await writeFile(
      path.join(distDir, "server.js.map"),
      JSON.stringify({
        sourcesContent: [
          'export const GEMINI_CLIENT_ID = "SAFE_TEST_CLIENT_ID";\nexport const GEMINI_CLIENT_SECRET = "SAFE_TEST_CLIENT_SECRET";\n',
        ],
      }),
      "utf8",
    );

    await sanitizeUpstreamPluginSnapshot("opencode-gemini-auth", tempRoot);

    for (const relativePath of ["dist/server.js", "dist/server.js.map"]) {
      const content = await readFile(path.join(tempRoot, relativePath), "utf8");
      expect(content).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com");
      expect(content).toContain("REDACTED_GOOGLE_OAUTH_CLIENT_SECRET");
      expect(content).not.toContain("SAFE_TEST_CLIENT_ID");
      expect(content).not.toContain("SAFE_TEST_CLIENT_SECRET");
    }
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

  it("leaves a credential-free Cursor snapshot unchanged", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(tempRoot, CURSOR_PRICING_SOURCE);

    await sanitizeUpstreamPluginSnapshot("cursor-opencode-provider", tempRoot);

    await expect(readFile(path.join(tempRoot, "dist", "pricing-data.js"), "utf8")).resolves.toBe(
      CURSOR_PRICING_SOURCE,
    );
  });

  it("fails closed when a Cursor API key lands in the snapshot", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(
      tempRoot,
      `${CURSOR_PRICING_SOURCE}const KEY = "crsr_${"a1".repeat(16)}";\n`,
    );

    await expect(
      sanitizeUpstreamPluginSnapshot("cursor-opencode-provider", tempRoot),
    ).rejects.toThrow("Found unsanitized Cursor credential");
  });

  it("fails closed when a Cursor access token lands in the snapshot", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-quota-sanitize-"));
    tempRoots.push(tempRoot);

    await writeCursorSnapshot(
      tempRoot,
      `${CURSOR_PRICING_SOURCE}const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.sig";\n`,
    );

    await expect(
      sanitizeUpstreamPluginSnapshot("cursor-opencode-provider", tempRoot),
    ).rejects.toThrow("Found unsanitized Cursor credential");
  });
});
