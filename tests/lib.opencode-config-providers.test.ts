import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { writeTextAtomic } from "../src/lib/atomic-json.js";
import { extractProviderIdsFromParsedConfig } from "../src/lib/config-file-utils.js";
import { planConfigDocumentEdit } from "../src/lib/opencode-config-editor.js";
import {
  loadConfiguredProviderIds,
  reconcileDetectedProvidersInGlobalConfig,
} from "../src/lib/opencode-config-providers.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

// A write that fails, or a file that changes between the plan and the write, on request.
vi.mock("../src/lib/atomic-json.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/atomic-json.js")>();
  return { ...real, writeTextAtomic: vi.fn(real.writeTextAtomic) };
});
vi.mock("../src/lib/opencode-config-editor.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/opencode-config-editor.js")>();
  return { ...real, planConfigDocumentEdit: vi.fn(real.planConfigDocumentEdit) };
});

const folders = useOpencodeFolders();
const DETECTED_COMMENT =
  "// Detected deepseek authentication; opencode-quota added this global provider declaration.";

describe("opencode config provider discovery", () => {
  let globalConfigDir: string;
  /** A repository with OpenCode config at its root; the session runs in its `app` folder. */
  let repoDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    vi.stubEnv("HOME", folders.root);
    globalConfigDir = folders.configDir;
    repoDir = join(folders.root, "repo");
    workspaceDir = join(repoDir, "app");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
  });

  it("extracts root-level provider ids and ignores malformed provider sections", () => {
    expect(
      extractProviderIdsFromParsedConfig({
        provider: {
          " copilot ": {},
          openai: {},
          "": {},
        },
      }),
    ).toEqual(["copilot", "openai"]);

    expect(extractProviderIdsFromParsedConfig({ provider: [] })).toEqual([]);
    expect(extractProviderIdsFromParsedConfig({ tui: { provider: { copilot: {} } } })).toEqual([]);
  });

  it("loads provider ids from global and workspace opencode config files", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ provider: { copilot: {}, openai: {} } }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.jsonc"),
      '{\n  // workspace providers\n  "provider": { "openai": {}, "gemini-cli": {}, },\n}',
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([
      "copilot",
      "openai",
      "gemini-cli",
    ]);
  });

  it("infers provider ids from known companion plugin specs", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        plugin: [
          "opencode-gemini-auth",
          "cursor-opencode-provider/plugin/opencode2",
          "@slkiser/opencode-quota",
        ],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([
      "google-gemini-cli",
      "cursor",
    ]);
  });

  it("does not infer Cursor from OpenCode 1-only Cursor companion plugins", async () => {
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        plugin: [
          "@playwo/opencode-cursor-oauth",
          "opencode-cursor-oauth",
          "@rama_nigg/open-cursor",
        ],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([]);
  });

  it("deduplicates provider ids inferred from provider blocks and plugin specs", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ plugin: ["cursor-opencode-provider"] }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        provider: { "alibaba-coding-plan": {}, cursor: {} },
        plugin: [["cursor-opencode-provider/server", { enabled: true }]],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([
      "alibaba-coding-plan",
      "cursor",
    ]);
  });

  it("reads OpenCode 2 native providers and plugins alongside the legacy keys", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ providers: { deepseek: {} }, plugins: ["opencode-gemini-auth"] }),
      "utf8",
    );
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({
        provider: { openai: {} },
        plugins: [
          { package: "cursor-opencode-provider/plugin/opencode2", options: { enabled: true } },
        ],
      }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([
      "openai",
      "deepseek",
      "google-gemini-cli",
      "cursor",
    ]);
  });

  it("reads both files of a folder, the folders above the session and .opencode folders", async () => {
    writeFileSync(
      join(globalConfigDir, "opencode.json"),
      JSON.stringify({ provider: { globalJson: {} } }),
    );
    writeFileSync(join(globalConfigDir, "opencode.jsonc"), '{ "provider": { "globalJsonc": {} } }');
    writeFileSync(join(repoDir, "opencode.json"), '{ "provider": { "repoJson": {} } }');
    writeFileSync(join(workspaceDir, "opencode.json"), '{ "provider": { "appJson": {} } }');
    writeFileSync(join(workspaceDir, "opencode.jsonc"), '{ "provider": { "appJsonc": {} } }');
    mkdirSync(join(workspaceDir, ".opencode"));
    writeFileSync(
      join(workspaceDir, ".opencode", "opencode.jsonc"),
      '{ "provider": { "dotFolder": {} } }',
    );
    const projectFiles = [
      join(repoDir, "opencode.json"),
      join(workspaceDir, "opencode.json"),
      join(workspaceDir, "opencode.jsonc"),
      join(workspaceDir, ".opencode", "opencode.jsonc"),
    ];
    const before = projectFiles.map((path) => readFileSync(path, "utf8"));

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([
      "globalJson",
      "globalJsonc",
      "repoJson",
      "appJson",
      "appJsonc",
      "dotFolder",
    ]);
    expect(projectFiles.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("ignores missing, malformed, and parse-failing provider config files", async () => {
    writeFileSync(join(globalConfigDir, "opencode.json"), "{ nope", "utf8");
    writeFileSync(
      join(workspaceDir, "opencode.json"),
      JSON.stringify({ provider: ["copilot"] }),
      "utf8",
    );

    await expect(loadConfiguredProviderIds(workspaceDir)).resolves.toEqual([]);
  });
});

describe("adding detected providers to the global config", () => {
  let globalConfigDir: string;
  let globalJson: string;
  let globalJsonc: string;
  let repoDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    vi.stubEnv("HOME", folders.root);
    globalConfigDir = folders.configDir;
    globalJson = join(globalConfigDir, "opencode.json");
    globalJsonc = join(globalConfigDir, "opencode.jsonc");
    repoDir = join(folders.root, "repo");
    workspaceDir = join(repoDir, "app");
    mkdirSync(globalConfigDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
  });

  const addDeepSeek = () =>
    reconcileDetectedProvidersInGlobalConfig({
      directory: workspaceDir,
      detectedProviderIds: ["deepseek"],
    });

  it("adds detected providers to global JSONC only, once, and leaves project files unchanged", async () => {
    writeFileSync(
      globalJsonc,
      `{
        // Keep this global setting and comment.
        "theme": "system",
        "provider": {
          "global-only": {},
        },
      }
      `,
    );
    const projectFiles = {
      [join(workspaceDir, "opencode.jsonc")]: `{
        // Project declarations are read-only.
        "provider": {
          "openai": { "options": { "baseURL": "https://project.example.test" } },
        },
      }
      `,
      [join(repoDir, "opencode.json")]: '{ "theme": "dark" }\n',
    };
    for (const [path, text] of Object.entries(projectFiles)) writeFileSync(path, text);

    const result = await reconcileDetectedProvidersInGlobalConfig({
      directory: workspaceDir,
      detectedProviderIds: ["openai", "deepseek"],
    });

    expect(result).toMatchObject({
      path: globalJsonc,
      format: "jsonc",
      addedProviderIds: ["deepseek"],
      changed: true,
    });
    const globalAfter = readFileSync(globalJsonc, "utf8");
    expect(globalAfter).toContain("// Keep this global setting and comment.");
    expect(globalAfter.split(DETECTED_COMMENT)).toHaveLength(2);
    expect(parse(globalAfter)).toEqual({
      theme: "system",
      provider: { "global-only": {}, deepseek: {} },
    });
    for (const [path, text] of Object.entries(projectFiles)) {
      expect(readFileSync(path, "utf8")).toBe(text);
    }

    await expect(addDeepSeek()).resolves.toMatchObject({ addedProviderIds: [], changed: false });
    expect(readFileSync(globalJsonc, "utf8")).toBe(globalAfter);
  });

  it("adds nothing for a provider the global opencode.json declares next to an opencode.jsonc", async () => {
    writeFileSync(
      globalJson,
      JSON.stringify({ provider: { deepseek: { options: { apiKey: "{env:DEEPSEEK_API_KEY}" } } } }),
    );
    writeFileSync(globalJsonc, '{\n  "theme": "dark"\n}\n');

    await expect(addDeepSeek()).resolves.toMatchObject({
      path: globalJsonc,
      addedProviderIds: [],
      changed: false,
    });
    expect(readFileSync(globalJsonc, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
  });

  it.each([
    ["a parent folder's opencode.json", (repo: string) => join(repo, "opencode.json")],
    [
      "the session's .opencode folder",
      (repo: string) => join(repo, "app", ".opencode", "opencode.json"),
    ],
  ])("adds nothing for a provider declared in %s", async (_label, projectFile) => {
    const path = projectFile(repoDir);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{ "provider": { "deepseek": {} } }');

    await expect(addDeepSeek()).resolves.toMatchObject({ addedProviderIds: [], changed: false });
    expect(existsSync(globalJsonc)).toBe(false);
    expect(existsSync(globalJson)).toBe(false);
  });

  it("writes a global opencode.json with comments, trailing commas and CRLF, without a comment of its own", async () => {
    const original = '{\r\n  // my providers\r\n  "theme": "dark",\r\n  "provider": {},\r\n}\r\n';
    writeFileSync(globalJson, original);

    const result = await addDeepSeek();

    expect(result).toMatchObject({ path: globalJson, format: "json", changed: true });
    const after = readFileSync(globalJson, "utf8");
    expect(after).toContain("// my providers");
    expect(after).not.toContain("Detected");
    expect(after.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parse(after)).toEqual({ theme: "dark", provider: { deepseek: {} } });
    expect(existsSync(globalJsonc)).toBe(false);

    await expect(addDeepSeek()).resolves.toMatchObject({ changed: false });
    expect(readFileSync(globalJson, "utf8")).toBe(after);
  });

  it("creates a missing global config as opencode.jsonc, even next to a project opencode.json", async () => {
    const projectJson = join(workspaceDir, "opencode.json");
    writeFileSync(projectJson, '{ "theme": "dark" }\n');

    await expect(addDeepSeek()).resolves.toMatchObject({
      path: globalJsonc,
      format: "jsonc",
      addedProviderIds: ["deepseek"],
      changed: true,
    });
    const created = readFileSync(globalJsonc, "utf8");
    expect(created).toContain(DETECTED_COMMENT);
    expect(parse(created)).toEqual({ provider: { deepseek: {} } });
    if (process.platform !== "win32") expect(statSync(globalJsonc).mode & 0o777).toBe(0o600);
    expect(existsSync(globalJson)).toBe(false);
    expect(readFileSync(projectJson, "utf8")).toBe('{ "theme": "dark" }\n');
  });

  it("writes through a symlinked global opencode.jsonc and keeps the link", async () => {
    const real = join(folders.root, "dotfiles", "opencode.jsonc");
    mkdirSync(join(folders.root, "dotfiles"));
    writeFileSync(real, '{\n  // keep\n  "provider": {},\n}\n');
    symlinkSync(real, globalJsonc);

    await expect(addDeepSeek()).resolves.toMatchObject({ path: globalJsonc, changed: true });

    expect(lstatSync(globalJsonc).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("// keep");
    expect(parse(readFileSync(real, "utf8"))).toEqual({ provider: { deepseek: {} } });
  });

  it("writes through a chain of symlinks and keeps every link", async () => {
    const real = join(folders.root, "real.jsonc");
    const middle = join(folders.root, "middle.jsonc");
    writeFileSync(real, "{}\n");
    symlinkSync(real, middle);
    symlinkSync(middle, globalJsonc);

    await expect(addDeepSeek()).resolves.toMatchObject({ changed: true });

    expect(lstatSync(globalJsonc).isSymbolicLink()).toBe(true);
    expect(lstatSync(middle).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(real, "utf8"))).toEqual({ provider: { deepseek: {} } });
  });

  it("refuses a broken symlink instead of replacing it", async () => {
    symlinkSync(join(folders.root, "missing.jsonc"), globalJsonc);

    await expect(addDeepSeek()).rejects.toThrow(/Dangling config symlink/);

    expect(lstatSync(globalJsonc).isSymbolicLink()).toBe(true);
    expect(existsSync(join(folders.root, "missing.jsonc"))).toBe(false);
    expect(existsSync(globalJson)).toBe(false);
  });

  it("refuses to write when the file changes between its read and the write", async () => {
    writeFileSync(globalJsonc, "{}\n");
    const real = await vi.importActual<typeof import("../src/lib/opencode-config-editor.js")>(
      "../src/lib/opencode-config-editor.js",
    );
    vi.mocked(planConfigDocumentEdit).mockImplementationOnce(async (params) => {
      const plan = await real.planConfigDocumentEdit(params);
      writeFileSync(globalJsonc, '{ "theme": "changed meanwhile" }\n');
      return plan;
    });

    await expect(addDeepSeek()).rejects.toThrow(/changed since preview/);

    expect(readFileSync(globalJsonc, "utf8")).toBe('{ "theme": "changed meanwhile" }\n');
  });

  it("leaves global and project files unchanged when the write fails", async () => {
    writeFileSync(globalJsonc, '{\n  // keep\n  "provider": {},\n}\n');
    const projectJsonc = join(workspaceDir, "opencode.jsonc");
    writeFileSync(projectJsonc, '{\n  // project keep\n  "theme": "dark",\n}\n');
    vi.mocked(writeTextAtomic).mockRejectedValueOnce(new Error("disk full"));

    await expect(addDeepSeek()).rejects.toThrow("disk full");

    expect(readFileSync(globalJsonc, "utf8")).toBe('{\n  // keep\n  "provider": {},\n}\n');
    expect(readFileSync(projectJsonc, "utf8")).toBe(
      '{\n  // project keep\n  "theme": "dark",\n}\n',
    );
  });
});
