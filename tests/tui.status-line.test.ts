/**
 * The status line under the message box and at the bottom of Home. JSX here builds plain
 * `{ type, props }` nodes and never calls a component, so a test reads what StatusLine and
 * HomeFooter ask Solid to show.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QuotaSnapshot } from "../src/core/types.js";
import { convertV5 } from "../src/settings/index.js";
import { defaultSettings } from "../src/settings/schema.js";
import type { SurfaceHost } from "../src/tui/sidebar.js";
import {
  type StatusLayout,
  statusLayout,
  statusLineInput,
  statusLineWidth,
} from "../src/view/text.js";
import { providerSnapshot, quotaRow } from "./helpers/fake-answers.js";
import { stubJsx } from "./helpers/fake-tui-host.js";
import { findAll, type Node, textLines, THEME } from "./helpers/jsx-tree.js";

const TERMINAL_WIDTH = 110;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quota-tui-status-line-"));
  vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
  stubJsx({ components: "keep" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe("HomeFooter", () => {
  it("shows the status line on Home for a v5 config that showed it only on Home", async () => {
    const v5 = join(root, "config", "opencode-quota", "quota-toast.jsonc");
    mkdirSync(join(root, "config", "opencode-quota"), { recursive: true });
    writeFileSync(
      v5,
      JSON.stringify({
        tuiCompactStatus: { enabled: true, sessionPrompt: false, homeBottom: true },
      }),
    );
    const conversion = await convertV5();
    const display = () => conversion!.settings;
    expect(display().statusLine.show).toBe(false);

    const { HomeFooter, StatusLine } = await import("../src/tui/status-line.tsx");
    const host = {
      theme: () => ({ text: { muted: "muted" } }),
      display,
      quota: { homeLine: () => "", watchHome: () => () => {} },
    } as unknown as SurfaceHost;
    const footer = HomeFooter({ host });

    // Every <Show> around the status line: the footer's own, then the status line's.
    const shows = findAll(
      footer,
      (node) =>
        "when" in node.props &&
        findAll(node.props.children, (child) => child.type === StatusLine).length > 0,
    );
    expect(shows.map((node) => node.props.when)).toEqual([true, true]);
  });
});

describe("statusLineShows", () => {
  it.each([
    { name: "with no sidebar panel on screen", shows: true },
    { name: "never while it is off", change: { show: false }, shows: false },
    { name: "not next to a sidebar panel", sidebar: true, shows: false },
    {
      name: "next to a panel with withSidebar",
      sidebar: true,
      change: { withSidebar: true },
      shows: true,
    },
    { name: "next to a panel while its tab is open", sidebar: true, tab: true, shows: true },
    { name: "next to a panel whose quota is off", sidebar: true, sidebarShow: false, shows: true },
  ])(
    "shows the session status line $name",
    async ({ change, sidebar, tab, sidebarShow, shows }) => {
      const { statusLineShows } = await import("../src/tui/status-line.tsx");
      const settings = defaultSettings();
      Object.assign(settings.statusLine, change);
      settings.sidebar.show = sidebarShow ?? true;
      const host = {
        display: () => settings,
        editing: {
          sidebarOnScreen: () => sidebar === true,
          tabOpen: (surface: string) => tab === true && surface === "statusLine",
        },
      } as unknown as SurfaceHost;
      expect(statusLineShows(host)).toBe(shows);
    },
  );
});

describe("statusLineBasis", () => {
  it.each([
    {
      name: "all it wants when that is under a third of the row",
      wanted: 20,
      row: 106,
      max: 0,
      basis: 20,
    },
    { name: "a third of the row at most", wanted: 120, row: 106, max: 0, basis: 35 },
    { name: "no more than the width setting", wanted: 120, row: 106, max: 12, basis: 12 },
    { name: "nothing in a row not measured yet", wanted: 120, row: 0, max: 0, basis: 0 },
  ])("asks for $name", async ({ wanted, row, max, basis }) => {
    const { statusLineBasis } = await import("../src/tui/status-line.tsx");
    expect(statusLineBasis(wanted, row, max)).toBe(basis);
  });
});

describe("StatusLine", () => {
  const NOW = Date.now();
  // Seven providers: their narrowest line is wider than a third of the footer row.
  const SNAPSHOT: QuotaSnapshot = {
    version: 6,
    providers: ["anthropic", "openai", "copilot", "zai", "kimi", "minimax", "xai"].map((id) =>
      providerSnapshot(
        id,
        `Provider ${id}`,
        [quotaRow(`${id}.week`, { label: "Weekly", window: "week", percentRemaining: 50 })],
        { okAtMs: NOW, checkedAtMs: NOW },
      ),
    ),
    resetNotices: [],
    generatedAtMs: NOW,
    serverId: "server",
    revision: 1,
  };

  async function render() {
    const settings = defaultSettings();
    const { StatusLine } = await import("../src/tui/status-line.tsx");
    const host = {
      theme: () => THEME,
      display: () => settings,
      editing: { marked: () => undefined },
      quota: { watch: () => () => {}, snapshot: () => SNAPSHOT },
    } as unknown as SurfaceHost;
    const box = StatusLine({
      host,
      sessionID: "ses_1",
      terminalWidth: () => TERMINAL_WIDTH,
    }) as unknown as Node;
    return { box, input: statusLineInput(SNAPSHOT, settings, NOW) };
  }

  it("asks the footer for room, so a long folder name cannot keep all of it", async () => {
    const { box, input } = await render();
    expect(statusLineWidth(input, "numbers")).toBeGreaterThan(TERMINAL_WIDTH / 3);
    // Until OpenCode measures the row: a third of the terminal's width.
    expect(box.props.flexBasis).toBe(Math.floor(TERMINAL_WIDTH / 3));
  });

  it("shows the +N marker when no provider fits", async () => {
    const { box, input } = await render();
    const layout = statusLayout(input, 2, 0, "auto");
    expect(layout.shown).toEqual([]);
    // The box holds the big bar's <Show>, then the <Show> of the layout.
    const [, layoutShow] = box.props.children as Node[];
    const lines = (layoutShow!.props.children as (current: () => StatusLayout) => unknown)(
      () => layout,
    );
    // Each marker is a <Show> of its text; draw the ones that show.
    const markers = findAll(
      lines,
      (node) =>
        typeof node.props.when === "string" &&
        node.props.when !== "" &&
        typeof node.props.children === "function",
    ).map((node) => node.props.children(() => node.props.when));
    expect(textLines(markers)).toEqual(["+7 ›"]);
  });
});
