import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveEditableConfigPath } from "../src/lib/config-file-utils.js";
import {
  applyConfigDocumentEdit,
  editConfigDocument,
  parseConfigDocument,
  planConfigDocumentEdit,
} from "../src/lib/opencode-config-editor.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-config-editor-"));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("OpenCode JSON/JSONC config editor", () => {
  it("previews JSON to JSONC conversion, preserves settings, and removes JSON only after success", async () => {
    const dir = makeTempDir();
    const jsonPath = join(dir, "opencode.json");
    const jsoncPath = join(dir, "opencode.jsonc");
    const original = {
      theme: "dark",
      provider: {
        openrouter: {
          options: {
            apiKey: "{env:OPENROUTER_API_KEY}",
          },
        },
      },
    };
    writeFileSync(jsonPath, JSON.stringify(original, null, 2) + "\n", "utf8");

    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "jsonc",
      convertJsonToJsonc: true,
    });
    const plan = await planConfigDocumentEdit({
      target,
      desiredData: {
        ...original,
        plugin: ["@slkiser/opencode-quota@latest"],
      },
      managedComments: [
        {
          path: ["plugin"],
          text: "// OpenCode Quota: loads the server plugin for slash commands and quota checks.",
        },
      ],
    });

    expect(plan.path).toBe(jsoncPath);
    expect(plan.removeSourcePath).toBe(jsonPath);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(jsoncPath)).toBe(false);
    expect(plan.updated).toContain('"theme": "dark"');
    expect(plan.updated).toContain("// OpenCode Quota:");

    await applyConfigDocumentEdit(plan);

    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(jsoncPath)).toBe(true);
    expect(readFileSync(jsoncPath, "utf8")).toContain("{env:OPENROUTER_API_KEY}");
  });

  it("preserves JSONC comments and trailing commas without duplicating managed comments", async () => {
    const dir = makeTempDir();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(
      path,
      `{
  // user-owned setting
  "theme": "dark",
  // OpenCode Quota: loads the server plugin for slash commands and quota checks.
  "plugin": ["other-plugin",],
}
`,
      "utf8",
    );

    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "jsonc",
      convertJsonToJsonc: true,
    });
    const desiredData = {
      theme: "dark",
      plugin: ["other-plugin", "@slkiser/opencode-quota@latest"],
    };
    const comments = [
      {
        path: ["plugin"],
        text: "// OpenCode Quota: loads the server plugin for slash commands and quota checks.",
      },
    ];

    const first = await planConfigDocumentEdit({
      target,
      desiredData,
      managedComments: comments,
    });
    await applyConfigDocumentEdit(first);

    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("// user-owned setting");
    expect(updated).toContain('"other-plugin",');
    expect(updated.match(/OpenCode Quota: loads the server plugin/g)).toHaveLength(1);

    const second = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir,
        kind: "opencode",
        preferredFormat: "jsonc",
        convertJsonToJsonc: true,
      }),
      desiredData,
      managedComments: comments,
    });
    expect(second.changed).toBe(false);
  });

  it("edits same-length arrays to exactly the desired entries and keeps comments between them", () => {
    const raw = `{
  "plugin": [
    // Comment between plugin entries
    "other-plugin@1.0.0",
    ["quota-plugin@latest", {
      // Option comment
      "keep": true,
      "drop": true,
      "nested": { "keep": 1, "drop": 2 }
    }]
  ],
  "list": [
    // Comment between list entries
    {
      "id": "a",
      "drop": "old",
      "map": { "keep": "1", "drop": "2" },
      "windows": [{ "id": "w1", "extra": { "keep": 1, "drop": 2 } }]
    },
    "becomes-object",
    { "becomes": "array" },
    [{ "id": "x", "drop": true }]
  ]
}
`;
    const desiredData = {
      plugin: ["other-plugin@1.0.0", ["quota-plugin@4", { keep: true, nested: { keep: 1 } }]],
      list: [
        {
          id: "a",
          map: { keep: "1", added: "3" },
          windows: [{ id: "w1", extra: { keep: 1 } }, { id: "w2" }],
        },
        { id: "now-object" },
        ["now", "array"],
        [{ id: "x" }],
      ],
    };

    const updated = editConfigDocument({
      raw,
      sourceFormat: "jsonc",
      outputFormat: "jsonc",
      path: "opencode.jsonc",
      desiredData,
    });

    expect(parseConfigDocument(updated, "jsonc", "opencode.jsonc")).toEqual(desiredData);
    expect(updated).toContain("// Comment between plugin entries");
    expect(updated).toContain("// Option comment");
    expect(updated).toContain("// Comment between list entries");
  });

  it("keeps an existing JSONC filename when JSON is selected later", async () => {
    const dir = makeTempDir();
    const path = join(dir, "opencode.jsonc");
    writeFileSync(path, '{\n  // keep\n  "plugin": ["other"],\n}\n', "utf8");

    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "json",
      convertJsonToJsonc: true,
    });

    expect(target).toMatchObject({
      path,
      sourcePath: path,
      format: "jsonc",
      existed: true,
    });
    expect(target.removeSourcePath).toBeUndefined();
  });

  it("writes valid strict JSON without comments when JSON is selected", async () => {
    const dir = makeTempDir();
    const target = resolveEditableConfigPath({
      dir,
      kind: "opencode",
      preferredFormat: "json",
      convertJsonToJsonc: true,
    });
    const plan = await planConfigDocumentEdit({
      target,
      desiredData: {
        $schema: "https://opencode.ai/config.json",
        plugin: ["@slkiser/opencode-quota@latest"],
      },
      managedComments: [
        {
          path: ["plugin"],
          text: "// OpenCode Quota: this must not appear in strict JSON.",
        },
      ],
    });

    expect(plan.path).toBe(join(dir, "opencode.json"));
    expect(() => JSON.parse(plan.updated)).not.toThrow();
    expect(plan.updated).not.toMatch(/^\s*\/\//m);

    await applyConfigDocumentEdit(plan);
    expect(() => JSON.parse(readFileSync(plan.path, "utf8"))).not.toThrow();
  });

  it("keeps the original JSON when the atomic target write fails", async () => {
    const dir = makeTempDir();
    const jsonPath = join(dir, "opencode.json");
    writeFileSync(jsonPath, '{"theme":"dark"}\n', "utf8");
    const plan = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir,
        kind: "opencode",
        preferredFormat: "jsonc",
        convertJsonToJsonc: true,
      }),
      desiredData: {
        theme: "dark",
        plugin: ["@slkiser/opencode-quota@latest"],
      },
    });

    await expect(
      applyConfigDocumentEdit(plan, {
        writeText: async () => {
          throw new Error("write failed");
        },
      }),
    ).rejects.toThrow("write failed");

    expect(readFileSync(jsonPath, "utf8")).toBe('{"theme":"dark"}\n');
    expect(existsSync(join(dir, "opencode.jsonc"))).toBe(false);
  });

  it("rolls back the new JSONC target when removing the converted JSON fails", async () => {
    const dir = makeTempDir();
    const jsonPath = join(dir, "opencode.json");
    const jsoncPath = join(dir, "opencode.jsonc");
    writeFileSync(jsonPath, '{"theme":"dark"}\n', "utf8");
    const plan = await planConfigDocumentEdit({
      target: resolveEditableConfigPath({
        dir,
        kind: "opencode",
        preferredFormat: "jsonc",
        convertJsonToJsonc: true,
      }),
      desiredData: {
        theme: "dark",
        plugin: ["@slkiser/opencode-quota@latest"],
      },
    });

    await expect(
      applyConfigDocumentEdit(plan, {
        removePath: async (path) => {
          if (path === jsonPath) {
            throw new Error("remove failed");
          }
          rmSync(path, { force: true });
        },
      }),
    ).rejects.toThrow("Failed removing converted config source");

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(jsoncPath)).toBe(false);
  });
});
