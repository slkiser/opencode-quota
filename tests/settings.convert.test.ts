import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getOpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";
import { oldSettingsFolders } from "../src/settings/convert.js";
import {
  convertV5,
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsPath,
} from "../src/settings/index.js";
import { PROVIDER_IDS, type SettingsPatch } from "../src/settings/schema.js";
import {
  quotaProvider,
  VALID_QUOTA_PROVIDER_INPUTS,
  VALID_QUOTA_PROVIDERS,
} from "./fixtures/quota-providers.js";

let root: string;
let configDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-settings-convert-"));
  configDir = join(root, "config");
  vi.stubEnv("OPENCODE_CONFIG_DIR", configDir);
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function writeFile(path: string, content: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

/** A v5 sidecar, `<dir>/opencode-quota/<name>`. */
function writeV5(content: unknown, name = "quota-toast.jsonc", dir = configDir): string {
  return writeFile(join(dir, "opencode-quota", name), content);
}

/** OpenCode's own config with a v5 `experimental.quotaToast` block. */
function writeHost(quotaToast: unknown, name = "opencode.json", dir = configDir): string {
  return writeFile(join(dir, name), { experimental: { quotaToast } });
}

function valueAt(settings: object, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], settings);
}

const GO_HIDDEN = { hidden: ["opencode-go.five_hour", "opencode-go.monthly"] };
const GO_SURFACES = Object.fromEntries(
  ["sidebar", "collapsed", "statusLine", "toast"].map((name) => [name, GO_HIDDEN]),
);

/** One row per v5 key (docs/v6-plan §5 table and §8 "where each v5 key went"). */
const ROWS: Array<{
  v5: Record<string, unknown>;
  server?: Record<string, unknown>;
  sections?: SettingsPatch;
  dropped?: string[];
}> = [
  { v5: { enabled: false }, dropped: ["enabled"] },
  { v5: { enableToast: false }, sections: { toast: { show: false } } },
  { v5: { showOnIdle: true }, sections: { toast: { afterReply: "always" } } },
  { v5: { showOnQuestion: true }, sections: { toast: { afterQuestion: true } } },
  { v5: { showOnCompact: false }, sections: { toast: { afterCompaction: false } } },
  { v5: { showOnBothFail: false }, sections: { toast: { whenAllFail: false } } },
  { v5: { toastDurationMs: 4_600 }, sections: { toast: { seconds: 5 } } },
  { v5: { resetNotifications: { enabled: true } }, sections: { toast: { resetNotice: "weekly" } } },
  {
    v5: { resetNotifications: { enabled: true, windows: ["daily", "weekly"] } },
    sections: { toast: { resetNotice: "all" } },
  },
  {
    v5: { resetNotifications: { enabled: false, windows: ["monthly"] } },
    sections: { toast: { resetNotice: "off" } },
  },
  { v5: { tuiCommandDisplay: "inline" }, dropped: ["tuiCommandDisplay"] },
  {
    v5: { formatStyle: "allWindows", toastStyle: "classic" },
    dropped: ["formatStyle", "toastStyle"],
    sections: { toast: { layout: "grouped" } },
  },
  { v5: { tuiSidebarPanel: { formatStyle: "grouped" } }, dropped: ["tuiSidebarPanel.formatStyle"] },
  {
    v5: { tuiCompactStatus: { formatStyle: "single" } },
    dropped: ["tuiCompactStatus.formatStyle"],
  },
  { v5: { percentDisplayMode: "used" }, server: { "words.percent": "used" } },
  { v5: { percentLabelStyle: "bare" }, server: { "words.percent": "bare" } },
  { v5: { accountingDetail: "detailed" }, server: { "words.detail": "detailed" } },
  { v5: { opencodeZenDisplay: "detailed" }, server: { "words.detail": "detailed" } },
  {
    v5: { opencodeZenDisplay: "detailed", accountingDetail: "summary" },
    server: { "words.detail": "summary" },
    dropped: ["opencodeZenDisplay"],
  },
  {
    v5: { quotaProjection: "runway" },
    sections: {
      sidebar: { runsOut: true },
      collapsed: { runsOut: true },
      statusLine: { runsOut: true },
      toast: { runsOut: true },
    },
  },
  {
    v5: { resetTimeDecimals: 2, resetTimeSpaced: false },
    server: { "words.reset": "decimal", "words.resetDecimals": 2 },
  },
  { v5: { resetTimeSpaced: false }, server: { "words.reset": "compact" } },
  { v5: { minIntervalMs: 60_000 }, server: { "providers.checking.minIntervalMs": 60_000 } },
  { v5: { requestTimeoutMs: 9_000 }, server: { "providers.checking.requestTimeoutMs": 9_000 } },
  { v5: { waitForQuotaReset: false }, server: { "providers.checking.waitForQuotaReset": false } },
  { v5: { debug: true }, dropped: ["debug"] },
  {
    v5: { enabledProviders: ["claude", "quota-providers", "copilot"] },
    server: {
      "providers.off": PROVIDER_IDS.filter(
        (id) => !["anthropic", "custom", "copilot"].includes(id),
      ),
    },
  },
  // Built-in providers of 4.x and 5.x that this version does not have.
  {
    v5: { enabledProviders: ["chutes", "kilo", "nanogpt", "nano-gpt", "synthetic", "copilot"] },
    server: { "providers.off": PROVIDER_IDS.filter((id) => id !== "copilot") },
  },
  {
    v5: { quotaProviders: VALID_QUOTA_PROVIDER_INPUTS },
    server: { "providers.custom": VALID_QUOTA_PROVIDERS },
  },
  {
    v5: { anthropicBinaryPath: " /opt/claude " },
    server: { "providers.anthropic.binaryPath": "/opt/claude" },
  },
  { v5: { cursorPlan: "pro" }, server: { "providers.cursor.plan": "pro" } },
  { v5: { cursorIncludedApiUsd: 25 }, server: { "providers.cursor.includedApiUsd": 25 } },
  { v5: { cursorBillingCycleStartDay: 3 }, server: { "providers.cursor.billingCycleStartDay": 3 } },
  { v5: { opencodeGoWindows: ["weekly"] }, sections: GO_SURFACES },
  { v5: { opencodeMonthlyLimit: 20 }, server: { "providers.opencode.monthlyLimitUsd": 20 } },
  {
    v5: { pricingSnapshot: { source: "bundled", autoRefresh: 3 } },
    server: { "providers.pricing.source": "bundled", "providers.pricing.autoRefreshDays": 3 },
  },
  { v5: { onlyCurrentModel: true }, server: { "words.onlyCurrentModel": true } },
  {
    v5: { showSessionTokens: false },
    sections: { sidebar: { sessionTokens: false }, toast: { sessionTokens: false } },
  },
  { v5: { sessionTokenScope: "tree" }, server: { "words.sessionTokens": "tree" } },
  {
    v5: { tuiSidebarPanel: { enabled: false } },
    sections: { sidebar: { show: false } },
  },
  {
    v5: { tuiSidebarPanel: { opencodeGoPreferredWindow: "rolling" } },
    sections: { collapsed: { window: { "opencode-go": "five_hour" } } },
  },
  {
    v5: { tuiCompactStatus: { enabled: true, homeBottom: false } },
    sections: { statusLine: { show: true, withSidebar: true, home: false } },
  },
  {
    v5: { tuiCompactStatus: { enabled: false } },
    sections: { statusLine: { show: false, withSidebar: false, home: false } },
  },
  {
    v5: { tuiPromptBar: { enabled: true } },
    sections: {
      statusLine: { show: true, withSidebar: true, home: false, detail: "one" },
    },
  },
  { v5: { tuiCompactStatus: { maxWidth: 80 } }, dropped: ["tuiCompactStatus.maxWidth"] },
  {
    v5: { maintainerAnnouncements: { enabled: false, home: false, homeFrequency: "always" } },
    dropped: [
      "maintainerAnnouncements.enabled",
      "maintainerAnnouncements.home",
      "maintainerAnnouncements.homeFrequency",
    ],
  },
  {
    v5: { layout: { maxWidth: 60, narrowAt: 40, tinyAt: 30 } },
    dropped: ["layout.maxWidth", "layout.narrowAt", "layout.tinyAt"],
  },
  {
    v5: { export: { enabled: true, path: "~/quota.json" } },
    server: { "system.exportFile": true, "system.exportPath": "~/quota.json" },
  },
  { v5: { telemetry: { enabled: true } }, server: { "system.telemetry": true } },
  { v5: { alibabaCodingPlanTier: "pro" }, dropped: ["alibabaCodingPlanTier"] },
  { v5: { customSources: [], someTypo: 1 }, dropped: ["customSources", "someTypo"] },
  { v5: { tuiCompactStatus: { suppressWhenNativeProviderQuota: true } } },
];

describe("convertV5, key by key", () => {
  it.each(ROWS)("$v5", async (row) => {
    writeV5(row.v5);

    const conversion = await convertV5();
    const loaded = await loadSettings();

    expect(conversion?.written).toBe(true);
    expect(conversion?.invalid).toEqual([]);
    if (row.sections) expect(loaded.settings).toMatchObject(row.sections);
    expect(conversion).not.toHaveProperty("displayImport");
    expect(conversion?.dropped.map((item) => item.key).sort()).toEqual(
      [...(row.dropped ?? [])].sort(),
    );
    expect(loaded.exists).toBe(true);
    expect(loaded.issues).toEqual([]);
    for (const [key, value] of Object.entries(row.server ?? {})) {
      expect(valueAt(loaded.settings, key), key).toEqual(value);
    }
    expect(loaded.fromFile).toContain("sidebar.show");
    expect(loaded.fromFile).toContain("system.telemetry");
  });

  it("drops the three notice settings with their reason", async () => {
    writeV5({ maintainerAnnouncements: { enabled: false, home: false, homeFrequency: "always" } });

    const conversion = await convertV5();

    expect(conversion?.dropped).toEqual([
      { key: "maintainerAnnouncements.enabled", reason: "notices have no settings in v6" },
      { key: "maintainerAnnouncements.home", reason: "notices have no settings in v6" },
      { key: "maintainerAnnouncements.homeFrequency", reason: "notices have no settings in v6" },
    ]);
    expect(conversion?.converted).toEqual([]);
    expect(conversion?.values).toEqual({});
  });

  it("names toast.layout when it drops the v5 toast style", async () => {
    writeV5({ toastStyle: "classic" });

    const conversion = await convertV5();

    expect(conversion?.dropped).toEqual([
      {
        key: "toastStyle",
        reason: 'toasts use the grouped layout; `toast.layout: "detailed"` is the 5.x look',
      },
    ]);
  });

  it("lists values v5 rejected too and converts the rest", async () => {
    writeV5({ percentDisplayMode: "most", enabledProviders: ["copilot", "nope"] });

    const conversion = await convertV5();

    expect(conversion?.invalid.map((item) => item.key)).toEqual([
      "percentDisplayMode",
      "enabledProviders",
    ]);
    expect(conversion?.settings.words.percent).toBe("left");
    expect(conversion?.settings.providers.off).toEqual(
      PROVIDER_IDS.filter((id) => id !== "copilot"),
    );
  });
});

describe("convertV5, which v5 files", () => {
  it("writes all settings into settings.jsonc once, with mode 0600", async () => {
    const old = writeV5({ percentDisplayMode: "used", enableToast: false });
    const conversion = await convertV5();
    expect(conversion?.sources).toEqual([old]);
    expect((await loadSettings()).settings).toMatchObject({
      words: { percent: "used" },
      toast: { show: false },
    });
    expect(readFileSync(old, "utf8")).toContain('"percentDisplayMode": "used"');
    if (process.platform !== "win32") expect(statSync(settingsPath()).mode & 0o777).toBe(0o600);
    expect(await convertV5()).toBeUndefined();
    expect(
      existsSync(join(root, "state", "opencode", "opencode-quota", "display-import.json")),
    ).toBe(false);
  });

  it("leaves the /tokens_* commands on, as for everyone, and writes nothing without old settings", async () => {
    writeV5({ showOnIdle: false });
    await convertV5();
    expect((await loadSettings()).settings.system.oldCommands).toBe(true);
    expect(readFileSync(settingsPath(), "utf8")).not.toContain("oldCommands is on");

    rmSync(settingsPath());
    rmSync(join(configDir, "opencode-quota", "quota-toast.jsonc"));
    const cacheDir = join(root, "cache");
    vi.stubEnv("XDG_CACHE_HOME", cacheDir);
    mkdirSync(join(cacheDir, "opencode", "quota-provider-state"), { recursive: true });
    expect(await convertV5()).toBeUndefined();
    expect(existsSync(settingsPath())).toBe(false);
  });

  it.each([undefined, "auto"])(
    "converts a missing or auto v5 provider choice to no exclusions: %s",
    async (enabledProviders) => {
      writeV5(enabledProviders === undefined ? {} : { enabledProviders });
      expect((await convertV5())?.settings.providers.off).toEqual([]);
    },
  );

  it("switches off every provider for a v5 list with only unknown ids", async () => {
    writeV5({ enabledProviders: ["unknown-provider"] });
    const conversion = await convertV5();
    expect(conversion?.settings.providers.off).toEqual(PROVIDER_IDS);
    expect(conversion?.invalid.map(({ key }) => key)).toEqual(["enabledProviders"]);
  });

  it("converts the sidecar and names the experimental.quotaToast block v5 ignored", async () => {
    const sidecar = writeV5({ percentDisplayMode: "used" });
    const host = writeHost({ accountingDetail: "detailed" }, "opencode.jsonc");

    const conversion = await convertV5();

    expect(conversion?.sources).toEqual([sidecar]);
    expect(conversion?.settings.words).toMatchObject({ percent: "used", detail: "summary" });
    expect(conversion?.notes).toEqual([
      `experimental.quotaToast in ${host} was not converted: v5 ignored it while ${sidecar} exists`,
    ]);
  });

  it("without a sidecar reads opencode.json then opencode.jsonc; a bad later value never wins", async () => {
    const fake = [quotaProvider({ apiKey: "sk-fake" })];
    const json = { percentDisplayMode: "used", quotaProviders: VALID_QUOTA_PROVIDER_INPUTS };
    // v5 took no null, so these never erase the amounts from opencode.json.
    const amounts = {
      cursorIncludedApiUsd: 25,
      cursorBillingCycleStartDay: 3,
      opencodeMonthlyLimit: 20,
    };
    const nulls = {
      cursorIncludedApiUsd: null,
      cursorBillingCycleStartDay: null,
      opencodeMonthlyLimit: null,
    };
    writeHost({ ...json, ...amounts, minIntervalMs: 60_000 }, "opencode.json");
    writeHost(
      { percentDisplayMode: "?", minIntervalMs: 120_000, quotaProviders: fake, ...nulls },
      "opencode.jsonc",
    );

    const conversion = await convertV5();

    expect(conversion?.written).toBe(true);
    expect(conversion?.sources).toHaveLength(2);
    expect(conversion?.settings.words.percent).toBe("used");
    expect(conversion?.settings.providers.checking.minIntervalMs).toBe(120_000);
    expect(conversion?.settings.providers.custom).toEqual(VALID_QUOTA_PROVIDERS);
    expect(conversion?.settings.providers.cursor).toMatchObject({
      includedApiUsd: 25,
      billingCycleStartDay: 3,
    });
    expect(conversion?.settings.providers.opencode.monthlyLimitUsd).toBe(20);
    expect(conversion?.invalid.map((item) => item.key)).toEqual([
      "percentDisplayMode",
      "quotaProviders[0]",
      ...Object.keys(nulls),
    ]);
    expect(readFileSync(settingsPath(), "utf8")).not.toContain("sk-fake");
  });

  it("converts quota-toast.jsonc when both sidecars exist and names the other", async () => {
    const jsonc = writeV5('// comment\n{ "accountingDetail": "detailed", }', "quota-toast.jsonc");
    const json = writeV5({ accountingDetail: "summary" }, "quota-toast.json");

    const conversion = await convertV5();

    expect(conversion?.settings.words.detail).toBe("detailed");
    expect(conversion?.notes).toEqual([
      `${json} was not converted: v5 used ${jsonc} when both exist`,
    ]);
  });

  it("converts a malformed old setup in memory only, from what parses", async () => {
    writeV5("{ broken");
    writeHost({ percentDisplayMode: "used" });

    const conversion = await convertV5();
    const loaded = await loadSettings();

    expect(conversion?.written).toBe(false);
    expect(conversion?.notWrittenReason).toMatch(/does not parse/);
    expect(existsSync(settingsPath())).toBe(false);
    expect(loaded.exists).toBe(false);
    expect(loaded.settings.words.percent).toBe("used");
    expect(loaded.conversion?.sources).toHaveLength(1);
  });

  it("on the first save converts what parses and reports the file that does not", async () => {
    const broken = writeV5("{ broken");
    writeHost({ percentDisplayMode: "used", enableToast: false });

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result).toEqual({
      ok: true,
      issues: [
        {
          key: "$conversion",
          message: `${broken} does not parse as a JSON object, so it was not converted`,
        },
      ],
      diff: [{ key: "words.reset", before: "smart", after: "short" }],
    });
    expect((await loadSettings()).settings.words).toMatchObject({
      percent: "used",
      reset: "short",
    });
    expect((await loadSettings()).settings.toast.show).toBe(false);
  });

  it("on the first save reports an old file that does not parse, even with nothing to convert", async () => {
    const host = writeFile(join(configDir, "opencode.json"), "{ broken");

    const result = await saveSettings({ words: { reset: "short" } });

    expect(result).toMatchObject({ ok: true, diff: [{ key: "words.reset", after: "short" }] });
    expect(result.issues).toEqual([
      {
        key: "$conversion",
        message: `${host} does not parse, so its experimental.quotaToast was not converted`,
      },
    ]);
    expect(readFileSync(settingsPath(), "utf8")).toMatch(
      /^\/\/ OpenCode Quota settings, by section\./,
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "in a read-only folder writes nothing, says why, and still uses the values",
    async () => {
      writeV5({ percentDisplayMode: "used" });
      const folder = join(configDir, "opencode-quota");
      chmodSync(folder, 0o500);
      try {
        const conversion = await convertV5();
        const loaded = await loadSettings();

        expect(conversion?.written).toBe(false);
        expect(conversion?.notWrittenReason).toMatch(/^could not write /);
        expect(loaded.settings.words.percent).toBe("used");
      } finally {
        chmodSync(folder, 0o700);
      }
    },
  );

  it("once settings.jsonc exists, reads no v5 file and names the old sidecar", async () => {
    const old = writeV5({ percentDisplayMode: "used" });
    writeFile(settingsPath(), '{ "version": 6 }');

    expect(await convertV5()).toBeUndefined();
    const loaded = await loadSettings();

    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.notRead).toEqual([old]);
  });

  it("never reads project-scope v5 files and names them", async () => {
    const project = join(root, "project");
    const sidecar = writeV5({ percentDisplayMode: "used" }, "quota-toast.json", project);
    const host = writeHost({ accountingDetail: "detailed" }, "opencode.jsonc", project);

    expect(await convertV5()).toBeUndefined();
    const loaded = await loadSettings({ projectDir: project });

    expect(loaded.settings).toEqual(defaultSettings());
    expect(loaded.notRead).toEqual([sidecar, `${host} (experimental.quotaToast)`]);
  });
});

describe("convertV5, the older folders v4 read", () => {
  /** OpenCode's global folder, then the older ones, for this platform. */
  let folders: string[];

  beforeEach(() => {
    const home = join(root, "home");
    vi.stubEnv("OPENCODE_CONFIG_DIR", "");
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("APPDATA", join(home, "AppData", "Roaming"));
    vi.stubEnv("LOCALAPPDATA", join(home, "AppData", "Local"));
    folders = oldSettingsFolders(getOpencodeRuntimeDirs().configDir);
  });

  it("lists them per platform after the global folder; OPENCODE_CONFIG_DIR replaces them", () => {
    const home = "/h";
    const dotConfig = join(home, ".config", "opencode");
    const at = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}, configDir = "/cfg") =>
      oldSettingsFolders(configDir, { platform, env, homeDir: home });
    expect(at("darwin")).toEqual([
      "/cfg",
      dotConfig,
      join(home, "Library", "Application Support", "opencode"),
    ]);
    expect(at("linux")).toEqual(["/cfg", dotConfig]);
    expect(at("linux", {}, dotConfig)).toEqual([dotConfig]);
    expect(at("win32", { APPDATA: "/roaming", LOCALAPPDATA: "/local" })).toEqual([
      "/cfg",
      join("/roaming", "opencode"),
      join("/local", "opencode"),
    ]);
    expect(at("win32")).toEqual([
      "/cfg",
      join(home, "AppData", "Roaming", "opencode"),
      join(home, "AppData", "Local", "opencode"),
    ]);
    expect(at("darwin", { OPENCODE_CONFIG_DIR: "/cfg" })).toEqual(["/cfg"]);
  });

  it("converts the first older folder with old settings when the global folder has none", async () => {
    const older = folders[1] as string;
    const host = writeHost({ showOnIdle: true, showOnQuestion: false }, "opencode.json", older);

    const conversion = await convertV5();

    expect(conversion).toMatchObject({
      written: true,
      sources: [`${host} (experimental.quotaToast)`],
      notes: [],
    });
    expect((await loadSettings()).settings.toast).toMatchObject({
      afterReply: "always",
      afterQuestion: false,
    });
  });

  it("does not list an older folder's OpenCode config as a project file when OpenCode runs there", async () => {
    const older = folders[1] as string;
    writeHost({ showOnIdle: true }, "opencode.json", older);
    writeHost({ showOnQuestion: false }, "opencode.jsonc", older);

    const loaded = await loadSettings({ projectDir: older });

    expect(loaded.settings.toast.afterReply).toBe("always");
    expect(loaded.notRead).toEqual([]);
  });

  it("converts an older folder's settings when the global folder's OpenCode config does not parse", async () => {
    const broken = writeFile(join(folders[0] as string, "opencode.json"), "{ broken");
    const sidecar = writeV5({ showOnIdle: true }, "quota-toast.jsonc", folders[1]);

    const conversion = await convertV5();

    expect(conversion).toMatchObject({
      written: true,
      sources: [sidecar],
      notes: [`${broken} does not parse, so its experimental.quotaToast was not converted`],
    });
    expect((await loadSettings()).settings.toast.afterReply).toBe("always");
  });

  it("converts the global folder first and names an older folder with settings too", async () => {
    const older = folders[1] as string;
    writeV5({ showOnIdle: false }, "quota-toast.jsonc", folders[0]);
    const olderSidecar = writeV5({ showOnIdle: true }, "quota-toast.jsonc", older);

    const conversion = await convertV5();

    expect(conversion?.notes).toEqual([
      `the old settings in ${older} were not converted: ${folders[0]} has some too`,
    ]);
    const loaded = await loadSettings();
    expect(loaded.settings.toast.afterReply).toBe("off");
    expect(loaded.notRead).toContain(olderSidecar);
  });
});
