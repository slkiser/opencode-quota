import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clientSettings,
  defaultSettings,
  editSettings,
  type LoadedSettings,
  loadSettings,
  type Settings,
  type SettingsWatch,
  saveSettings,
  settingsPath,
  watchSettings,
} from "../src/settings/index.js";
import { CHANGED_SINCE_REVIEW, SETTINGS_SCHEMA } from "../src/settings/schema.js";
import { VALID_QUOTA_PROVIDER_INPUTS, VALID_QUOTA_PROVIDERS } from "./fixtures/quota-providers.js";

let root: string;
let configDir: string;
const watches: SettingsWatch[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-"));
  configDir = join(root, "config");
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});

afterEach(async () => {
  for (const watch of watches.splice(0)) watch.close();
  await rm(root, { recursive: true, force: true });
});

function writeSettings(text: string): string {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** `{ "a": { "b": value } }` for the key "a.b". */
function nested(key: string, value: unknown): unknown {
  return key.split(".").reduceRight<unknown>((inner, part) => ({ [part]: inner }), value);
}

function valueAt(settings: object, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], settings);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > 5_000) throw new Error("timed out waiting");
    await sleep(20);
  }
}

/** Watches until the test ends; `seen` collects every callback. */
async function watchAll(
  debounceMs = 50,
): Promise<{ seen: LoadedSettings[]; watch: SettingsWatch }> {
  const seen: LoadedSettings[] = [];
  const watch = await watchSettings((loaded) => seen.push(loaded), { debounceMs });
  watches.push(watch);
  return { seen, watch };
}

describe("settingsPath", () => {
  it("uses OPENCODE_CONFIG_DIR, else XDG_CONFIG_HOME/opencode, never ~/.config", () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    expect(settingsPath()).toBe(join(configDir, "opencode-quota", "settings.jsonc"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", "");
    expect(settingsPath()).toBe(join(root, "xdg", "opencode", "opencode-quota", "settings.jsonc"));
  });
});

describe("loadSettings", () => {
  it("uses the defaults when the file is missing and writes nothing", async () => {
    const loaded = await loadSettings();

    expect(loaded).toMatchObject({ exists: false, issues: [], fromFile: [], notRead: [] });
    expect(loaded.settings).toEqual(defaultSettings());
    expect(existsSync(settingsPath())).toBe(false);
  });

  it("reads comments and trailing commas, and knows which keys the file set", async () => {
    writeSettings(`// my settings
{
  "version": 6,
  /* words */ "words": { "percent": "used", "reset": "short", },
  "providers": { "checking": { "requestTimeoutMs": 9000 }, "off": ["claude", "quota-providers"], "cursor": { "includedApiUsd": 20 } },
}
`);

    const loaded = await loadSettings();

    expect(loaded.issues).toEqual([]);
    expect(loaded.settings.words).toMatchObject({ percent: "used", reset: "short" });
    expect(loaded.settings.providers.off).toEqual(["anthropic", "custom"]);
    expect(loaded.settings.providers.cursor.includedApiUsd).toBe(20);
    // A key the file does not set has its default.
    expect(loaded.settings.toast.layout).toBe("grouped");
    // Providers with a longer own timeout use it unless the user set one.
    expect(loaded.fromFile).toContain("providers.checking.requestTimeoutMs");
    expect(loaded.fromFile).not.toContain("providers.checking.minIntervalMs");
  });

  it.each([
    ["words.percent", "huge"],
    ["providers.checking.minIntervalMs", 0],
    ["providers.cursor.billingCycleStartDay", 29],
    ["words.resetDecimals", 1.5],
    ["providers.anthropic.binaryPath", "  "],
    ["system.exportPath", "../quota.json"],
    ["providers.off", ["nope"]],
    ["version", 7],
  ])("an invalid %s keeps its default and is reported", async (key, value) => {
    writeSettings(JSON.stringify(nested(key, value)));

    const loaded = await loadSettings();

    expect(valueAt(loaded.settings, key)).toEqual(valueAt(defaultSettings(), key));
    expect(loaded.issues.map((issue) => issue.key)).toEqual([key]);
    expect(loaded.fromFile).not.toContain(key);
  });

  it.each([
    {
      file: '{ "words": { "percent": "used", "percent": "huge" } }',
      issue: { key: "words.percent", message: "duplicate key; the last valid value is used" },
      percent: "used",
    },
    {
      file: '{ "words": { "percent": "left" }, "words.percent": "used" }',
      issue: { key: "$top", message: "a key with a dot is not read (key 2); nest it instead" },
      percent: "left",
    },
  ])("reports $issue.key in $file and refuses to save until it is fixed", async (row) => {
    const path = writeSettings(row.file);

    const loaded = await loadSettings();
    const result = await saveSettings({ words: { percent: "bare" } });

    expect(loaded.settings.words.percent).toBe(row.percent);
    expect(loaded.issues[0]).toEqual(row.issue);
    expect(result).toMatchObject({ ok: false, diff: [] });
    const problem = row.issue.message.split(";")[0];
    expect(result.issues[0]?.message).toBe(
      `${path}: ${row.issue.key}: ${problem}; fix it first, nothing was saved`,
    );
    expect(readFileSync(path, "utf8")).toBe(row.file);
  });

  it("keeps the known provider ids and names the unknown ones", async () => {
    writeSettings('{ "providers": { "off": ["copilot", "nope"] } }');

    const loaded = await loadSettings();

    expect(loaded.settings.providers.off).toEqual(["copilot"]);
    expect(loaded.issues[0]?.message).toMatch(/^unknown provider id\(s\): nope; valid: .*copilot/);
  });

  // Built-in providers of 4.x and 5.x that this version does not have.
  it.each(["chutes", "kilo", "nanogpt", "nano-gpt", "synthetic"])(
    "loads and saves settings naming the former provider %s without an issue",
    async (id) => {
      const row = `${id}.daily`;
      writeSettings(
        JSON.stringify({
          providers: { off: [id, "copilot"] },
          sidebar: {
            hidden: [row],
            providerOrder: [id, "copilot"],
            rowOrder: { [id]: [row] },
            names: { [row]: "Mine" },
          },
          collapsed: { window: { [id]: "day" } },
        }),
      );

      const loaded = await loadSettings();
      const saved = await saveSettings({ providers: { off: [id, "openai"] } });

      expect(loaded.issues).toEqual([]);
      expect(loaded.settings.providers.off).toEqual(["copilot"]);
      expect(loaded.settings.sidebar.names).toEqual({ [row]: "Mine" });
      expect(saved).toMatchObject({ ok: true, issues: [] });
      expect((await loadSettings()).settings.providers.off).toEqual(["openai"]);
    },
  );

  it("reports unknown keys with the valid ones, and a group that is not an object", async () => {
    writeSettings('{ "wordz": {}, "words": { "percnt": "used" }, "providers": { "checking": 5 } }');

    const loaded = await loadSettings();

    expect(loaded.issues).toEqual([
      {
        key: "$top",
        message:
          "unknown setting (key 1); valid: version, sidebar, collapsed, statusLine, toast, colors, layout, words, providers, system",
      },
      {
        key: "words",
        message:
          "unknown setting (key 1); valid in words: percent, reset, resetDecimals, rowNames, detail, onlyCurrentModel, sessionTokens",
      },
      { key: "providers.checking", message: "expected an object" },
    ]);
    expect(loaded.settings).toEqual(defaultSettings());
  });

  it("loads valid custom providers and reports a bad one under providers.custom", async () => {
    writeSettings(JSON.stringify({ providers: { custom: VALID_QUOTA_PROVIDER_INPUTS } }));
    expect((await loadSettings()).settings.providers.custom).toEqual(VALID_QUOTA_PROVIDERS);

    writeSettings(JSON.stringify({ providers: { custom: [{ id: "x", mode: "remote-api" }] } }));
    const loaded = await loadSettings();
    expect(loaded.settings.providers.custom).toEqual([]);
    expect(loaded.issues.length).toBeGreaterThan(0);
    expect(loaded.issues.every((issue) => issue.key.startsWith("providers.custom["))).toBe(true);
  });

  it("names the line of a syntax error and still uses what parses", async () => {
    writeSettings('{\n  "words": { "percent": "used" }\n  "providers": { "checking": {} }\n}\n');

    const loaded = await loadSettings();

    expect(loaded.settings.words.percent).toBe("used");
    expect(loaded.issues).toEqual([
      { key: "$file", message: "syntax error on line 3: CommaExpected" },
    ]);
  });
});

describe("saveSettings", () => {
  it("merges a patch, keeps comments and the other keys, and returns what changed", async () => {
    const path = writeSettings(
      '// my note\n{\n  "version": 6,\n  // keep me\n  "words": { "percent": "used" }\n}\n',
    );

    const result = await saveSettings({
      words: { reset: "short" },
      providers: { checking: { minIntervalMs: 60_000 } },
    });

    expect(result).toEqual({
      ok: true,
      issues: [],
      diff: [
        { key: "words.reset", before: "smart", after: "short" },
        { key: "providers.checking.minIntervalMs", before: 300_000, after: 60_000 },
      ],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("// my note");
    expect(text).toContain("// keep me");
    const loaded = await loadSettings();
    expect(loaded.settings.words).toMatchObject({ percent: "used", reset: "short" });
    expect(loaded.issues).toEqual([]);
  });

  it("resets a key to its default with null", async () => {
    const path = writeSettings('{ "words": { "percent": "used", "reset": "short" } }');

    const result = await saveSettings({ words: { percent: null } });

    expect(result.diff).toEqual([{ key: "words.percent", before: "used", after: "left" }]);
    expect(readFileSync(path, "utf8")).not.toContain("percent");
    expect((await loadSettings()).settings.words.reset).toBe("short");
  });

  it("creates a new file with a header comment and only the saved keys, mode 0600", async () => {
    const result = await saveSettings({ words: { percent: "bare" } });

    expect(result.ok).toBe(true);
    const text = readFileSync(settingsPath(), "utf8");
    expect(text).toMatch(/^\/\/ OpenCode Quota settings: only the ones you changed\./);
    expect(text).toContain("// Every setting and its default: https://");
    expect(parse(text)).toEqual({ version: 6, words: { percent: "bare" } });
    const loaded = await loadSettings();
    expect(loaded.settings.words.percent).toBe("bare");
    expect(loaded.fromFile).toEqual(["version", "words.percent"]);
    if (process.platform !== "win32") {
      expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    }
  });

  it("lets a later default change reach every key the file does not set", async () => {
    await saveSettings({ words: { percent: "bare" } });
    const rule = SETTINGS_SCHEMA["layout.evenUse"] as { default: boolean };
    const before = rule.default;

    rule.default = !before;
    try {
      expect((await loadSettings()).settings.layout.evenUse).toBe(!before);
    } finally {
      rule.default = before;
    }
    expect((await loadSettings()).settings.layout.evenUse).toBe(before);
  });

  it("leaves a file that lists every key as it is when loading, and saves one key into it", async () => {
    const full = `// OpenCode Quota settings, by section.\n${JSON.stringify(defaultSettings(), null, 2)}\n`;
    const path = writeSettings(full);

    const loaded = await loadSettings();

    expect(readFileSync(path, "utf8")).toBe(full);
    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.fromFile).toContain("layout.evenUse");
    expect(loaded.fromFile).toContain("system.telemetry");
    await saveSettings({ words: { percent: "used" } });
    expect(readFileSync(path, "utf8")).toBe(full.replace('"percent": "left"', '"percent": "used"'));
  });

  it.each([
    { name: "an unknown key", patch: { wordz: { percent: "used" } }, message: /valid: version/ },
    { name: "a bad value", patch: { words: { percent: "huge" } }, message: /expected one of/ },
    { name: "an unknown provider", patch: { providers: { off: ["nope"] } }, message: /nope/ },
    { name: "a group set to a value", patch: { words: "short" }, message: /expected an object/ },
    { name: "a patch that is not an object", patch: "words", message: /expected an object/ },
    { name: "a file-only key", patch: { providers: { custom: [] } }, message: /file-only/ },
    { name: "a group reset with a file-only key", patch: { system: null }, message: /file-only/ },
    {
      name: "a relative path, even with allowFileOnly",
      patch: { system: { exportPath: "../quota.json" } },
      allowFileOnly: true,
      message: /absolute or ~\/ path without "\.\."/,
    },
  ])("rejects $name and writes nothing", async ({ patch, allowFileOnly, message }) => {
    const path = writeSettings('{ "words": { "reset": "short" } }');

    const result = await saveSettings(patch, { allowFileOnly });

    expect(result.ok).toBe(false);
    expect(result.diff).toEqual([]);
    expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(message);
    expect(readFileSync(path, "utf8")).toBe('{ "words": { "reset": "short" } }');
  });

  it("saves a file-only key with allowFileOnly", async () => {
    const patch = { providers: { anthropic: { binaryPath: "~/bin/claude" } } };

    expect(await saveSettings(patch, { allowFileOnly: true })).toMatchObject({ ok: true });
    expect((await loadSettings()).settings.providers.anthropic.binaryPath).toBe("~/bin/claude");
  });

  describe("custom provider switches", () => {
    const [first, second] = VALID_QUOTA_PROVIDER_INPUTS;
    const file = (changes: object = {}) =>
      [
        "{",
        '  "providers": {',
        '    "custom": [',
        `      // first\n      ${JSON.stringify({ ...first, enabled: false })},`,
        `      // second\n      ${JSON.stringify({ ...second, enabled: false, ...changes })}`,
        "    ]",
        "  }",
        "}",
      ].join("\n");
    /** Switches the second provider on, as the user saw it in the file now. */
    const switchOnSecond = async () => {
      const shown = clientSettings(await loadSettings()).custom;
      const fingerprint = shown.find((entry) => entry.id === second.id)?.fingerprint ?? "";
      return { [second.id]: { enabled: true, fingerprint } };
    };

    it("sets only the named provider's enabled field, with the patch, and keeps comments", async () => {
      const path = writeSettings(file());

      const result = await saveSettings(
        { sidebar: { runsOut: true } },
        { customEnabled: await switchOnSecond() },
      );

      expect(result.ok).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("// first");
      expect(text).toContain("// second");
      const { settings } = await loadSettings();
      expect(settings.providers.custom.map((item) => [item.id, item.enabled])).toEqual([
        [first.id, false],
        [second.id, true],
      ]);
      expect(settings.sidebar.runsOut).toBe(true);
    });

    it("refuses to switch on a provider changed since the user reviewed it", async () => {
      writeSettings(file());
      const reviewed = await switchOnSecond();
      // An agent points the same id at another address and key.
      const path = writeSettings(file({ url: "https://other.example/quota", apiKeyEnv: "OTHER" }));
      const before = readFileSync(path, "utf8");

      const result = await saveSettings({}, { customEnabled: reviewed });

      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        { key: `providers.custom.${second.id}`, message: CHANGED_SINCE_REVIEW },
      ]);
      expect(readFileSync(path, "utf8")).toBe(before);
    });

    it.each([
      {
        name: "an id not in the file",
        switches: { "not-there": { enabled: true, fingerprint: "" } },
        message: /not in the file/,
      },
      {
        name: "a switch while the list has a problem",
        text: '{ "providers": { "custom": [{ "id": "broken" }] } }',
        switches: { broken: { enabled: true, fingerprint: "" } },
        message: /fix settings\.jsonc first/,
      },
    ])("refuses $name and writes nothing", async ({ text, switches, message }) => {
      const path = writeSettings(text ?? file());
      const before = readFileSync(path, "utf8");

      const result = await saveSettings(
        { sidebar: { runsOut: true } },
        { customEnabled: switches },
      );

      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(message);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  it("refuses to edit a file of a version it does not write", async () => {
    const path = writeSettings('{ "version": 7, "words": { "percent": "used" } }');

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/version: expected a whole number equal to 6; fix/);
    expect(readFileSync(path, "utf8")).toBe('{ "version": 7, "words": { "percent": "used" } }');
  });

  it("refuses to edit a file with a syntax error", async () => {
    const path = writeSettings('{ "words": { "percent": "used" ');

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/syntax error on line 1: \w+; fix it first/);
    expect(readFileSync(path, "utf8")).toBe('{ "words": { "percent": "used" ');
  });

  it("applies every patch when saves run at once, after taking over an old empty lock", async () => {
    const lock = `${writeSettings("{}")}.lock`;
    writeFileSync(lock, "");
    utimesSync(lock, 0, 0);
    expect((await saveSettings({ words: { percent: "used" } })).ok).toBe(true);

    const results = await Promise.all([
      saveSettings({ words: { reset: "short" } }),
      saveSettings({ words: { detail: "detailed" } }),
      saveSettings({ providers: { checking: { minIntervalMs: 60_000 } } }),
    ]);

    expect(results.map((result) => result.ok)).toEqual([true, true, true]);
    expect((await loadSettings()).settings).toMatchObject({
      words: { percent: "used", reset: "short", detail: "detailed" },
      providers: { checking: { minIntervalMs: 60_000 } },
    });
    expect(existsSync(lock)).toBe(false);
  });

  it.each([
    {
      owner: "a process that ended",
      pid: () => spawnSync(process.execPath, ["-e", ""]).pid,
      ok: true,
    },
    { owner: "a live process, however old the lock", pid: () => process.pid, ok: false },
  ])("takes over a lock held by $owner only when that owner is gone", async ({ pid, ok }) => {
    const lock = `${writeSettings("{}")}.lock`;
    const text = JSON.stringify({ pid: pid(), token: "theirs" });
    writeFileSync(lock, text);
    utimesSync(lock, 0, 0);

    const result = await saveSettings({ words: { percent: "used" } });

    expect(result.ok).toBe(ok);
    expect(result.issues[0]?.message ?? "").toMatch(ok ? /^$/ : /the settings file is busy/);
    expect(existsSync(lock) && readFileSync(lock, "utf8")).toBe(ok ? false : text);
  });

  it("takes over a dead owner's lock, whatever a crashed takeover left", async () => {
    const lock = `${writeSettings("{}")}.lock`;
    const deadOwner = () => JSON.stringify({ pid: spawnSync(process.execPath, ["-e", ""]).pid });
    writeFileSync(lock, deadOwner());
    // A waiter that died while it took the lock over.
    writeFileSync(`${lock}.claim`, deadOwner());

    expect((await saveSettings({ words: { percent: "used" } })).ok).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dirname(lock)).filter((name) => name.includes(".claim"))).toEqual([]);
  });

  it("writes and releases only while the lock still holds its own token", async () => {
    const path = writeSettings("{}");
    const lock = `${path}.lock`;
    const theirs = JSON.stringify({ pid: process.pid, token: "theirs" });

    // Another live save takes the lock over while this one plans its edit.
    const result = await editSettings(() => {
      writeFileSync(lock, theirs);
      return { words: { percent: "used" } };
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/the settings file is busy/);
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(readFileSync(lock, "utf8")).toBe(theirs);
  });

  it("builds each edit from the settings it saves over, so overlapping edits both survive", async () => {
    writeSettings('{ "providers": { "off": ["copilot"] } }');
    const add = (id: string) => (current: Settings) => ({
      providers: { off: [...(current.providers.off as string[]), id] },
    });

    const results = await Promise.all([editSettings(add("cursor")), editSettings(add("zai"))]);

    expect(results.map((result) => result.ok)).toEqual([true, true]);
    const enabled = (await loadSettings()).settings.providers.off;
    expect([...enabled].sort()).toEqual(["copilot", "cursor", "zai"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "writes through a symlink in a read-only folder, locks the target, and makes it 0600",
    async () => {
      const target = join(root, "dotfiles", "quota.jsonc");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '{\n  // from my dotfiles\n  "version": 6\n}\n');
      chmodSync(target, 0o644);
      mkdirSync(dirname(settingsPath()), { recursive: true });
      symlinkSync(target, settingsPath());
      chmodSync(dirname(settingsPath()), 0o500);
      let lockedTarget = false;

      const result = await editSettings(() => {
        lockedTarget = existsSync(`${target}.lock`);
        return { words: { reset: "short" } };
      }).finally(() => chmodSync(dirname(settingsPath()), 0o700));

      expect(result.ok).toBe(true);
      expect(lockedTarget).toBe(true);
      expect(lstatSync(settingsPath()).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toContain("// from my dotfiles");
      expect(readFileSync(target, "utf8")).toContain('"reset": "short"');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes only the file it locked: a link moved mid-save fails the save, nothing written",
    async () => {
      const [first, second] = ["first.jsonc", "second.jsonc"].map((name) => join(root, name));
      for (const file of [first, second]) writeFileSync(file, "{}\n");
      mkdirSync(dirname(settingsPath()), { recursive: true });
      symlinkSync(first, settingsPath());

      const result = await editSettings(() => {
        symlinkSync(second, `${settingsPath()}.new`);
        renameSync(`${settingsPath()}.new`, settingsPath());
        return { words: { percent: "used" } };
      });

      const message = `${settingsPath()} changed while saving; nothing was saved, try again`;
      expect(result).toEqual({ ok: false, issues: [{ key: "$file", message }], diff: [] });
      expect([readFileSync(first, "utf8"), readFileSync(second, "utf8")]).toEqual(["{}\n", "{}\n"]);
    },
  );
});

describe("watchSettings", () => {
  it("calls back once per edit, atomic replace, or key newly set to its default", async () => {
    const path = writeSettings('{ "words": { "percent": "used" } }');
    const { seen } = await watchAll();
    const steps = [
      () => writeFileSync(path, '{ "words": { "percent": "bare" } }'),
      () => {
        writeFileSync(`${path}.tmp`, '{ "words": { "percent": "remaining" } }');
        renameSync(`${path}.tmp`, path);
      },
      // The same settings, but now the file sets the timeout, so providers drop their own.
      () =>
        writeFileSync(
          path,
          '{ "words": { "percent": "remaining" }, "providers": { "checking": { "requestTimeoutMs": 5000 } } }',
        ),
    ];

    for (const [index, step] of steps.entries()) {
      step();
      await waitFor(() => seen.length === index + 1);
      await sleep(400);
      expect(seen).toHaveLength(index + 1);
    }
    const percents = seen.map((loaded) => loaded.settings.words.percent);
    expect(percents).toEqual(["bare", "remaining", "remaining"]);
    expect(seen[2]?.fromFile).toContain("providers.checking.requestTimeoutMs");
  });

  it("calls back once for a burst of writes, with the last one", async () => {
    const path = writeSettings("{}");
    const { seen } = await watchAll(250);

    for (const percent of ["used", "bare", "remaining"]) {
      writeFileSync(path, JSON.stringify({ words: { percent } }));
      await sleep(30);
    }
    await waitFor(() => seen.length === 1);
    await sleep(500);

    expect(seen.map((loaded) => loaded.settings.words.percent)).toEqual(["remaining"]);
  });

  it.skipIf(process.platform === "win32")(
    "sees an edit of a symlinked file's target, which only the stat poll notices",
    async () => {
      const target = join(root, "dotfiles", "quota.jsonc");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "{}");
      mkdirSync(dirname(settingsPath()), { recursive: true });
      symlinkSync(target, settingsPath());
      const { seen } = await watchAll();

      writeFileSync(target, '{ "words": { "percent": "used" } }');
      await waitFor(() => seen.length === 1);

      expect(seen[0]?.settings.words.percent).toBe("used");
    },
  );

  it("ignores other files in its folder, such as a v5 sidecar", async () => {
    const sidecar = join(dirname(settingsPath()), "quota-toast.jsonc");
    mkdirSync(dirname(sidecar), { recursive: true });
    writeFileSync(sidecar, '{ "percentDisplayMode": "used" }');
    const { seen } = await watchAll();

    writeFileSync(sidecar, '{ "percentDisplayMode": "remaining" }');
    await sleep(600);

    expect(seen).toEqual([]);
  });

  it("never calls back after close, even with a change pending", async () => {
    const path = writeSettings("{}");
    const { seen, watch } = await watchAll(300);

    writeFileSync(path, '{ "words": { "percent": "used" } }');
    await sleep(50);
    watch.close();
    // Past the debounce and a stat poll.
    await sleep(2_500);

    expect(seen).toEqual([]);
  });
});
