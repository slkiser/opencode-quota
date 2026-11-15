import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { GuiQuota } from "../src/gui/bridge.js";
import { createNote, createPluginChecks, createSave } from "../src/gui/settings-page-state.js";

const DOWN = { type: "rpc.error", message: "server down" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe("the Plugin section's checks", () => {
  it("stops loading the notices when they fail, with the reason", async () => {
    const checks = createPluginChecks({ notices: async () => Promise.reject(DOWN) } as never);
    await checks.loadNotices();
    expect(checks.notices()).toEqual({ state: "failed", message: "server down" });
  });

  it("stops running the setup check when it fails, with the reason", async () => {
    const checks = createPluginChecks({ status: async () => Promise.reject(DOWN) } as never);
    checks.checkStatus("s1");
    await settle();
    expect(checks.status()).toEqual({ state: "failed", message: "server down" });
  });

  it("drops a late setup check for the session shown before", async () => {
    const answers: Record<string, (text: string) => void> = {};
    const status = (sessionID: string) =>
      new Promise<string>((resolve) => {
        answers[sessionID] = resolve;
      });
    const checks = createPluginChecks({ status } as unknown as GuiQuota);
    const stop = checks.checkStatus("s1");
    stop();
    checks.checkStatus("s2");
    answers.s1?.("first");
    await settle();
    expect(checks.status()).toEqual({ state: "loading" });
  });
});

describe("the Save and Copy notes", () => {
  it("shows Saved its full time after a second save", async () => {
    vi.useFakeTimers();
    const save = createSave(async () => {});
    await save.save();
    vi.advanceTimersByTime(2_000);
    await save.save();
    vi.advanceTimersByTime(2_000);
    expect(save.state()).toEqual({ state: "saved" });
  });

  it("shows Copied its full time after a second copy", () => {
    vi.useFakeTimers();
    const note = createNote(2_000);
    note.show();
    vi.advanceTimersByTime(1_500);
    note.show();
    vi.advanceTimersByTime(1_000);
    expect(note.shown()).toBe(true);
  });

  it("leaves no timer running once the page closes", async () => {
    vi.useFakeTimers();
    const save = createSave(async () => {});
    const note = createNote(2_000);
    await save.save();
    note.show();
    save.stop();
    note.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no timer for a Save or Copy that ends after the page closed", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<void>();
    const save = createSave(() => pending.promise);
    const note = createNote(2_000);
    const saving = save.save();
    save.stop();
    note.stop();
    pending.resolve();
    await saving;
    note.show();
    expect(vi.getTimerCount()).toBe(0);
  });
});
