import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeTextAtomic } from "../src/lib/atomic-json.js";
import { resolveEditableConfigPath } from "../src/lib/config-file-utils.js";
import {
  applyConfigDocumentEdit,
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

const EMPTY_PLUGINS = '{"plugin":[]}\n';

type ManagedComments = Parameters<typeof planConfigDocumentEdit>[0]["managedComments"];

/** Plans an edit of the OpenCode config in `dir`; `preferredFormat` names a new file. */
function planEdit(
  dir: string,
  desiredData: Record<string, unknown>,
  preferredFormat: "json" | "jsonc" = "json",
  managedComments?: ManagedComments,
) {
  return planConfigDocumentEdit({
    target: resolveEditableConfigPath({ dir, kind: "opencode", preferredFormat }),
    desiredData,
    managedComments,
  });
}

/** Plans and applies an edit of the OpenCode config in `dir`, and returns its path. */
async function editConfig(
  dir: string,
  desiredData: Record<string, unknown>,
  preferredFormat: "json" | "jsonc" = "json",
): Promise<string> {
  const plan = await planEdit(dir, desiredData, preferredFormat);
  await applyConfigDocumentEdit(plan);
  return plan.path;
}

/** Makes `<root>/config` with `name` as a symlink to `linkText`. */
function linkConfig(root: string, linkText: string, name = "opencode.json") {
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const link = join(configDir, name);
  symlinkSync(linkText, link);
  return { configDir, link };
}

describe("OpenCode JSON/JSONC config editor", () => {
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

    await applyConfigDocumentEdit(await planEdit(dir, desiredData, "jsonc", comments));

    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("// user-owned setting");
    expect(updated).toContain('"other-plugin",');
    expect(updated.match(/OpenCode Quota: loads the server plugin/g)).toHaveLength(1);

    const second = await planEdit(dir, desiredData, "jsonc", comments);
    expect(second.changed).toBe(false);
  });

  it.each([
    { existing: "opencode.jsonc", preferredFormat: "json", format: "jsonc" },
    { existing: "opencode.json", preferredFormat: "jsonc", format: "json" },
  ] as const)(
    "keeps the existing $existing file when $preferredFormat is preferred",
    ({ existing, preferredFormat, format }) => {
      const dir = makeTempDir();
      const path = join(dir, existing);
      writeFileSync(path, '{"plugin":["other"]}\n', "utf8");

      expect(resolveEditableConfigPath({ dir, kind: "opencode", preferredFormat })).toEqual({
        path,
        format,
        existed: true,
      });
    },
  );

  it("creates a missing config as a regular strict-JSON file without comments", async () => {
    const dir = makeTempDir();
    const desiredData = {
      $schema: "https://opencode.ai/config.json",
      plugin: ["@slkiser/opencode-quota@latest"],
    };
    const plan = await planEdit(dir, desiredData, "json", [
      { path: ["plugin"], text: "// OpenCode Quota: this must not appear in strict JSON." },
    ]);

    expect(plan.path).toBe(join(dir, "opencode.json"));
    expect(JSON.parse(plan.updated)).toEqual(desiredData);
    expect(plan.updated).not.toMatch(/^\s*\/\//m);

    await applyConfigDocumentEdit(plan);
    expect(lstatSync(plan.path).isFile()).toBe(true);
    expect(lstatSync(plan.path).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(plan.path, "utf8"))).toEqual(desiredData);
  });
});

describe("config symlink-preserving writes", () => {
  it("updates a relative symlink target and leaves the link in place", async () => {
    const root = makeTempDir();
    const real = join(root, "dotfiles", "opencode.json");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(real, EMPTY_PLUGINS);
    const { configDir, link } = linkConfig(root, "../dotfiles/opencode.json");

    await editConfig(configDir, { plugin: ["a"] });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ plugin: ["a"] });
  });

  it("updates an absolute symlink and a chained pair", async () => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    const middle = join(root, "middle.json");
    writeFileSync(real, EMPTY_PLUGINS);
    symlinkSync(real, middle);
    const { configDir, link } = linkConfig(root, middle);

    await editConfig(configDir, { plugin: ["chained"] });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ plugin: ["chained"] });
  });

  it("preserves JSONC comments when writing through a symlink", async () => {
    const root = makeTempDir();
    const real = join(root, "dotfiles", "opencode.jsonc");
    mkdirSync(join(root, "dotfiles"));
    writeFileSync(
      real,
      `{
  // keep
  "plugin": ["other"],
}
`,
    );
    const { configDir, link } = linkConfig(root, real, "opencode.jsonc");

    await editConfig(configDir, { plugin: ["other", "@slkiser/opencode-quota@latest"] }, "jsonc");

    const updated = readFileSync(real, "utf8");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(updated).toContain("// keep");
    expect(updated).toContain("@slkiser/opencode-quota@latest");
  });

  it("fails closed when the link is retargeted after preview", async () => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    const other = join(root, "other.json");
    writeFileSync(real, EMPTY_PLUGINS);
    writeFileSync(other, EMPTY_PLUGINS);
    const { configDir, link } = linkConfig(root, real);

    const plan = await planEdit(configDir, { plugin: ["a"] });
    unlinkSync(link);
    symlinkSync(other, link);

    await expect(applyConfigDocumentEdit(plan)).rejects.toThrow(/write target changed/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(EMPTY_PLUGINS);
    expect(readFileSync(other, "utf8")).toBe(EMPTY_PLUGINS);
  });

  it("fails closed when destination bytes change after preview", async () => {
    const root = makeTempDir();
    const real = join(root, "real.json");
    writeFileSync(real, EMPTY_PLUGINS);
    const { configDir, link } = linkConfig(root, real);

    const plan = await planEdit(configDir, { plugin: ["a"] });
    writeFileSync(real, '{"plugin":[],"raced":true}\n');

    await expect(applyConfigDocumentEdit(plan)).rejects.toThrow(/changed since preview/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain('"raced":true');
  });

  it("fails closed on a dangling configured symlink instead of replacing it", async () => {
    const dir = makeTempDir();
    symlinkSync(join(dir, "missing.json"), join(dir, "opencode.json"));
    await expect(editConfig(dir, { plugin: ["x"] })).rejects.toThrow(/Dangling config symlink/);
    expect(lstatSync(join(dir, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });

  it("leaves writeTextAtomic replacing a symlink for non-config callers", async () => {
    const dir = makeTempDir();
    const real = join(dir, "state.json");
    const link = join(dir, "alias.json");
    writeFileSync(real, "{}\n");
    symlinkSync(real, link);
    await writeTextAtomic(link, '{"ok":true}\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(link, "utf8"))).toEqual({ ok: true });
    expect(readFileSync(real, "utf8")).toBe("{}\n");
  });
});
