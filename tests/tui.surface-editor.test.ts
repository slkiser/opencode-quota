import { describe, expect, it } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { defaultDisplaySettings, setIn } from "../src/tui/display.js";
import { dropIndex, type SettingsEdit, surfaceEditor } from "../src/tui/window/surface-editor.js";
import type { Surface } from "../src/view/select.js";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const SETTINGS = defaultDisplaySettings();

function snapshot(providers: QuotaSnapshot["providers"]): QuotaSnapshot {
  return { version: 6, providers, resetNotices: [], generatedAtMs: NOW };
}

/** Providers a, b and c with one-letter rows, for moves. */
const TREE = snapshot(
  ["a.x a.y", "b.z", "c.u c.v c.w"].map((ids) => {
    const rows = ids.split(" ").map((id) => quotaRow(id));
    return providerSnapshot(rows[0]?.providerId ?? "", "", rows);
  }),
);

/** The tree's line ids after `edit`, top to bottom. */
function idsAfter(edit: SettingsEdit, surface: Surface = "sidebar"): string {
  const lines = surfaceEditor(surface, TREE).lines(edit(SETTINGS), NOW);
  return lines.map((line) => line.id).join(" ");
}

describe("the Settings tree's moves and drags", () => {
  it.each([
    { name: "same heights, down one", from: 0, heights: [1, 1, 1], pointer: 1, expected: 1 },
    { name: "same heights, to the end", from: 0, heights: [1, 1, 1], pointer: 9, expected: 2 },
    { name: "same heights, up to the top", from: 2, heights: [1, 1, 1], pointer: -3, expected: 0 },
    { name: "a tall block, inside itself", from: 0, heights: [3, 1], pointer: 2, expected: 0 },
    { name: "a tall block, onto the next one", from: 0, heights: [3, 1], pointer: 3, expected: 1 },
    // Moved down, the tall block now starts at line 1: line 2 is still inside it, so it stays.
    { name: "a tall block, no flip back", from: 1, heights: [1, 3], pointer: 2, expected: 1 },
    { name: "a short block, inside a tall one", from: 1, heights: [3, 1], pointer: 1, expected: 1 },
    { name: "a short block, at a tall top", from: 1, heights: [3, 1], pointer: 0, expected: 0 },
    { name: "a short block, past a tall one", from: 0, heights: [1, 3], pointer: 2, expected: 0 },
    { name: "a short block, at its end", from: 0, heights: [1, 3], pointer: 3, expected: 1 },
  ])("drops $name", ({ from, heights, pointer, expected }) => {
    expect(dropIndex(from, heights, pointer)).toBe(expected);
  });

  const sidebar = surfaceEditor("sidebar", TREE);
  // Lines: a 0, a.x 1, a.y 2, b 3, b.z 4, c 5, c.u 6, c.v 7, c.w 8.
  it.each([
    { name: "a provider with its rows", edit: sidebar.move("a", 1), ids: "b b.z a a.x a.y c" },
    { name: "a row only inside its provider", edit: sidebar.move("c.u", 5), ids: "c c.v c.w c.u" },
    { name: "a block onto c's last line", edit: sidebar.drag("a", 8), ids: "b b.z c c.u c.v" },
    { name: "a first provider's row down one", edit: sidebar.drag("a.x", 2), ids: "a a.y a.x b" },
    { name: "a row above its provider", edit: sidebar.drag("c.w", 0), ids: "c c.w c.u c.v" },
    { name: "a row onto its middle one", edit: sidebar.drag("c.w", 7), ids: "c c.u c.w c.v" },
    { name: "a row far below", edit: sidebar.drag("c.w", 99), ids: "c c.u c.v c.w" },
  ])("moves $name", ({ edit, ids }) => {
    expect(idsAfter(edit)).toContain(ids);
  });

  it("drags one-line blocks on Collapsed, and leaves the settings alone at an end", () => {
    expect(idsAfter(surfaceEditor("collapsed", TREE).drag("c", 0), "collapsed")).toBe("c a b");
    expect(sidebar.move("a", -1)(SETTINGS)).toBe(SETTINGS);
  });
});

describe("the Settings tree's lines and edits", () => {
  /** Claude: 5h at 30% resetting in 2h 30m, weekly at 60%, an extra row; Copilot: one window. */
  const QUOTA = snapshot([
    providerSnapshot("claude", "Claude", [
      quotaRow("claude.5h", {
        window: "five_hour",
        percentRemaining: 30,
        resetsAt: new Date(NOW + 150 * 60_000).toISOString(),
      }),
      quotaRow("claude.7d", { label: "Weekly", window: "week", percentRemaining: 60 }),
      quotaRow("claude.extra", { prominence: "supplementary", percentRemaining: 90 }),
    ]),
    providerSnapshot("copilot", "Copilot", [
      quotaRow("copilot.plan", { window: "month", percentRemaining: 80 }),
    ]),
    providerSnapshot("openrouter", "OpenRouter", [], { error: { code: "login_expired" } }),
  ]);
  const set = (keys: string, value: unknown) => setIn(SETTINGS, keys.split("."), value);
  /** Each line as text: tick, name, ‹ window › and detail; ~ marks a muted line. */
  const linesOn = (surface: Surface, settings = SETTINGS) =>
    surfaceEditor(surface, QUOTA)
      .lines(settings, NOW)
      .map(
        (line) =>
          `${line.muted ? "~" : ""}${line.hidden ? "[ ]" : "[x]"} ${line.label}` +
          `${line.window ? ` ‹${line.window}›` : ""} · ${line.detail}`,
      );

  it("shows each row's name and numbers on Sidebar, or why it shows none", () => {
    const renamed = setIn(SETTINGS, ["sidebar", "names", "claude.5h"], "Session");
    expect(
      linesOn("sidebar", setIn(renamed, ["sidebar", "hidden"], ["claude.7d", "copilot"])),
    ).toEqual([
      "[x] Claude · ",
      '[x] Session · was "5h"',
      "~[ ] Weekly · 60% left",
      "[x] extra · only with all rows",
      "~[ ] Copilot · ",
      "~[x] plan · 80% left",
      "[x] OpenRouter · Sign in again",
    ]);
    expect(linesOn("toast", set("toast.show", false))[1]).toBe("~[x] 5h · 30% left · 2h 30m");
  });

  it.each([
    { windows: {}, claude: "[x] Claude ‹lowest› · 30% left · 2h 30m" },
    { windows: { "*": "week" }, claude: "[x] Claude ‹week› · 60% left" },
    // Claude has no monthly row, so it shows its lowest.
    { windows: { "*": "month" }, claude: "[x] Claude ‹lowest› · 30% left · 2h 30m" },
    {
      windows: { "*": "week", claude: "lowest" },
      claude: "[x] Claude ‹lowest› · 30% left · 2h 30m",
    },
  ])("shows the window Status line picks with $windows", ({ windows, claude }) => {
    // Copilot has one window, so it has no ‹ ›.
    expect(linesOn("statusLine", set("statusLine.window", windows)).slice(0, 2)).toEqual([
      claude,
      "[x] Copilot · 80% left",
    ]);
  });

  it("leaves rows hidden on Collapsed out of the ‹ › and the summary", () => {
    const collapsed = surfaceEditor(
      "collapsed",
      snapshot([
        providerSnapshot("openai", "OpenAI", [
          quotaRow("openai.5h", { window: "five_hour", percentRemaining: 65 }),
          quotaRow("openai.7d", { window: "week", percentRemaining: 26 }),
          quotaRow("openai.30d", { window: "month", percentRemaining: 12 }),
        ]),
      ]),
    );
    let settings = set("collapsed.hidden", ["openai.30d"]);
    // The summary is the lowest row Collapsed shows, not the hidden 12% one.
    expect(collapsed.lines(settings, NOW)[0]).toMatchObject({
      window: "lowest",
      detail: "26% left",
    });
    // ‹ › steps through 5h and 7d only, then back to no pick of its own.
    const picks = [1, 2, 3].map(() => {
      settings = collapsed.cycleWindow("openai", 1)(settings);
      return settings.collapsed.window.openai;
    });
    expect(picks).toEqual(["five_hour", "week", undefined]);
    // With one window left there is nothing to step through.
    const one = set("collapsed.hidden", ["openai.30d", "openai.5h"]);
    expect(collapsed.cycleWindow("openai", 1)(one)).toBe(one);
  });

  it("steps a provider's window through its own, then back to no pick of its own", () => {
    const next = surfaceEditor("collapsed", QUOTA).cycleWindow("claude", 1);
    let settings = set("collapsed.window", { "*": "five_hour" });
    const picks = [1, 2, 3].map(() => {
      settings = next(settings);
      return settings.collapsed.window.claude;
    });
    expect(picks).toEqual(["week", "lowest", undefined]);
    // Status line keeps picks of its own.
    const statusLine = surfaceEditor("statusLine", QUOTA).cycleWindow("claude", -1)(SETTINGS);
    expect([statusLine.statusLine.window, statusLine.collapsed.window]).toEqual([
      { claude: "week" },
      {},
    ]);
  });

  it.each<Surface>(["sidebar", "toast"])("steps no window on %s, which shows no ‹ ›", (page) => {
    expect(surfaceEditor(page, QUOTA).cycleWindow("claude", 1)(SETTINGS)).toBe(SETTINGS);
  });

  it("ticks, switches and renames on its own page's settings", () => {
    const toast = surfaceEditor("toast", QUOTA);
    const hidden = toast.toggleHidden("copilot")(SETTINGS);
    expect([hidden.toast.hidden, toast.toggleHidden("copilot")(hidden).toast.hidden]).toEqual([
      ["copilot"],
      [],
    ]);
    expect(toast.toggleSurface()(SETTINGS).toast.show).toBe(!SETTINGS.toast.show);
    const rename = toast.rename("claude.7d");
    expect(rename?.hint).toBe(
      'Type a new name, then enter · enter with nothing typed = its own name ("Weekly") · esc stop',
    );
    expect(rename?.apply(" Mine ")(SETTINGS).toast.names).toEqual({ "claude.7d": "Mine" });
    // Only a row takes a name, and only on a page that lists rows.
    const collapsed = surfaceEditor("collapsed", QUOTA);
    expect([toast.rename("claude"), collapsed.rename("claude.7d")]).toEqual([undefined, undefined]);
  });
});
