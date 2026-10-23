import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  API_KEY_VENDORS,
  readProviderConfigString,
  resolveApiKeyFromEnvAndConfig,
} from "../src/lib/api-key-resolver.js";
import {
  globalConfigWriteTarget,
  openCodeConfigFiles,
  readOpenCodeConfigs,
} from "../src/lib/opencode-config-files.js";
import { useOpencodeFolders } from "./helpers/opencode-folders.js";

const folders = useOpencodeFolders();

/** Both config file names in `folder`, in OpenCode's order. */
const both = (folder: string) => [join(folder, "opencode.json"), join(folder, "opencode.jsonc")];

describe("OpenCode config files", () => {
  let globalDir: string;
  /** A repository; the session runs in its `app` folder. */
  let repoDir: string;
  let appDir: string;

  beforeEach(() => {
    vi.stubEnv("HOME", folders.root);
    vi.stubEnv("OPENCODE_CONFIG", undefined);
    vi.stubEnv("OPENCODE_CONFIG_PROJECT_DISABLE", undefined);
    vi.stubEnv("OPENCODE_DISABLE_PROJECT_CONFIG", undefined);
    vi.stubEnv("DEEPSEEK_API_KEY", undefined);
    globalDir = folders.configDir;
    repoDir = join(folders.root, "repo");
    appDir = join(repoDir, "app");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
  });

  it("lists the global files, every folder from the root down, then every .opencode folder", () => {
    mkdirSync(join(repoDir, ".opencode"));
    mkdirSync(join(appDir, ".opencode"));
    // Not a folder, so not an .opencode folder.
    writeFileSync(join(folders.root, ".opencode"), "");

    const files = openCodeConfigFiles(appDir);

    expect(files.slice(0, 2)).toEqual(both(globalDir));
    expect(files.slice(-10)).toEqual([
      ...both(folders.root),
      ...both(repoDir),
      ...both(appDir),
      ...both(join(repoDir, ".opencode")),
      ...both(join(appDir, ".opencode")),
    ]);
  });

  it("puts the OPENCODE_CONFIG file after the global files and before the project files", () => {
    const explicit = join(folders.root, "custom.json");
    vi.stubEnv("OPENCODE_CONFIG", explicit);

    const files = openCodeConfigFiles(appDir);

    expect(files.slice(0, 3)).toEqual([...both(globalDir), explicit]);
    expect(files.slice(-2)).toEqual(both(appDir));
  });

  it.each([
    [{ OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, false],
    [{ OPENCODE_DISABLE_PROJECT_CONFIG: "TRUE" }, false],
    [{ OPENCODE_CONFIG_PROJECT_DISABLE: "true" }, false],
    [{ OPENCODE_DISABLE_PROJECT_CONFIG: "yes" }, true],
    // OpenCode reads OPENCODE_CONFIG_PROJECT_DISABLE first when it is set.
    [{ OPENCODE_CONFIG_PROJECT_DISABLE: "0", OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, true],
  ])("with %j, project files count: %s", (env, projectCounts) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);

    const files = openCodeConfigFiles(appDir);

    expect(files.includes(join(appDir, "opencode.json"))).toBe(projectCounts);
    expect(files.slice(0, 2)).toEqual(both(globalDir));
  });

  it("lists only the global files for a session in the global folder", () => {
    expect(openCodeConfigFiles(globalDir)).toEqual(both(globalDir));
  });

  it("leaves out project paths that are the global folder or its files", () => {
    writeFileSync(join(globalDir, "opencode.json"), "{}\n");
    symlinkSync(join(globalDir, "opencode.json"), join(appDir, "opencode.json"));
    symlinkSync(globalDir, join(repoDir, ".opencode"));

    const files = openCodeConfigFiles(appDir);

    expect(files).not.toContain(join(appDir, "opencode.json"));
    expect(files).toContain(join(appDir, "opencode.jsonc"));
    expect(files.filter((path) => path.includes(".opencode"))).toEqual([]);
  });

  it("reads comments, trailing commas and CRLF in both kinds, and skips files that do not parse", async () => {
    writeFileSync(
      join(globalDir, "opencode.json"),
      '{\r\n  // global\r\n  "theme": "dark",\r\n  "plugin": ["a",],\r\n}\r\n',
    );
    writeFileSync(join(globalDir, "opencode.jsonc"), "{ nope");
    writeFileSync(join(repoDir, "opencode.json"), "[1, 2]");
    writeFileSync(join(appDir, "opencode.jsonc"), '/* app */ { "theme": "light", }');

    await expect(readOpenCodeConfigs(appDir)).resolves.toEqual([
      { path: join(globalDir, "opencode.json"), config: { theme: "dark", plugin: ["a"] } },
      { path: join(appDir, "opencode.jsonc"), config: { theme: "light" } },
    ]);
  });

  it.each([
    ["neither file", [], "opencode.jsonc", false],
    ["only opencode.json", ["opencode.json"], "opencode.json", true],
    ["only opencode.jsonc", ["opencode.jsonc"], "opencode.jsonc", true],
    ["both files", ["opencode.json", "opencode.jsonc"], "opencode.jsonc", true],
  ] as const)("writes the global config with %s to %s", (_label, existing, name, existed) => {
    for (const file of existing) writeFileSync(join(globalDir, file), "{}\n");

    expect(globalConfigWriteTarget()).toEqual({
      path: join(globalDir, name),
      format: name === "opencode.jsonc" ? "jsonc" : "json",
      existed,
    });
  });

  it("writes the global opencode.json when opencode.jsonc is not a file", () => {
    mkdirSync(join(globalDir, "opencode.jsonc"));
    writeFileSync(join(globalDir, "opencode.json"), "{}\n");

    expect(globalConfigWriteTarget()).toEqual({
      path: join(globalDir, "opencode.json"),
      format: "json",
      existed: true,
    });
  });

  it("takes an API key and a project id from the file OpenCode ranks highest", async () => {
    const files = {
      global: join(globalDir, "opencode.jsonc"),
      repo: join(repoDir, "opencode.json"),
      appJson: join(appDir, "opencode.json"),
      appJsonc: join(appDir, "opencode.jsonc"),
      dotFolder: join(repoDir, ".opencode", "opencode.json"),
    };
    mkdirSync(join(repoDir, ".opencode"));
    for (const [name, path] of Object.entries(files)) {
      writeFileSync(
        path,
        JSON.stringify({ provider: { deepseek: { options: { apiKey: `${name}-key` } } } }),
      );
    }
    writeFileSync(
      join(appDir, "opencode.json"),
      '{\n  // the app\'s Google project\n  "provider": { "google": { "options": { "projectId": "app-project" } },\n    "deepseek": { "options": { "apiKey": "appJson-key" } } },\n}\n',
    );
    const key = async () =>
      (await resolveApiKeyFromEnvAndConfig(API_KEY_VENDORS.deepseek, appDir))?.key;

    // A .opencode folder ranks above every folder's own files.
    expect(await key()).toBe("dotFolder-key");
    rmSync(files.dotFolder);
    // In one folder, opencode.jsonc ranks above opencode.json.
    expect(await key()).toBe("appJsonc-key");
    rmSync(files.appJsonc);
    expect(await key()).toBe("appJson-key");
    rmSync(files.appJson);
    // A folder above the session ranks above the global files.
    expect(await key()).toBe("repo-key");
    rmSync(files.repo);
    expect(await key()).toBe("global-key");

    writeFileSync(
      files.appJson,
      '{ "provider": { "google": { "options": { "projectId": "app-project" } } } }',
    );
    await expect(readProviderConfigString("google", "projectId", appDir)).resolves.toBe(
      "app-project",
    );
    await expect(readProviderConfigString("google", "projectId", repoDir)).resolves.toBeUndefined();
  });

  describe("a key and a project id a closer file sets win even when cleared, as in OpenCode", () => {
    beforeEach(() => {
      writeFileSync(
        join(globalDir, "opencode.jsonc"),
        JSON.stringify({
          providers: {
            deepseek: { settings: { apiKey: "global-key" } },
            google: { settings: { projectId: "global-project" } },
          },
        }),
      );
    });
    const key = async (directory: string) =>
      resolveApiKeyFromEnvAndConfig(API_KEY_VENDORS.deepseek, directory);

    it.each([
      [
        "null",
        {
          providers: {
            deepseek: { settings: { apiKey: null } },
            google: { settings: { projectId: null } },
          },
        },
      ],
      [
        '""',
        {
          providers: {
            deepseek: { settings: { apiKey: "" } },
            google: { settings: { projectId: "" } },
          },
        },
      ],
      [
        '"" in the legacy form',
        {
          provider: {
            deepseek: { options: { apiKey: "" } },
            google: { options: { projectId: "" } },
          },
        },
      ],
    ])("a project file that sets them to %s clears them", async (_label, project) => {
      writeFileSync(join(appDir, "opencode.json"), JSON.stringify(project));

      await expect(key(appDir)).resolves.toBeNull();
      await expect(
        readProviderConfigString("google", "projectId", appDir),
      ).resolves.toBeUndefined();
      // The repository folder, above that file, still gets the global values.
      await expect(key(repoDir)).resolves.toEqual({ key: "global-key", source: "opencode.jsonc" });
      await expect(readProviderConfigString("google", "projectId", repoDir)).resolves.toBe(
        "global-project",
      );
    });

    it("a legacy project entry OpenCode drops sets nothing, so the global values stay", async () => {
      writeFileSync(
        join(appDir, "opencode.json"),
        JSON.stringify({
          provider: {
            deepseek: { options: { apiKey: null } },
            google: { options: { projectId: "project-id", baseURL: null } },
          },
        }),
      );

      await expect(key(appDir)).resolves.toEqual({ key: "global-key", source: "opencode.jsonc" });
      await expect(readProviderConfigString("google", "projectId", appDir)).resolves.toBe(
        "global-project",
      );
    });

    it("a project file that leaves them out keeps the global values", async () => {
      writeFileSync(
        join(appDir, "opencode.json"),
        JSON.stringify({
          providers: { deepseek: { name: "DeepSeek" }, google: { settings: { location: "eu" } } },
        }),
      );

      await expect(key(appDir)).resolves.toEqual({ key: "global-key", source: "opencode.jsonc" });
      await expect(readProviderConfigString("google", "projectId", appDir)).resolves.toBe(
        "global-project",
      );
    });
  });
});
