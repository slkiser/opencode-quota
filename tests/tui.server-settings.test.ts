import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import type { QuotaRpcSaveSettingsInput, QuotaRpcSettingsOutput } from "../src/rpc.js";
import { checkSetting } from "../src/settings/index.js";
import { CHANGED_SINCE_REVIEW } from "../src/settings/schema.js";
import type { QuotaClient } from "../src/tui/client.js";
import {
  createFileDisplay,
  FIELDS,
  type Field,
  presetChoice,
  presetValues,
  typedNumber,
} from "../src/tui/display.js";
import {
  createServerSettings,
  isTicked,
  settingsPatch,
  withTick,
} from "../src/tui/server-settings.js";
import { SidebarPanel } from "../src/tui/sidebar.tsx";
import { DEFAULT_WORDS } from "../src/view/format.js";
import { stubJsx } from "./helpers/fake-tui-host.js";
import { textLines, THEME } from "./helpers/jsx-tree.js";

const field = (path: string) => FIELDS.find((item) => item.path === path) as Field;

describe("the Settings tabs' lines", () => {
  it("derives each field's page from its first key, the words lines on All places, and excludes System lines", () => {
    for (const item of FIELDS) {
      const page = item.path.startsWith("words.") ? "layout" : item.path.split(".")[0];
      expect([item.path, item.tab]).toEqual([item.path, page]);
      expect(item.path).not.toMatch(/^system\./);
    }
    expect(FIELDS.map((item) => item.path)).not.toContain("words.runsOut");
    expect(FIELDS.map((item) => item.path)).not.toContain("quickLook");
  });

  it.each([
    { key: "providers.cursor.includedApiUsd", text: "$25", value: 25 },
    { key: "providers.cursor.includedApiUsd", text: " ", value: null },
    { key: "providers.cursor.includedApiUsd", text: "-3", value: undefined },
    { key: "providers.cursor.includedApiUsd", text: "lots", value: undefined },
    { key: "providers.cursor.billingCycleStartDay", text: "28", value: 28 },
    { key: "providers.cursor.billingCycleStartDay", text: "29", value: undefined },
    { key: "providers.cursor.billingCycleStartDay", text: "1.5", value: undefined },
    { key: "providers.opencode.monthlyLimitUsd", text: "40.5", value: 40.5 },
  ])("reads $text typed into $key as $value", ({ key, text, value }) => {
    const parsed = typedNumber(field(key), text);
    expect(parsed).toBe(value);
    if (parsed !== undefined) expect(checkSetting(key, parsed).issues).toEqual([]);
  });

  it("shows each value in words", () => {
    expect(field("words.percent").values.map(field("words.percent").show)).toEqual([
      "58% left",
      "58% remaining",
      "58%",
      "42% used",
    ]);
    expect(field("words.reset").show("compact")).toBe("2h14m · 5d3h20m");
    expect(field("words.rowNames").values.map(field("words.rowNames").show)).toEqual([
      "5h, 7d, 30d",
      "Weekly, Daily, …",
    ]);
    expect(field("providers.checking.minIntervalMs").show(300_000)).toBe("every 5 min");
    expect(field("providers.cursor.includedApiUsd").show(null)).toBe("from the plan");
    // Each Cursor plan says the API use it includes, as the Cursor provider counts it.
    expect(field("providers.cursor.plan").values.map(field("providers.cursor.plan").show)).toEqual([
      "not set",
      "Pro: $20 a month",
      "Pro Plus: $70 a month",
      "Ultra: $400 a month",
    ]);
    expect(field("providers.opencode.monthlyLimitUsd").show(null)).toBe("from the Console");
  });

  it.each([
    {
      values: { "words.percent": "bare", "words.reset": "compact", "words.rowNames": "short" },
      choice: "short",
      next: "spelled out",
    },
    {
      values: { "words.percent": "remaining", "words.reset": "exact", "words.rowNames": "full" },
      choice: "spelled out",
      next: "normal",
    },
    {
      // Spelled-out words with short row names are your own choice.
      values: { "words.percent": "remaining", "words.reset": "exact", "words.rowNames": "short" },
      choice: undefined,
      next: "normal",
    },
    {
      values: { "words.percent": "used", "words.reset": "exact", "words.rowNames": "short" },
      choice: undefined,
      next: "normal",
    },
  ])("matches the Wording choice $choice and steps to $next", ({ values, choice, next }) => {
    const value = (key: string) => values[key as keyof typeof values];
    expect(presetChoice("words", value)).toBe(choice);
    const stepped = presetValues("words", choice, 1);
    expect(presetChoice("words", (key) => stepped[key])).toBe(next);
  });
});

describe("provider ticks", () => {
  it("checks found providers and providers found later unless switched off", () => {
    expect(isTicked([], "copilot")).toBe(true);
    const off = withTick([], "copilot", false);
    expect(off).toEqual(["copilot"]);
    expect(isTicked(off, "copilot")).toBe(false);
    expect(isTicked(off, "cursor")).toBe(true);
    expect(withTick(off, "copilot", true)).toEqual([]);
  });

  it("nests the changes into the patch saveSettings takes", () => {
    expect(
      settingsPatch({
        "words.percent": "used",
        "providers.off": ["copilot"],
        "providers.cursor.includedApiUsd": null,
      }),
    ).toEqual({
      words: { percent: "used" },
      providers: { off: ["copilot"], cursor: { includedApiUsd: null } },
    });
  });
});

describe("the server settings this window edits", () => {
  const SAVED: QuotaRpcSettingsOutput = {
    values: { "words.percent": "left", "providers.off": [] },
    providers: [{ id: "copilot", label: "Copilot" }],
    custom: [{ id: "gw", label: "Gateway", enabled: false, request: null, fingerprint: "fp-a" }],
  };

  /** The server; a save waits for `gate` when set. */
  function fakeRpc(
    answer = { ok: true, issues: [] as Array<{ key: string; message: string }> },
    gate?: Promise<void>,
  ) {
    let saved = structuredClone(SAVED);
    const rpc = {
      settings: vi.fn(async () => structuredClone(saved)),
      saveSettings: vi.fn(async (input: QuotaRpcSaveSettingsInput) => {
        await gate;
        if (!answer.ok) return answer;
        const words = input.patch.words as { percent?: string } | undefined;
        saved = {
          ...saved,
          values: { ...saved.values, "words.percent": words?.percent },
          custom: saved.custom.map((entry) => ({ ...entry, enabled: true })),
        };
        return answer;
      }),
    };
    return rpc;
  }

  it("counts only values that differ from the saved ones, and saves them with the switches", async () => {
    const rpc = fakeRpc();
    const server = createServerSettings(rpc);
    await server.load();

    server.set("words.percent", "used");
    server.set("words.percent", "left");
    expect(server.dirty()).toBe(false);
    server.set("words.percent", "used");
    server.switchCustom("gw", true);
    expect([server.dirty(), server.customOn("gw"), server.value("words.percent")]).toEqual([
      true,
      true,
      "used",
    ]);

    await server.save();

    expect(rpc.saveSettings).toHaveBeenCalledWith({
      patch: { words: { percent: "used" } },
      customEnabled: { gw: { enabled: true, fingerprint: "fp-a" } },
    });
    expect([server.dirty(), server.value("words.percent"), server.customOn("gw")]).toEqual([
      false,
      "used",
      true,
    ]);
  });

  it("keeps the changes and says why when the server refuses them", async () => {
    const rpc = fakeRpc({ ok: false, issues: [{ key: "words.percent", message: "expected …" }] });
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");

    await expect(server.save()).rejects.toThrow("words.percent: expected …");
    expect(server.value("words.percent")).toBe("used");
    server.discard();
    expect([server.dirty(), server.value("words.percent")]).toEqual([false, "left"]);
  });

  it("keeps a change back to the saved value made while Save waits, unsaved", async () => {
    let answer = () => {};
    const rpc = fakeRpc(
      undefined,
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");

    const saving = server.save();
    server.set("words.percent", "left");
    answer();
    await saving;

    expect(server.saved()?.values["words.percent"]).toBe("used");
    expect([server.value("words.percent"), server.dirty()]).toEqual(["left", true]);
  });

  it("reloads and marks a custom provider whose definition changed since the window showed it", async () => {
    const issue = { key: "providers.custom.gw", message: CHANGED_SINCE_REVIEW };
    const rpc = fakeRpc({ ok: false, issues: [issue] });
    const server = createServerSettings(rpc);
    await server.load();
    server.switchCustom("gw", true);
    const now = {
      url: "https://other.example/quota",
      key: "environment variable OTHER",
      insecure: false,
    };
    rpc.settings.mockResolvedValue({
      ...SAVED,
      custom: [{ id: "gw", label: "Gateway", enabled: false, request: now, fingerprint: "fp-b" }],
    });

    await expect(server.save()).rejects.toThrow(CHANGED_SINCE_REVIEW);

    expect(rpc.saveSettings).toHaveBeenCalledWith({
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "fp-a" } },
    });
    expect(server.saved()?.custom[0]?.request).toEqual(now);
    expect([server.customOn("gw"), server.changedSinceReview("gw"), server.dirty()]).toEqual([
      false,
      true,
      false,
    ]);
    // Switching it on again, after looking at the new details, sends their fingerprint.
    server.switchCustom("gw", true);
    expect(server.changedSinceReview("gw")).toBe(false);
    await expect(server.save()).rejects.toThrow();
    expect(rpc.saveSettings).toHaveBeenLastCalledWith({
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "fp-b" } },
    });
  });
  it("sends the definition fingerprint reviewed at the switch, even after a live update", async () => {
    const rpc = fakeRpc({
      ok: false,
      issues: [{ key: "providers.custom.gw", message: CHANGED_SINCE_REVIEW }],
    });
    const server = createServerSettings(rpc);
    await server.load();
    server.switchCustom("gw", true);
    server.receive({ ...SAVED, custom: [{ ...SAVED.custom[0]!, fingerprint: "fp-b" }] });
    await expect(server.save()).rejects.toThrow(CHANGED_SINCE_REVIEW);
    expect(rpc.saveSettings).toHaveBeenCalledWith({
      patch: {},
      customEnabled: { gw: { enabled: true, fingerprint: "fp-a" } },
    });
  });

  it("shares one Save request when Save is pressed twice", async () => {
    let release = () => {};
    const rpc = fakeRpc(
      undefined,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");
    const first = server.save();
    const second = server.save();
    expect(first).toBe(second);
    server.set("words.percent", "bare");
    release();
    await first;
    expect(rpc.saveSettings).toHaveBeenCalledTimes(1);
    expect([server.value("words.percent"), server.dirty()]).toEqual(["bare", true]);
  });

  it("can retry a transport failure without losing drafts", async () => {
    const rpc = fakeRpc();
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");
    rpc.saveSettings.mockRejectedValueOnce(new Error("disconnected"));
    await expect(server.save()).rejects.toThrow("disconnected");
    server.set("words.percent", "bare");
    await server.save();
    expect([server.value("words.percent"), server.dirty()]).toEqual(["bare", false]);
  });

  it("keeps a custom switch reverted while Save is waiting", async () => {
    let release = () => {};
    const rpc = fakeRpc(
      undefined,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const server = createServerSettings(rpc);
    await server.load();
    server.switchCustom("gw", true);
    const saving = server.save();
    server.switchCustom("gw", false);
    release();
    await saving;
    expect([server.customOn("gw"), server.dirty()]).toEqual([false, true]);
  });

  it("keeps a newer live update when the Save follow-up read answers late", async () => {
    let answer = (_next: QuotaRpcSettingsOutput) => {};
    const rpc = fakeRpc();
    const server = createServerSettings(rpc);
    await server.load();
    server.set("words.percent", "used");
    rpc.settings.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const saving = server.save();
    await vi.waitFor(() => expect(rpc.settings).toHaveBeenCalledTimes(2));
    server.receive({
      ...SAVED,
      values: { ...SAVED.values, "words.percent": "bare", "layout.barWidth": 12 },
    });
    answer({
      ...SAVED,
      values: { ...SAVED.values, "words.percent": "used", "layout.barWidth": 8 },
    });
    await saving;
    expect([
      server.value("words.percent"),
      server.value("layout.barWidth"),
      server.dirty(),
    ]).toEqual(["bare", 12, false]);
  });

  it("rebases a row rename made during Save over another TUI's names", async () => {
    let release = () => {};
    const next: QuotaRpcSettingsOutput = {
      ...SAVED,
      values: { ...SAVED.values, "sidebar.names": { first: "Saved", other: "Other TUI" } },
    };
    const rpc = {
      settings: vi
        .fn()
        .mockResolvedValueOnce({ ...SAVED, values: { ...SAVED.values, "sidebar.names": {} } })
        .mockResolvedValue(next),
      saveSettings: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { ok: true, issues: [] };
      }),
    };
    const server = createServerSettings(rpc);
    await server.load();
    server.set("sidebar.names", { first: "Saved" });
    const saving = server.save();
    server.set("sidebar.names", { first: "Draft" });
    server.receive(next);
    release();
    await saving;
    expect(server.value("sidebar.names")).toEqual({ first: "Draft", other: "Other TUI" });
    expect(server.dirty()).toBe(true);
  });

  describe("words on the surfaces", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    /** The server's last snapshot: it still has the words from before Save. */
    const SNAPSHOT: QuotaSnapshot = {
      version: 6,
      providers: [
        {
          providerId: "copilot",
          label: "Copilot",
          rows: [
            {
              id: "copilot.weekly",
              providerId: "copilot",
              label: "Weekly",
              type: "quota",
              method: "remote_api",
              authority: "provider_reported",
              window: "week",
              prominence: "primary",
              percentRemaining: 80,
            },
          ],
          okAtMs: 0,
          checkedAtMs: 0,
          refreshing: false,
          debug: [],
        },
      ],
      resetNotices: [],
      generatedAtMs: 0,
      serverId: "server",
      revision: 1,
      words: { ...DEFAULT_WORDS, percent: "left" },
    };

    it("keeps showing the saved words between Save and the server's changed event", async () => {
      // The sidebar's minute clock never runs here.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      stubJsx();
      const server = createServerSettings(fakeRpc());
      await server.load();
      const display = createFileDisplay(server).shown;
      // The snapshot carries the unsaved words too, so while editing both places agree; only
      // after Save, before the changed event, do the snapshot's words fall back to the old ones.
      const snapshot = (): QuotaSnapshot =>
        server.dirty() ? { ...SNAPSHOT, words: display().words } : SNAPSHOT;
      const host = {
        theme: () => THEME,
        display,
        quota: { watch: () => () => {}, snapshot } as unknown as QuotaClient,
        editing: {
          marked: () => undefined,
          panelOpen: () => undefined,
          sidebarShown: () => () => {},
          statusLineShown: () => false,
        },
      };
      const sidebar = () =>
        textLines(SidebarPanel({ host, sessionID: "ses_1", open: () => true, setOpen: () => {} }))
          .map((line) => line.replace(/\s+/gu, " ").trim())
          .join(" | ");
      const LEFT = "▼ Quota left | Copilot | 7d ████████████████░░░░ 80%";
      const USED = "▼ Quota used | Copilot | 7d ████████████████░░░░ 20%";

      expect(sidebar()).toBe(LEFT);
      server.set("words.percent", "used");
      expect(sidebar()).toBe(USED);
      await server.save();
      // The draft is gone and no changed event came yet: the saved words show, not the old ones.
      expect(server.dirty()).toBe(false);
      expect(sidebar()).toBe(USED);
    });
  });
});
